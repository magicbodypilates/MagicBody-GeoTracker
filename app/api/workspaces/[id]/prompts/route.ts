/**
 * /api/workspaces/[id]/prompts — 워크스페이스별 프롬프트 목록/추가
 *
 * GET  — 해당 워크스페이스의 프롬프트 전체 (active/inactive 모두)
 * POST — "추가" = 없으면 새로 만들고, 이미 있으면(꺼진 채로 남아 있어도) 다시 켠다.
 *   화면(GET /prompts 를 active 로만 거른 목록)에는 꺼짐이라는 개념이 안 보이므로, 과거에
 *   제거됐던 문구를 다시 추가하면 유니크 제약(uq_prompts_workspace_text)에 막혀 영영 안
 *   보이는 문제가 있었다 — ON CONFLICT DO UPDATE 로 해결(아래 POST 주석 참고).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { asc, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const CreatePromptSchema = z.object({
  text: z.string().min(1).max(2000),
  tags: z.array(z.string()).default([]),
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
      .from(schema.prompts)
      .where(eq(schema.prompts.workspaceId, id))
      .orderBy(asc(schema.prompts.createdAt));
    return NextResponse.json({ prompts: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/prompts] GET 실패:", message);
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
    const parsed = CreatePromptSchema.parse(body);
    // ON CONFLICT DO UPDATE — select-then-insert 방식의 경합(TOCTOU) 없이 "없으면 생성,
    // 있으면 재활성화"를 한 쿼리로 처리한다. 태그는 기존 값을 유지(재추가 요청의 tags 로
    // 덮어쓰지 않음) — active 만 되돌린다.
    const [prompt] = await db
      .insert(schema.prompts)
      .values({
        workspaceId: id,
        text: parsed.text,
        tags: parsed.tags,
        active: true,
      })
      .onConflictDoUpdate({
        target: [schema.prompts.workspaceId, schema.prompts.text],
        set: { active: true },
      })
      .returning();
    return NextResponse.json({ prompt }, { status: 201 });
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
      "[/api/workspaces/:id/prompts] POST 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "prompt_create_failed" }, { status: 500 });
  }
}
