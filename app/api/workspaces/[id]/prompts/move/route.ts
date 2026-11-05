/**
 * POST /api/workspaces/[id]/prompts/move — 질문을 다른 세트로 옮기기 (계획 prompt-sets-plan-v2 §4 · R3·R4)
 *
 * 본문 `{ promptIds: uuid[1..500], setId: uuid }`.
 *   - 세트가 이 워크스페이스 것이 아니면 400 invalid_set
 *   - `UPDATE prompts SET set_id WHERE workspace_id = ws AND id = ANY(ids)` 한 문장 — 다른 워크스페이스의
 *     질문 번호가 섞여 와도 건드리지 않고 notFound 로 돌려준다
 *   - 응답(runs)·일정(schedules)·하루 집계(daily_stats)는 바꾸지 않는다 — 응답은 질문 문장으로만 이어지므로
 *     옮긴 질문의 과거 답변은 질문이 지금 속한 세트에서 보인다(사용자 확정)
 *   - 세트가 방금 지워졌으면(외래 키 위반) 409 set_gone
 * 응답 200 `{ moved, notFound }`.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  MovePromptsSchema,
  SET_HINTS,
  UuidSchema,
  isPromptSetFkViolation,
} from "@/lib/server/prompt-sets";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => null);
    const parsed = MovePromptsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_input", hint: "옮길 질문과 세트를 다시 골라 주세요.", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    // 소문자로 맞춘 뒤 중복을 없앤다 — DB 가 돌려주는 번호는 소문자라, 대문자로 온 번호를 그대로 비교하면
    // 옮겨진 질문이 notFound 에도 잡힌다(결함 대장 P5).
    const ids = Array.from(new Set(parsed.data.promptIds.map((x) => x.toLowerCase())));
    const setId = parsed.data.setId.toLowerCase();

    const [set] = await db
      .select({ id: schema.promptSets.id })
      .from(schema.promptSets)
      .where(and(eq(schema.promptSets.id, setId), eq(schema.promptSets.workspaceId, id)))
      .limit(1);
    if (!set) {
      return NextResponse.json({ error: "invalid_set", hint: SET_HINTS.invalidSet }, { status: 400 });
    }

    const moved = await db
      .update(schema.prompts)
      .set({ setId })
      .where(and(eq(schema.prompts.workspaceId, id), inArray(schema.prompts.id, ids)))
      .returning({ id: schema.prompts.id });
    const movedIds = new Set(moved.map((r) => r.id));
    const notFound = ids.filter((x) => !movedIds.has(x));
    return NextResponse.json({ moved: moved.length, notFound });
  } catch (err) {
    if (isPromptSetFkViolation(err)) {
      return NextResponse.json({ error: "set_gone", hint: SET_HINTS.setGone }, { status: 409 });
    }
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/prompts/move] POST 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "prompts_move_failed" }, { status: 500 });
  }
}
