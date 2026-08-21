/**
 * GET /api/workspaces/[id]/stats/benchmark?days=30&auto=true
 * GET /api/workspaces/[id]/stats/benchmark?from=2026-08-01&to=2026-08-21
 *
 * 조회 구간: `from`/`to` (KST 일자, 양끝 포함) 가 오면 우선, 없으면 기존 `days` 롤링 윈도우.
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
 *
 * 넓은 구간 방어: 경쟁사 집계는 응답 본문(answer)·인용(citations)을 통째로 Node 로 읽으므로
 * 구간이 넓을수록 그대로 메모리를 먹는다. 그래서
 *   - 구간이 STATS_HEAVY_MAX_DAYS 를 넘으면 계산하지 않고 competitorStatus="skipped" 로 알리고,
 *   - 쿼리가 실패(대개 statement_timeout)해도 "failed" 로 내려 **브랜드 지표는 그대로** 반환한다.
 * 어느 경우에도 200 이므로 홈 화면이 이 카드 하나 때문에 통째로 비지 않는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, runStatsQuery, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace, viewModeCondition } from "@/lib/server/branded-query-filter";
import { parseStatsRange, isStatsRangeError } from "@/lib/server/stats-range";
import {
  STATS_HEAVY_MAX_DAYS,
  exceedsHeavyLimit,
  statsRangeMeta,
} from "@/lib/server/stats-guard";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  const sp = req.nextUrl.searchParams;
  const range = parseStatsRange(sp, { defaultDays: 30 });
  if (isStatsRangeError(range)) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }
  const { from, to } = range;
  const autoOnly = sp.get("auto") !== "false";

  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );
  const conditions = [
    eq(schema.runs.workspaceId, id),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, to),
    qualityFilter,
  ];
  if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));
  const __brandedView = sp.get("branded") === "true";
  const __brandTerms = await getBrandTermsForWorkspace(id);
  const __informational = viewModeCondition(__brandTerms, __brandedView);
  if (__informational) conditions.push(__informational);

  try {
    // 1) 브랜드 기준 집계 + runs 의 competitorMentions/citedCompetitorDomains 배열 로드
    const [brandRow] = await runStatsQuery(async (tx) => {
      return tx
        .select({
          sampleCount: sql<number>`count(*)::int`,
          mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
          citedCount: sql<number>`count(*) filter (where array_length(${schema.runs.citedBrandDomains}, 1) > 0)::int`,
        })
        .from(schema.runs)
        .where(and(...conditions));
    });

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
    /**
     * 경쟁사 집계 상태.
     *   none    경쟁사가 등록돼 있지 않음 (기존과 동일하게 빈 목록)
     *   ok      정상 계산
     *   skipped 구간이 계산 상한을 넘어 계산하지 않음
     *   failed  쿼리 실패(대개 statement_timeout) — 브랜드 지표만 반환
     */
    let competitorStatus: "none" | "ok" | "skipped" | "failed" = "none";
    type CompRow = {
      answer: string | null;
      competitorMentions: string[] | null;
      citedCompetitorDomains: string[] | null;
      citations: unknown;
    };
    let runsForComp: CompRow[] = [];
    if (competitors.length === 0) {
      competitorStatus = "none";
    } else if (exceedsHeavyLimit(range)) {
      competitorStatus = "skipped";
    } else {
      try {
        runsForComp = await runStatsQuery(async (tx) => {
          return tx
            .select({
              answer: schema.runs.answer,
              competitorMentions: schema.runs.competitorMentions,
              citedCompetitorDomains: schema.runs.citedCompetitorDomains,
              citations: schema.runs.citations,
            })
            .from(schema.runs)
            .where(and(...conditions));
        });
        competitorStatus = "ok";
      } catch (err) {
        console.error(
          "[/api/workspaces/:id/stats/benchmark] 경쟁사 집계 실패:",
          err instanceof Error ? err.message : "unknown",
        );
        competitorStatus = "failed";
      }
    }

    // 4) 자바스크립트에서 교집합 계산 — 저장된 필드 + 본문 실시간 매칭 OR 결합
    const compStats = competitorStatus === "ok" ? competitors.map((c) => {
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
    }) : [];

    return NextResponse.json({
      days: range.days,
      range: statsRangeMeta(range),
      competitorStatus,
      heavyMaxDays: STATS_HEAVY_MAX_DAYS,
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
