/**
 * /api/workspaces/[id]/prompts — 워크스페이스별 프롬프트 목록/추가
 *
 * GET  — 해당 워크스페이스의 프롬프트 전체 (active/inactive 모두)
 * POST — 프롬프트 추가 (UNIQUE 제약: 워크스페이스 내 중복 text 거부)
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
    const [created] = await db
      .insert(schema.prompts)
      .values({
        workspaceId: id,
        text: parsed.text,
        tags: parsed.tags,
        active: parsed.active,
      })
      .returning();
    return NextResponse.json({ prompt: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    // UNIQUE 제약 위반 — 동일 text 이미 존재
    const message = err instanceof Error ? err.message : "unknown";
    if (message.includes("uq_prompts_workspace_text")) {
      return NextResponse.json({ error: "duplicate_prompt" }, { status: 409 });
    }
    console.error("[/api/workspaces/:id/prompts] POST 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
