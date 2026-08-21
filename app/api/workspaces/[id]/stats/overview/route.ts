/**
 * GET /api/workspaces/[id]/stats/overview?days=30&runMode=auto&branded=false
 * GET /api/workspaces/[id]/stats/overview?from=2026-08-01&to=2026-08-11
 *
 * 가시성 분석 탭 상단 카드 묶음을 **한 번에** 반환하는 집계 라우트.
 *
 * 배경:
 *   이 탭은 브라우저가 runs 원본(응답 본문 포함)을 전부 내려받아 직접 집계했다. 90일이면
 *   3만 건 규모라 차트가 채워지기까지 수 분이 걸리고, 그동안 앞 구간이 0 으로 그려져
 *   오해를 부른다. 집계를 DB 로 내리면 응답이 수 KB 로 줄어 즉시 렌더된다.
 *
 * 반환:
 *   sampleCount        표본 수(전체 실행)
 *   avgVisibility      평균 가시성 (소수 1자리) / avgVisibilityRaw (무반올림)
 *   sentiment          긍정·중립·부정·미언급 건수
 *   brandSignals       mainMentioned(AI 본문 인용) · cited(공식 출처) · related(연관 출처)
 *
 * 판정 규칙은 화면(가시성 분석 탭)이 쓰던 것과 동일하다.
 *   - mainMentioned : brand_mentions 배열이 비어있지 않음
 *   - cited         : cited_brand_domains 배열이 비어있지 않음
 *   - related       : 공식 출처가 아닌 citation 의 제목·설명에 브랜드 용어가 포함 (순수함수 판정)
 *
 * related 는 SQL 사전 필터(superset)로 후보만 좁히고 최종 판정은 countRelatedRuns 가 한다.
 * 후보 행이 상한을 넘으면 relatedTruncated=true 로 알린다(조용한 과소집계 방지).
 *
 * 부분 실패 설계(M1):
 *   related 쿼리는 인용을 행으로 펼치므로 구간이 넓을수록 무거워진다. 그래서
 *     1) 모든 쿼리에 statement_timeout 을 건다.
 *     2) related 가 실패해도 **전체 응답을 실패로 만들지 않는다** — 그 카드만 "계산 불가"로 내리고
 *        기본 집계·감정 카드는 정상 표시한다(화면 전면 실패 방지).
 *     3) 구간이 RELATED_MAX_DAYS 를 넘으면 아예 계산하지 않고 건너뛴다(relatedStatus="skipped").
 *   `includeRelated=false` 로 부르면 계산을 생략한다(폴링 부하 절감 — relatedStatus="omitted").
 *
 * 운영 실측(2026-08-21, 자동·일반 검색):
 *   30일 = 확장 78,313행 / 후보 2,179행 / 1.0초
 *   90일 = 후보 5,370행 / 2.0초
 *   전체 이력(약 120일·241,568 확장행) = 후보 5,832행 / 2.2초
 *   자동 실행은 하루 약 333건씩 쌓이므로, 확장 행은 하루 약 2,600행씩 늘어난다.
 *   15초 제한에 닿는 지점은 확장 약 165만 행이고, 365일 구간은 데이터가 다 쌓여도
 *   약 95만 행(추정 8.6초)으로 제한의 절반 수준이다. 730일은 약 190만 행(추정 17초)으로
 *   제한을 넘으므로 365일을 계산 상한으로 잡는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, sql, type SQL } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhere } from "@/lib/server/run-stats-where";
import { buildBrandMentionPrefilter } from "@/lib/server/citation-brand-host-filter";
import { countRelatedRuns, type RelatedCitationRow } from "@/lib/server/overview-related";
import { safeEnvInt } from "@/lib/server/citation-url-aggregate";
import {
  parseStatsRange,
  parseRunMode,
  isStatsRangeError,
  type RunMode,
} from "@/lib/server/stats-range";

export const dynamic = "force-dynamic";

/** related 후보 행 상한 — 도달 시 truncated 플래그로 알린다(조용한 과소집계 방지). */
const RELATED_ROW_CAP = safeEnvInt(process.env.OVERVIEW_RELATED_ROW_CAP, {
  fallback: 200_000,
  min: 1000,
  max: 2_000_000,
});
/**
 * 연관 출처를 계산하는 최대 구간(일). 이보다 넓으면 계산을 건너뛰고 화면이 그 사실을 알린다.
 * 근거는 파일 상단 주석의 운영 실측 참조.
 */
export const RELATED_MAX_DAYS = safeEnvInt(process.env.OVERVIEW_RELATED_MAX_DAYS, {
  fallback: 365,
  min: 1,
  max: 730,
});
/** 집계 쿼리 statement_timeout(ms) — raw 인라인이므로 정수 검증 필수. */
const STATEMENT_TIMEOUT_MS = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
  fallback: 15000,
  min: 1000,
  max: 120000,
});

/** related 후보 쿼리가 방출하는 행 shape (postgres.js 결과) */
type ExpandedRelatedRow = {
  run_id: string;
  url: string | null;
  title: string | null;
  description: string | null;
  cited_brand_domains: string[] | null;
};

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
  // runMode 미지정 시 폴백은 timeseries 라우트와 **같은 규칙**을 쓴다(m4).
  //   auto=false → 전체(all), 그 외(미지정 포함) → 자동만(auto)
  const legacyAutoOnly = sp.get("auto") !== "false";
  const runMode: RunMode = parseRunMode(sp) ?? (legacyAutoOnly ? "auto" : "all");
  const brandedView = sp.get("branded") === "true";
  /** 폴링처럼 가벼운 갱신에서는 false 로 불러 연관 출처 계산을 생략한다(M4). */
  const includeRelated = sp.get("includeRelated") !== "false";

  try {
    const brandTerms = await getBrandTermsForWorkspace(id);
    const conditions = buildRunStatsWhere({
      workspaceId: id,
      fromDate: range.from,
      toDate: range.to,
      autoOnly: runMode === "auto",
      runMode,
      brandTerms,
      branded: brandedView,
    });
    const where = and(...conditions) as SQL;

    // 기본 집계 — statement_timeout 을 걸어 넓은 구간에서 서버를 무한정 붙잡지 않게 한다(M1).
    const [agg] = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return tx
        .select({
          sampleCount: sql<number>`count(*)::int`,
          avgVisibility: sql<number>`coalesce(avg(${schema.runs.visibilityScore}), 0)::float`,
          // 공백만 든 항목은 화면 판정(`m.trim() !== ""`)과 맞추기 위해 btrim 으로 제외한다(m1).
          mainMentioned: sql<number>`count(*) filter (where exists (select 1 from unnest(${schema.runs.brandMentions}) m where btrim(m) <> ''))::int`,
          cited: sql<number>`count(*) filter (where array_length(${schema.runs.citedBrandDomains}, 1) > 0)::int`,
          positive: sql<number>`count(*) filter (where ${schema.runs.sentiment} = 'positive')::int`,
          neutral: sql<number>`count(*) filter (where ${schema.runs.sentiment} = 'neutral')::int`,
          negative: sql<number>`count(*) filter (where ${schema.runs.sentiment} = 'negative')::int`,
          notMentioned: sql<number>`count(*) filter (where ${schema.runs.sentiment} = 'not-mentioned')::int`,
        })
        .from(schema.runs)
        .where(where);
    });

    /**
     * 연관 출처 상태.
     *   ok       계산 완료
     *   skipped  구간이 RELATED_MAX_DAYS 초과 — 계산하지 않음
     *   omitted  includeRelated=false — 호출부가 생략을 요청
     *   failed   쿼리 실패(대개 statement_timeout) — 이 카드만 떨어뜨리고 나머지는 정상 표시
     *   none     브랜드 용어 미등록 — 판정이 항상 false 라 0 과 같음
     */
    let relatedStatus: "ok" | "skipped" | "omitted" | "failed" | "none" = "none";
    let related: number | null = 0;
    let relatedTruncated = false;

    if (brandTerms.length === 0) {
      relatedStatus = "none";
    } else if (!includeRelated) {
      relatedStatus = "omitted";
      related = null;
    } else if (range.days > RELATED_MAX_DAYS) {
      relatedStatus = "skipped";
      related = null;
    } else {
      const mentionPrefilter = buildBrandMentionPrefilter(brandTerms);
      try {
        // SQL 은 후보만 좁힌다(superset). 최종 판정은 countRelatedRuns 순수함수.
        // statement_timeout · 행 cap · 결정적 ORDER BY 는 기존 citation 라우트와 동일한 방어.
        //
        // 알려진 예외(m6): SQL 은 제목과 설명을 **각각** 검사하는데 JS 판정은 둘을 공백으로
        // 이어 붙여 검사한다. 그래서 브랜드 용어가 제목 끝과 설명 앞에 걸쳐 있는 극단적인
        // 경우(예: 제목이 "…매직", 설명이 "바디…")에는 SQL 이 후보로 잡지 못한다.
        // 실무상 발생 가능성이 거의 없어 superset 을 넓히지 않고 그대로 둔다.
        const expanded = (await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
          return tx.execute<ExpandedRelatedRow>(sql`
            SELECT
              ${schema.runs.id}                 AS run_id,
              cite->>'url'                      AS url,
              cite->>'title'                    AS title,
              cite->>'description'              AS description,
              ${schema.runs.citedBrandDomains}  AS cited_brand_domains
            FROM ${schema.runs}
            CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
            WHERE ${where}
              AND jsonb_typeof(${schema.runs.citations}) = 'array'
              AND ${mentionPrefilter}
            ORDER BY ${schema.runs.createdAt}, ${schema.runs.id}
            LIMIT ${RELATED_ROW_CAP}
          `);
        })) as unknown as ExpandedRelatedRow[];

        relatedTruncated = expanded.length >= RELATED_ROW_CAP;
        const mapped: RelatedCitationRow[] = expanded.map((r) => ({
          runId: r.run_id,
          url: r.url,
          title: r.title,
          description: r.description,
          citedBrandDomains: r.cited_brand_domains,
        }));
        related = countRelatedRuns(mapped, brandTerms);
        relatedStatus = "ok";
      } catch (err) {
        // 이 카드만 실패로 두고 나머지 응답은 그대로 내려보낸다 — 화면 전면 실패 방지(M1).
        const message = err instanceof Error ? err.message : "unknown";
        console.error("[/api/workspaces/:id/stats/overview] 연관 출처 집계 실패:", message);
        relatedStatus = "failed";
        related = null;
      }
    }

    const avgRaw = Number(agg?.avgVisibility) || 0;

    return NextResponse.json({
      range: {
        mode: range.mode,
        days: range.days,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        fromDate: range.fromDateKey,
        toDate: range.toDateKey,
      },
      runMode,
      branded: brandedView,
      sampleCount: agg?.sampleCount ?? 0,
      avgVisibility: Math.round(avgRaw * 10) / 10,
      avgVisibilityRaw: avgRaw,
      sentiment: {
        positive: agg?.positive ?? 0,
        neutral: agg?.neutral ?? 0,
        negative: agg?.negative ?? 0,
        "not-mentioned": agg?.notMentioned ?? 0,
      },
      brandSignals: {
        mainMentioned: agg?.mainMentioned ?? 0,
        cited: agg?.cited ?? 0,
        related,
      },
      relatedStatus,
      relatedMaxDays: RELATED_MAX_DAYS,
      relatedTruncated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/overview] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
