/**
 * /api/prompts/[id] — 개별 프롬프트 수정/삭제
 *
 * PATCH  — text / tags / active 일부 또는 전체 수정. 켜짐·문구가 바뀌어 결과가 켜진 질문이면 그 문구의
 *          보관 응답을 같은 트랜잭션에서 되돌리고 restoredRuns(건수)를 싣는다(응답 보관 §S8).
 * DELETE — 프롬프트 제거. ?cascade=true 면 같은 prompt_text 의 runs 도 함께 삭제 (admin 전용).
 *          연관된 schedules.promptIds 는 UUID 배열이라 cascade 안 됨 — 호출 측이 스케줄 업데이트 필요.
 *
 * 권한: 이 라우트는 id 만으로 대상을 찾으므로, 먼저 대상 프롬프트의 workspaceId 를 조회한
 * 뒤 그 워크스페이스에 대해 assertWorkspaceAccess 를 적용한다 — 그전에는 로그인 여부만
 * (middleware) 확인하고 워크스페이스 소유 여부는 보지 않아, 일반관리자가 자신의 프로덕션
 * 워크스페이스가 아닌 프롬프트도 id 만 알면 수정·삭제할 수 있었다.
 *
 * 입력 검증: 경로 id 는 DB 조회 전에 UUID 형식인지 먼저 확인한다(아니면 400) — 예전에는
 * 형식이 틀린 id 도 그대로 쿼리에 들어가 postgres 캐스팅 오류가 발생했고, 그 오류 문구
 * (SQL 원문 포함)가 500 응답 본문에 그대로 실렸다(CWE-209). DB 오류 시에도 상세는 서버
 * 로그에만 남기고 응답에는 고정 오류 코드만 반환한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess, requireAdmin } from "@/lib/server/auth-guard";
import {
  applyPromptLockTimeout,
  isLockTimeoutError,
  lockResponseArchive,
  restoreByTexts,
} from "@/lib/server/run-archive";

export const dynamic = "force-dynamic";

const UpdatePromptSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  tags: z.array(z.string()).optional(),
  active: z.boolean().optional(),
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
    // 1) 대상 조회 — 워크스페이스 권한 확인에 필요
    const [target] = await db
      .select({ id: schema.prompts.id, workspaceId: schema.prompts.workspaceId })
      .from(schema.prompts)
      .where(eq(schema.prompts.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    const body = await req.json();
    const parsed = UpdatePromptSchema.parse(body);

    // 태그만 바꾸면 질문 목록(켜짐·문구)이 그대로라 보관과 무관하다 — 예전처럼 바로 저장한다.
    if (parsed.active === undefined && parsed.text === undefined) {
      const [updated] = await db
        .update(schema.prompts)
        .set(parsed)
        .where(eq(schema.prompts.id, id))
        .returning();
      if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ prompt: updated, restoredRuns: 0 });
    }

    // 켜짐·문구가 바뀌면 한 트랜잭션: 보관 잠금 → 수정 → 결과가 켜진 질문이면 그 문구(바뀐 문구)의
    // 보관 응답을 되돌린다 — 질문 목록에 있는 질문의 응답은 보관 상태가 아니어야 한다(I1 · 계획
    // geotracker-response-archive-260924 §S8). 잠금은 같은 문구의 보관·영구 삭제와 겹치지 않게 한다.
    const { updated, restoredRuns } = await db.transaction(async (tx) => {
      await applyPromptLockTimeout(tx);
      await lockResponseArchive(tx, target.workspaceId);
      const [row] = await tx
        .update(schema.prompts)
        .set(parsed)
        .where(eq(schema.prompts.id, id))
        .returning();
      if (!row) return { updated: null, restoredRuns: 0 };
      const restored = row.active ? await restoreByTexts(tx, row.workspaceId, [row.text]) : null;
      return { updated: row, restoredRuns: restored?.affectedRuns ?? 0 };
    });
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ prompt: updated, restoredRuns });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    // 워크스페이스 잠금 대기 한도(applyPromptLockTimeout) 초과 — POST /api/workspaces/:id/prompts
    // 와 같은 이유·같은 응답(결함 대장 RV1).
    if (isLockTimeoutError(err)) {
      console.warn("[/api/prompts/:id] PATCH 잠금 대기 한도 초과 — 재시도 유도");
      return NextResponse.json(
        { error: "archive_lock_busy", hint: "다른 정리 작업이 진행 중이에요. 잠시 후 다시 시도해 주세요." },
        { status: 409 },
      );
    }
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — drizzle-orm 0.45 는 DB 오류를
    // DrizzleQueryError("Failed query: ...")로 감싸 err.message 에 쿼리 전문이 그대로
    // 담긴다. 서버 로그에만 message + cause(원 postgres 오류)를 남기고, 클라이언트에는
    // 고정 오류 코드만 반환한다.
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/prompts/:id] PATCH 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "prompt_update_failed" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 경로 id 가 UUID 형식이 아니면 DB 를 타지 않고 즉시 거부한다.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const cascade = req.nextUrl.searchParams.get("cascade") === "true";

  try {
    // 1) prompt 조회 — text 와 workspaceId 가져와 권한 확인 + cascade 시 사용
    const [target] = await db
      .select({
        id: schema.prompts.id,
        text: schema.prompts.text,
        workspaceId: schema.prompts.workspaceId,
      })
      .from(schema.prompts)
      .where(eq(schema.prompts.id, id))
      .limit(1);

    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // 2) 워크스페이스 접근 권한 — 일반관리자는 자신의 프로덕션 워크스페이스만
    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    // 3) cascade 삭제는 그 위에 admin 전용 제약을 더 얹는다 (응답 데이터 일괄 삭제 권한)
    if (cascade) {
      const adminGuard = requireAdmin(session);
      if (adminGuard) return adminGuard;
    }

    // 4) cascade(옵션) + daily_stats 정리 + prompt 삭제를 한 트랜잭션으로 — daily_stats.prompt_id
    //    는 기본키(date, workspace_id, provider, prompt_id)의 일부라 Postgres 가 NOT NULL 을
    //    강제한다. FK 의 ON DELETE SET NULL 이 그 값을 null 로 바꾸려 시도하면 제약 위반으로
    //    프롬프트 삭제 자체가 실패한다(daily rollup 결함 수정 이후 daily_stats 에 실제 행이
    //    쌓이기 시작하면서 새로 드러날 수 있는 경로). 프롬프트를 지우기 전에 그 프롬프트를
    //    가리키던 하루 집계 행을 먼저 지운다.
    let runsDeleted = 0;
    const deleted = await db.transaction(async (tx) => {
      if (cascade) {
        // 같은 prompt_text 의 runs 모두 삭제 (workspace 범위 한정 — 다른 워크스페이스 영향 없음)
        const runsResult = await tx
          .delete(schema.runs)
          .where(
            and(
              eq(schema.runs.workspaceId, target.workspaceId),
              eq(schema.runs.promptText, target.text),
            ),
          )
          .returning({ id: schema.runs.id });
        runsDeleted = runsResult.length;
      }

      await tx.delete(schema.dailyStats).where(eq(schema.dailyStats.promptId, id));

      const [row] = await tx
        .delete(schema.prompts)
        .where(eq(schema.prompts.id, id))
        .returning();
      return row;
    });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({ ok: true, runsDeleted });
  } catch (err) {
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — 서버 로그에만 상세를 남기고 클라이언트에는
    // 고정 오류 코드만 반환한다(위 PATCH 와 동일한 이유).
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/prompts/:id] DELETE 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "prompt_delete_failed" }, { status: 500 });
  }
}
