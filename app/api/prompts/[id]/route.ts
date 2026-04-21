/**
 * /api/prompts/[id] — 개별 프롬프트 수정/삭제
 *
 * PATCH  — text / tags / active 일부 또는 전체 수정
 * DELETE — 프롬프트 제거 (연관된 schedules.promptIds 는 UUID 배열이라 cascade 안 됨 —
 *          호출 측이 스케줄 업데이트 필요. runs 는 prompt_text 를 별도 컬럼으로 가져서 영향 없음)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";

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
  try {
    const body = await req.json();
    const parsed = UpdatePromptSchema.parse(body);
    const [updated] = await db
      .update(schema.prompts)
      .set(parsed)
      .where(eq(schema.prompts.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ prompt: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/prompts/:id] PATCH 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const [deleted] = await db
      .delete(schema.prompts)
      .where(eq(schema.prompts.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/prompts/:id] DELETE 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
