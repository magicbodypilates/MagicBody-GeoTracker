/**
 * /api/workspaces/[id]/competitors — 경쟁사 목록/추가
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, asc, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

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
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
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
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const body = await req.json();
    const parsed = CreateCompetitorSchema.parse(body);

    // 동일 이름 모든 기존 레코드 확인 — 중복 삽입 방지 + 과거 중복 row 정리
    // (DB 유니크 제약이 없어 과거에 같은 이름의 row 가 2개 이상 쌓인 워크스페이스가
    //  있으면 가장 "정보량 많은" row 하나로 병합하고 나머지는 삭제)
    const existing = await db
      .select()
      .from(schema.competitors)
      .where(
        and(
          eq(schema.competitors.workspaceId, id),
          eq(schema.competitors.name, parsed.name),
        ),
      );

    if (existing.length > 0) {
      // 가장 많은 alias 를 가진 row 를 canonical 로 선택 (동률이면 먼저 생성된 row)
      const canonical = [...existing].sort((a, b) => {
        const aScore =
          (a.aliases?.length ?? 0) + (a.websites?.length ?? 0);
        const bScore =
          (b.aliases?.length ?? 0) + (b.websites?.length ?? 0);
        if (bScore !== aScore) return bScore - aScore;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      })[0];

      const mergedAliases = Array.from(
        new Set([
          ...existing.flatMap((e) => e.aliases ?? []),
          ...parsed.aliases,
        ].filter(Boolean)),
      );
      const mergedWebsites = Array.from(
        new Set([
          ...existing.flatMap((e) => e.websites ?? []),
          ...parsed.websites,
        ].filter(Boolean)),
      );

      const [updated] = await db
        .update(schema.competitors)
        .set({ aliases: mergedAliases, websites: mergedWebsites })
        .where(eq(schema.competitors.id, canonical.id))
        .returning();

      // canonical 외 중복 row 는 runs 에는 name 문자열만 저장되므로 안전하게 삭제 가능
      const duplicateIds = existing
        .filter((e) => e.id !== canonical.id)
        .map((e) => e.id);
      if (duplicateIds.length > 0) {
        for (const dupId of duplicateIds) {
          await db
            .delete(schema.competitors)
            .where(eq(schema.competitors.id, dupId));
        }
        console.log(
          `[competitors] 워크스페이스 ${id} 에서 중복 경쟁사 row ${duplicateIds.length}개 정리됨 (name="${parsed.name}")`,
        );
      }

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
