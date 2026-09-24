/**
 * /api/schedules/[id] — 개별 스케줄 수정/삭제
 *
 * 권한: id 만으로 대상을 찾으므로 먼저 대상 스케줄의 workspaceId 를 조회한 뒤
 * assertWorkspaceAccess 를 적용한다(prompts/[id] 와 동일한 이유 — 로그인 여부만으로는
 * 워크스페이스 소유 여부를 보장하지 못한다).
 *
 * 입력 검증: 경로 id 는 DB 조회 전에 UUID 형식인지 먼저 확인한다(아니면 400). DB 오류
 * 시에도 상세(SQL 원문 포함 가능)는 서버 로그에만 남기고 응답에는 고정 오류 코드만
 * 반환한다(CWE-209 — prompts/[id] 와 동일한 이유).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, eq, inArray } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { CronExpressionParser } from "cron-parser";

export const dynamic = "force-dynamic";

const UpdateScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cronExpression: z.string().min(3).max(100).optional(),
  providers: z.array(z.string()).optional(),
  promptIds: z.array(z.string().uuid()).optional(),
  geolocation: z.string().nullable().optional(),
  active: z.boolean().optional(),
  lastRunAt: z.string().datetime().nullable().optional(),
  nextRunAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 경로 id 가 UUID 형식이 아니면 DB 를 타지 않고 즉시 거부한다.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    // 1) 대상 조회 — 워크스페이스 권한 확인 + 주기가 "실제로 바뀌었는지" 비교에 필요
    const [target] = await db
      .select({
        id: schema.schedules.id,
        workspaceId: schema.schedules.workspaceId,
        cronExpression: schema.schedules.cronExpression,
      })
      .from(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    const body = await req.json();
    const parsed = UpdateScheduleSchema.parse(body);
    const patch: Partial<typeof schema.schedules.$inferInsert> = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.cronExpression !== undefined) patch.cronExpression = parsed.cronExpression;
    if (parsed.providers !== undefined) patch.providers = parsed.providers;
    if (parsed.promptIds !== undefined) {
      // 존재하지 않는(삭제된) 프롬프트 ID 는 저장 시 정리 — 그 워크스페이스에 실제로
      // 남아있는 ID 만 유지한다. 빈 배열을 명시적으로 보낸 경우는 "활성 프롬프트 전체"
      // 의미이므로 그대로 둔다.
      if (parsed.promptIds.length === 0) {
        patch.promptIds = [];
      } else {
        const existing = await db
          .select({ id: schema.prompts.id })
          .from(schema.prompts)
          .where(
            and(
              eq(schema.prompts.workspaceId, target.workspaceId),
              inArray(schema.prompts.id, parsed.promptIds),
            ),
          );
        const existingIds = new Set(existing.map((p) => p.id));
        const filteredPromptIds = parsed.promptIds.filter((pid) => existingIds.has(pid));
        // 비어 있지 않은 선택을 보냈는데 전부 무효(삭제됨/다른 워크스페이스)면 조용히
        // 빈 배열(= "활성 프롬프트 전체 실행")로 저장하지 않고 거부한다 — 이 시스템은
        // 스케줄마다 주기적으로 외부 유료 조사를 호출하므로, "이 질문들만" 실행하려던
        // 의도가 예고 없이 "전체 실행"으로 조용히 확장되면 안 된다.
        if (filteredPromptIds.length === 0) {
          return NextResponse.json(
            {
              error: "no_valid_prompts_selected",
              hint: "선택한 질문이 모두 삭제되었거나 존재하지 않습니다. 질문을 다시 선택해 주세요.",
            },
            { status: 400 },
          );
        }
        patch.promptIds = filteredPromptIds;
      }
    }
    if (parsed.geolocation !== undefined) patch.geolocation = parsed.geolocation;
    if (parsed.active !== undefined) patch.active = parsed.active;
    if (parsed.lastRunAt !== undefined)
      patch.lastRunAt = parsed.lastRunAt ? new Date(parsed.lastRunAt) : null;
    if (parsed.nextRunAt !== undefined)
      patch.nextRunAt = parsed.nextRunAt ? new Date(parsed.nextRunAt) : null;

    // 주기가 "실제로" 바뀌었고(기존 값과 동일한 값을 다시 보낸 저장은 재계산하지 않음)
    // 호출측이 nextRunAt 을 직접 지정하지 않았다면, 새 주기 기준으로 다음 실행 시각을
    // 다시 계산한다(automation-runner.ts 의 updateScheduleTiming 과 동일 계산 방식 —
    // CronExpressionParser 로 "지금 이후 다음 tick"을 구한다).
    if (
      parsed.cronExpression !== undefined &&
      parsed.cronExpression !== target.cronExpression &&
      parsed.nextRunAt === undefined
    ) {
      try {
        const interval = CronExpressionParser.parse(parsed.cronExpression, {
          currentDate: new Date(),
        });
        patch.nextRunAt = interval.next().toDate();
      } catch (err) {
        return NextResponse.json(
          { error: "invalid_cron_expression", detail: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    const [updated] = await db
      .update(schema.schedules)
      .set(patch)
      .where(eq(schema.schedules.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ schedule: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — drizzle-orm 0.45 는 DB 오류를
    // DrizzleQueryError("Failed query: ...")로 감싸 err.message 에 쿼리 전문이 그대로
    // 담긴다. 서버 로그에만 message + cause(원 postgres 오류)를 남기고, 클라이언트에는
    // 고정 오류 코드만 반환한다.
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/schedules/:id] PATCH 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "schedule_update_failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 경로 id 가 UUID 형식이 아니면 DB 를 타지 않고 즉시 거부한다.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    // prompts/[id] DELETE 와 동일한 이유로 워크스페이스 권한을 함께 확인한다 — PATCH 만
    // 막고 DELETE 를 열어두면 같은 구멍이 삭제 경로로 그대로 남는다.
    const [target] = await db
      .select({ id: schema.schedules.id, workspaceId: schema.schedules.workspaceId })
      .from(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    const [deleted] = await db
      .delete(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — 서버 로그에만 상세를 남기고 클라이언트에는
    // 고정 오류 코드만 반환한다(위 PATCH 와 동일한 이유).
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/schedules/:id] DELETE 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "schedule_delete_failed" }, { status: 500 });
  }
}
