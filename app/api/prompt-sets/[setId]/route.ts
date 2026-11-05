/**
 * /api/prompt-sets/[setId] — 질문 세트 이름 바꾸기 / 지우기 (계획 prompt-sets-plan-v2 §4)
 *
 * PATCH  — **이름 바꾸기만** `{ name }`. 다른 칸(isDefault 등)이 오면 400. 같은 이름 409 set_name_taken.
 * DELETE — 한 트랜잭션:
 *   ① 세트 행 FOR UPDATE — 이 세트로 질문을 넣거나 옮기는 동시 요청의 외래 키 검사가 여기서 기다린다
 *   ② 기본 세트면 400 default_set_locked
 *   ③ 이 세트의 질문 행 FOR UPDATE — 동시에 「다시 켜기」가 들어오면 줄을 세운다(검사 사이 틈이 없다)
 *   ④ 켜진 질문이 있으면 409 set_not_empty { activeCount }
 *   ⑤ 잡아 둔 (꺼진) 질문을 기본 세트로 옮긴다
 *   ⑥ 세트 삭제
 *   이 경로의 외래 키 위반(23503)은 set_not_empty 로 바꾼다(세트에 질문이 남았다는 뜻).
 *
 * 권한: 세트로 워크스페이스를 찾은 뒤 assertWorkspaceAccess — 기존 질문 API(/api/prompts/[id])와 같은 방식.
 * 경로 번호는 DB 를 타기 전에 UUID 형식을 확인한다(아니면 400). 오류 본문엔 SQL 원문을 싣지 않는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  PromptSetError,
  RenameSetSchema,
  SET_HINTS,
  UuidSchema,
  ensureDefaultSet,
  isPromptSetFkViolation,
  isSetNameTaken,
} from "@/lib/server/prompt-sets";

export const dynamic = "force-dynamic";

function logFailure(label: string, err: unknown) {
  const cause = err instanceof Error ? err.cause : undefined;
  console.error(
    `[/api/prompt-sets/:setId] ${label} 실패:`,
    err instanceof Error ? err.message : String(err),
    cause !== undefined ? `cause: ${String(cause)}` : "",
  );
}

/** 세트 → 워크스페이스 조회 후 권한 확인. 실패하면 응답, 통과하면 세트 정보. */
async function loadAndGuard(setId: string) {
  const [target] = await db
    .select({
      id: schema.promptSets.id,
      workspaceId: schema.promptSets.workspaceId,
      isDefault: schema.promptSets.isDefault,
    })
    .from(schema.promptSets)
    .where(eq(schema.promptSets.id, setId))
    .limit(1);
  if (!target) {
    return { res: NextResponse.json({ error: "not_found", hint: SET_HINTS.notFound }, { status: 404 }) };
  }
  const session = await getSession();
  const guard = await assertWorkspaceAccess(target.workspaceId, session);
  if (guard) return { res: guard };
  return { target };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ setId: string }> },
) {
  const { setId } = await params;
  if (!UuidSchema.safeParse(setId).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const loaded = await loadAndGuard(setId);
    if (loaded.res) return loaded.res;

    const body = await req.json().catch(() => null);
    const parsed = RenameSetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_input", hint: "세트 이름(1～40자)만 바꿀 수 있어요.", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const [updated] = await db
      .update(schema.promptSets)
      .set({ name: parsed.data.name })
      .where(eq(schema.promptSets.id, setId))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found", hint: SET_HINTS.notFound }, { status: 404 });
    return NextResponse.json({ set: updated });
  } catch (err) {
    if (isSetNameTaken(err)) {
      return NextResponse.json({ error: "set_name_taken", hint: SET_HINTS.setNameTaken }, { status: 409 });
    }
    logFailure("PATCH", err);
    return NextResponse.json({ error: "prompt_set_update_failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ setId: string }> },
) {
  const { setId } = await params;
  if (!UuidSchema.safeParse(setId).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const loaded = await loadAndGuard(setId);
    if (loaded.res) return loaded.res;
    const workspaceId = loaded.target.workspaceId;

    const result = await db.transaction(async (tx) => {
      // ① 세트 행 잠금 — 동시에 지워졌으면 0행
      const locked = (await tx.execute(
        sql`select id, is_default from prompt_sets where id = ${setId} for update`,
      )) as unknown as { id: string; is_default: boolean }[];
      if (locked.length === 0) throw new PromptSetError(404, "not_found", SET_HINTS.notFound);
      // ② 기본 세트는 지울 수 없다
      if (locked[0].is_default) throw new PromptSetError(400, "default_set_locked", SET_HINTS.defaultSetLocked);
      // ③ 이 세트의 질문 행 잠금 — 동시 「다시 켜기」를 줄 세운다
      const rows = (await tx.execute(
        sql`select id, active from prompts where set_id = ${setId} for update`,
      )) as unknown as { id: string; active: boolean }[];
      // ④ 켜진 질문이 있으면 거절
      const activeCount = rows.filter((r) => r.active).length;
      if (activeCount > 0) {
        throw new PromptSetError(409, "set_not_empty", SET_HINTS.setNotEmpty, { activeCount });
      }
      // ⑤ 잡아 둔 꺼진 질문을 기본 세트로
      let movedInactive = 0;
      if (rows.length > 0) {
        const def = await ensureDefaultSet(tx, workspaceId);
        const moved = await tx
          .update(schema.prompts)
          .set({ setId: def.id })
          .where(eq(schema.prompts.setId, setId))
          .returning({ id: schema.prompts.id });
        movedInactive = moved.length;
      }
      // ⑥ 세트 삭제
      await tx.delete(schema.promptSets).where(eq(schema.promptSets.id, setId));
      return { movedInactive };
    });
    return NextResponse.json({ ok: true, movedInactive: result.movedInactive });
  } catch (err) {
    if (err instanceof PromptSetError) {
      return NextResponse.json({ error: err.code, hint: err.hint, ...err.extra }, { status: err.status });
    }
    if (isPromptSetFkViolation(err)) {
      return NextResponse.json({ error: "set_not_empty", hint: SET_HINTS.setNotEmpty }, { status: 409 });
    }
    logFailure("DELETE", err);
    return NextResponse.json({ error: "prompt_set_delete_failed" }, { status: 500 });
  }
}
