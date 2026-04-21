/**
 * /api/competitors/[id] — 개별 경쟁사 수정/삭제
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const UpdateCompetitorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  aliases: z.array(z.string()).optional(),
  websites: z.array(z.string()).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const parsed = UpdateCompetitorSchema.parse(body);
    const [updated] = await db
      .update(schema.competitors)
      .set(parsed)
      .where(eq(schema.competitors.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ competitor: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/competitors/:id] PATCH 실패:", message);
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
      .delete(schema.competitors)
      .where(eq(schema.competitors.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/competitors/:id] DELETE 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
