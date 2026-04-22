/**
 * /api/workspaces/[id]/competitors — 경쟁사 목록/추가
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const CreateCompetitorSchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string()).default([]),
  websites: z.array(z.string()).default([]),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const rows = await db
      .select()
      .from(schema.competitors)
      .where(eq(schema.competitors.workspaceId, id))
      .orderBy(asc(schema.competitors.createdAt));
    return NextResponse.json({ competitors: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/competitors] GET 실패:", message);
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
    const parsed = CreateCompetitorSchema.parse(body);

    // 동일 이름 기존 레코드 확인 — 중복 삽입 방지 (DB 유니크 제약 없는 상태 보완)
    const existing = await db
      .select()
      .from(schema.competitors)
      .where(
        and(
          eq(schema.competitors.workspaceId, id),
          eq(schema.competitors.name, parsed.name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // 이미 있으면 aliases/websites 병합(merge) 후 그대로 반환 — 중복 row 증식 차단
      const [updated] = await db
        .update(schema.competitors)
        .set({
          aliases: Array.from(new Set([...(existing[0].aliases ?? []), ...parsed.aliases])),
          websites: Array.from(new Set([...(existing[0].websites ?? []), ...parsed.websites])),
        })
        .where(eq(schema.competitors.id, existing[0].id))
        .returning();
      return NextResponse.json({ competitor: updated }, { status: 200 });
    }

    const [created] = await db
      .insert(schema.competitors)
      .values({
        workspaceId: id,
        name: parsed.name,
        aliases: parsed.aliases,
        websites: parsed.websites,
      })
      .returning();
    return NextResponse.json({ competitor: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/competitors] POST 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
