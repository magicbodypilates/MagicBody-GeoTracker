/**
 * /api/workspaces/[id]/schedules — 자동 실행 스케줄 목록/생성
 *
 * 기본값: 12시간 주기 (00/12 KST)
 *
 * POST 의 promptIds: schedules/[id] PATCH 와 동일한 규칙으로 검증한다 — 그 워크스페이스에
 * 실재하는 질문만 유지하고, 비어 있지 않게 보낸 선택이 전부 무효면 400 으로 거부한다
 * (조용히 "활성 프롬프트 전체 실행"으로 확장되는 것을 막기 위함).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const CreateScheduleSchema = z.object({
  name: z.string().min(1).max(200),
  cronExpression: z.string().min(3).max(100),
  providers: z.array(z.string()).min(1),
  promptIds: z.array(z.string().uuid()).default([]),
  geolocation: z.string().nullable().optional(),
  active: z.boolean().default(true),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const rows = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.workspaceId, id))
      .orderBy(asc(schema.schedules.createdAt));
    return NextResponse.json({ schedules: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/schedules] GET 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const body = await req.json();
    const parsed = CreateScheduleSchema.parse(body);

    // promptIds 검증 — schedules/[id] PATCH 와 동일한 규칙. 비어 있지 않게 보낸 선택이
    // 그 워크스페이스에 실재하는 질문이 하나도 없으면 "활성 프롬프트 전체 실행"으로 조용히
    // 확장되는 것을 막기 위해 거부한다. 일부만 무효하면 무효 ID 만 걸러낸다. 빈 배열을
    // 명시적으로 보낸 경우(= 활성 질문 전체)는 그대로 허용.
    let promptIds = parsed.promptIds;
    if (promptIds.length > 0) {
      const existing = await db
        .select({ id: schema.prompts.id })
        .from(schema.prompts)
        .where(
          and(
            eq(schema.prompts.workspaceId, id),
            inArray(schema.prompts.id, promptIds),
          ),
        );
      const existingIds = new Set(existing.map((p) => p.id));
      const filteredPromptIds = promptIds.filter((pid) => existingIds.has(pid));
      if (filteredPromptIds.length === 0) {
        return NextResponse.json(
          {
            error: "no_valid_prompts_selected",
            hint: "선택한 질문이 모두 삭제되었거나 존재하지 않습니다. 질문을 다시 선택해 주세요.",
          },
          { status: 400 },
        );
      }
      promptIds = filteredPromptIds;
    }

    const [created] = await db
      .insert(schema.schedules)
      .values({
        workspaceId: id,
        name: parsed.name,
        cronExpression: parsed.cronExpression,
        providers: parsed.providers,
        promptIds,
        geolocation: parsed.geolocation ?? null,
        active: parsed.active,
      })
      .returning();
    return NextResponse.json({ schedule: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/schedules] POST 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
