/**
 * /api/workspaces/[id]/audits — AEO 감사 이력 목록/추가
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const CreateAuditSchema = z.object({
  url: z.string().url().max(1024),
  score: z.number().int().min(0).max(100),
  report: z.record(z.string(), z.any()),
  note: z.string().nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const rows = await db
      .select()
      .from(schema.auditHistory)
      .where(eq(schema.auditHistory.workspaceId, id))
      .orderBy(desc(schema.auditHistory.createdAt))
      .limit(200);
    return NextResponse.json({ audits: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const parsed = CreateAuditSchema.parse(body);
    const [created] = await db
      .insert(schema.auditHistory)
      .values({
        workspaceId: id,
        url: parsed.url,
        score: parsed.score,
        report: parsed.report as never,
        note: parsed.note ?? null,
      })
      .returning();
    return NextResponse.json({ audit: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
