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
 * 구현: 경쟁사별로 쿼리를 돌리지 않고, 기간 내 runs 전체를 한 번 로드해
 * 자바스크립트에서 배열 교집합 계산. DB 커넥션 풀 고갈·N+1 회피.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

function parseInt32(v: string | null, def: number, max = 365): number {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
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
    // 1) 브랜드 기준 집계 + runs 의 competitorMentions/citedCompetitorDomains 배열 로드
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

    // 2) 경쟁사 목록
    const competitors = await db
      .select()
      .from(schema.competitors)
      .where(eq(schema.competitors.workspaceId, id));

    // 3) runs 의 경쟁사 언급/인용 배열만 로드 (답변 · 소스 · 기타 JSONB 제외 — 메모리 절약)
    const runsForComp =
      competitors.length === 0
        ? []
        : await db
            .select({
              competitorMentions: schema.runs.competitorMentions,
              citedCompetitorDomains: schema.runs.citedCompetitorDomains,
            })
            .from(schema.runs)
            .where(and(...conditions));

    // 4) 자바스크립트에서 교집합 계산 — 경쟁사 수가 많아도 단일 루프
    const compStats = competitors.map((c) => {
      const targets = new Set(
        [c.name, ...(c.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase()),
      );
      const sites = new Set((c.websites ?? []).map((s) => s.toLowerCase()));

      let mentions = 0;
      let cited = 0;
      for (const r of runsForComp) {
        const mArr = r.competitorMentions ?? [];
        if (mArr.some((m) => targets.has(m.toLowerCase()))) mentions += 1;
        const dArr = r.citedCompetitorDomains ?? [];
        if (dArr.some((d) => sites.has(d.toLowerCase()))) cited += 1;
      }
      return {
        name: c.name,
        sampleCount: brandSample,
        mentionRate: brandSample > 0 ? mentions / brandSample : 0,
        citedRate: brandSample > 0 ? cited / brandSample : 0,
      };
    });

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
