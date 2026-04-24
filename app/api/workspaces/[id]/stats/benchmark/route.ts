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
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

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
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
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

    // 3) runs 의 경쟁사 언급/인용 + 답변 본문 · 인용 URL 로드
    //    경쟁사를 나중에 추가해도 과거 데이터에 즉시 반영하기 위해,
    //    저장된 배열뿐 아니라 answer 본문 · citations 배열에서도 실시간 매칭.
    const runsForComp =
      competitors.length === 0
        ? []
        : await db
            .select({
              answer: schema.runs.answer,
              competitorMentions: schema.runs.competitorMentions,
              citedCompetitorDomains: schema.runs.citedCompetitorDomains,
              citations: schema.runs.citations,
            })
            .from(schema.runs)
            .where(and(...conditions));

    // 4) 자바스크립트에서 교집합 계산 — 저장된 필드 + 본문 실시간 매칭 OR 결합
    const compStats = competitors.map((c) => {
      const termsLower = [c.name, ...(c.aliases ?? [])]
        .filter(Boolean)
        .map((s) => s.toLowerCase());
      const targets = new Set(termsLower);
      // 사이트 호스트 정규화 (www. 제거)
      const siteHosts = new Set(
        (c.websites ?? [])
          .map((u) => {
            try {
              return new URL(u.startsWith("http") ? u : `https://${u}`)
                .hostname.replace(/^www\./, "")
                .toLowerCase();
            } catch {
              return u.toLowerCase().replace(/^www\./, "");
            }
          })
          .filter(Boolean),
      );

      let mentions = 0;
      let cited = 0;
      for (const r of runsForComp) {
        // 언급: 저장된 competitorMentions OR 본문에서 직접 매칭
        const mArr = r.competitorMentions ?? [];
        const hasStored = mArr.some((m) => targets.has(m.toLowerCase()));
        const answerLower = (r.answer ?? "").toLowerCase();
        const hasInBody =
          !hasStored && termsLower.some((t) => t && answerLower.includes(t));
        if (hasStored || hasInBody) mentions += 1;

        // 인용: 저장된 citedCompetitorDomains OR citations JSONB 에서 직접 매칭
        const dArr = r.citedCompetitorDomains ?? [];
        const hasStoredCited = dArr.some((d) => siteHosts.has(d.toLowerCase()));
        let hasCitedInJsonb = false;
        if (!hasStoredCited && siteHosts.size > 0) {
          const cits = Array.isArray(r.citations) ? r.citations : [];
          for (const c of cits as Array<{ url?: string; domain?: string }>) {
            const raw = (c?.domain || c?.url || "").toString();
            if (!raw) continue;
            try {
              const host = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
                .hostname.replace(/^www\./, "")
                .toLowerCase();
              if (siteHosts.has(host)) {
                hasCitedInJsonb = true;
                break;
              }
            } catch {
              const host = raw.toLowerCase().replace(/^www\./, "");
              if (siteHosts.has(host)) {
                hasCitedInJsonb = true;
                break;
              }
            }
          }
        }
        if (hasStoredCited || hasCitedInJsonb) cited += 1;
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
