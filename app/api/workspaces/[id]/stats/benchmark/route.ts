/**
 * GET /api/workspaces/[id]/stats/benchmark?days=30&auto=true
 *
 * 경쟁사 벤치마크 — 각 경쟁사의 동일 기간 언급률 vs 우리 브랜드 언급률.
 * 출력:
 *   {
 *     brand: { name, mentionRate, citedRate, sampleCount }
 *     competitors: [{ name, mentionRate, citedRate }, ...]
 *   }
 *
 * "우리 브랜드 언급" = brand_mentions 배열 length > 0
 * "경쟁사 XX 언급" = competitor_mentions 배열에 XX 포함
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

function parseInt32(v: string | null, def: number): number {
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const days = parseInt32(sp.get("days"), 30);
  const autoOnly = sp.get("auto") !== "false";

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );
  const conditions = [
    eq(schema.runs.workspaceId, id),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, now),
    qualityFilter,
  ];
  if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));

  try {
    // 1) 브랜드 기준
    const [brandRow] = await db
      .select({
        sampleCount: sql<number>`count(*)::int`,
        mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
        citedCount: sql<number>`count(*) filter (where array_length(${schema.runs.citedBrandDomains}, 1) > 0)::int`,
      })
      .from(schema.runs)
      .where(and(...conditions));

    const brandSample = brandRow?.sampleCount ?? 0;
    const brandMentionRate = brandSample > 0 ? (brandRow!.mentionCount ?? 0) / brandSample : 0;
    const brandCitedRate = brandSample > 0 ? (brandRow!.citedCount ?? 0) / brandSample : 0;

    // 2) 경쟁사 목록 조회
    const competitors = await db
      .select()
      .from(schema.competitors)
      .where(eq(schema.competitors.workspaceId, id));

    // 3) 각 경쟁사별로 competitor_mentions 에 name 혹은 aliases 가 포함된 runs 카운트
    const compStats = await Promise.all(
      competitors.map(async (c) => {
        const targets = [c.name, ...(c.aliases ?? [])].filter(Boolean);
        if (targets.length === 0) {
          return {
            name: c.name,
            sampleCount: brandSample,
            mentionRate: 0,
            citedRate: 0,
          };
        }
        // competitor_mentions && targets 교집합 비어있지 않음
        const [row] = await db
          .select({
            mentionCount: sql<number>`count(*) filter (where ${schema.runs.competitorMentions} && ${targets})::int`,
            citedCount: sql<number>`count(*) filter (where ${schema.runs.citedCompetitorDomains} && ${c.websites ?? []})::int`,
          })
          .from(schema.runs)
          .where(and(...conditions));
        return {
          name: c.name,
          sampleCount: brandSample,
          mentionRate: brandSample > 0 ? (row?.mentionCount ?? 0) / brandSample : 0,
          citedRate: brandSample > 0 ? (row?.citedCount ?? 0) / brandSample : 0,
        };
      }),
    );

    return NextResponse.json({
      days,
      brand: {
        name: "우리 브랜드",
        sampleCount: brandSample,
        mentionRate: Math.round(brandMentionRate * 1000) / 1000,
        citedRate: Math.round(brandCitedRate * 1000) / 1000,
      },
      competitors: compStats.map((c) => ({
        ...c,
        mentionRate: Math.round(c.mentionRate * 1000) / 1000,
        citedRate: Math.round(c.citedRate * 1000) / 1000,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/benchmark] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
