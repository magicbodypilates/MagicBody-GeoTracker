/**
 * /api/workspaces/[id]/prompt-sets — 질문 세트 목록 / 만들기 (계획 prompt-sets-plan-v2 §4)
 *
 * GET  — 세트 목록 `{ sets: [{ id, name, isDefault, createdAt, activePromptCount }] }`. 쓰기 없음.
 *        기본 세트 먼저, 그다음 만든 순서.
 * POST — 세트 만들기 `{ name }`(앞뒤 공백 제거 1～40자). 같은 트랜잭션에서 기본 세트를 먼저 보장한다 —
 *        그래야 「기본 세트 없이 일반 세트만 있는 워크스페이스」가 생기지 않는다.
 *        같은 이름 409 set_name_taken · 50개 초과 400 too_many_sets.
 *        개수 확인과 삽입은 워크스페이스 단위 잠금(트랜잭션 advisory lock) 안에서 한 줄로 세운다 — 동시 요청이
 *        모두 49개를 보고 함께 넣어 상한을 넘기지 않게(결함 대장 P4).
 *
 * 권한: 기존 질문 API 와 같다(getSession + assertWorkspaceAccess) — 일반관리자도 세트를 관리한다.
 * 오류 본문엔 SQL 원문 없이 고정 코드 + 쉬운 한국어 hint 만 싣는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { count, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  CreateSetSchema,
  MAX_SETS_PER_WORKSPACE,
  SET_HINTS,
  SET_ORDER,
  UuidSchema,
  ensureDefaultSet,
  isSetNameTaken,
} from "@/lib/server/prompt-sets";

export const dynamic = "force-dynamic";

function logFailure(label: string, err: unknown) {
  const cause = err instanceof Error ? err.cause : undefined;
  console.error(
    `[/api/workspaces/:id/prompt-sets] ${label} 실패:`,
    err instanceof Error ? err.message : String(err),
    cause !== undefined ? `cause: ${String(cause)}` : "",
  );
}

export async function GET(
  _req: NextRequest,
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
    const s = schema.promptSets;
    const p = schema.prompts;
    const rows = await db
      .select({
        id: s.id,
        name: s.name,
        isDefault: s.isDefault,
        createdAt: s.createdAt,
        activePromptCount: sql<number>`count(${p.id}) filter (where ${p.active})::int`,
      })
      .from(s)
      .leftJoin(p, eq(p.setId, s.id))
      .where(eq(s.workspaceId, id))
      .groupBy(s.id)
      .orderBy(SET_ORDER);
    return NextResponse.json({
      sets: rows.map((r) => ({ ...r, activePromptCount: Number(r.activePromptCount ?? 0) })),
    });
  } catch (err) {
    logFailure("GET", err);
    return NextResponse.json({ error: "prompt_sets_list_failed" }, { status: 500 });
  }
}

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
    const parsed = CreateSetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_input", hint: "세트 이름은 1～40자로 적어 주세요.", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    // 잠금 키·조회는 소문자 번호로 — 같은 워크스페이스를 대문자로 보낸 요청이 다른 잠금을 잡지 않게(P4-잔여)
    const wsId = id.toLowerCase();
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select 1 from pg_advisory_xact_lock(hashtextextended('geo:prompt-sets:' || ${wsId}::text, 0))`,
      );
      await ensureDefaultSet(tx, wsId);
      const [{ n }] = await tx
        .select({ n: count() })
        .from(schema.promptSets)
        .where(eq(schema.promptSets.workspaceId, wsId));
      if (Number(n) >= MAX_SETS_PER_WORKSPACE) return { tooMany: true as const };
      const [created] = await tx
        .insert(schema.promptSets)
        .values({ workspaceId: wsId, name: parsed.data.name, isDefault: false })
        .returning();
      return { created };
    });
    if ("tooMany" in result) {
      return NextResponse.json({ error: "too_many_sets", hint: SET_HINTS.tooManySets }, { status: 400 });
    }
    return NextResponse.json({ set: { ...result.created, activePromptCount: 0 } }, { status: 201 });
  } catch (err) {
    if (isSetNameTaken(err)) {
      return NextResponse.json({ error: "set_name_taken", hint: SET_HINTS.setNameTaken }, { status: 409 });
    }
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    logFailure("POST", err);
    return NextResponse.json({ error: "prompt_set_create_failed" }, { status: 500 });
  }
}
