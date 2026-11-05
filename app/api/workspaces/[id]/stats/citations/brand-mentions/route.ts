/**
 * GET /api/workspaces/[id]/stats/citations/brand-mentions
 *
 * "인용 출처" 탭의 "브랜드 언급 출처(제3자)" 전수 노출 뷰.
 * 전체 기간(all-time) 동안 AI 답변에 인용된 외부 출처(보도자료·언론기사 등) 중,
 * 인용의 제목/설명에 브랜드명(별칭)이 언급된 개별 페이지 URL 을 cursor 페이지네이션으로 전수 조회한다.
 * 내 사이트(소유 도메인)로 이미 잡히는 인용은 제외(소유 URL 뷰와 중복 방지).
 * 각 URL 에는 그 URL 을 인용한 프롬프트 top-N 이 inline.
 *
 * 쿼리:
 *   ?auto=true|false   (기본 true — 자동 실행만)
 *   ?branded=true|false (기본 false — 질문 유형 필터: 브랜드명 포함 검색 여부)
 *   ?pageSize=100      (기본 100, 최대 500)
 *   ?cursor=<opaque>   (keyset cursor. 없으면 첫 페이지)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD (KST, 양끝 포함 — 2026-11-05 기간 검색). 없으면 all-time
 *                      (무한 스캔 방지 상한 MAX_LOOKBACK_DAYS 만 적용)
 *   ?provider=<AI 모델> (없으면 전체 모델)
 *   ?newOnly=true      (선택 기간 안에서 처음 인용된 URL 만. 기간 지정 시에만 의미)
 *   처음·마지막 인용일은 선택 기간 안에서 계산한다. 「신규」 = 전체 기간 최초 인용 시점이 선택 기간
 *   시작 이후 (citation-first-seen.ts 캐시). 전체 기간이면 판정하지 않는다(전부 신규가 되므로).
 *
 * 설계(소유 URL 뷰 urls/route.ts 와 동형):
 *   - SQL: runs → jsonb_array_elements(citations) 로 citation 을 행으로 펼침. 사전 필터(shared helper)
 *          + 언급 사전 필터(제목/설명 ILIKE 브랜드 용어) + 행 cap + statement_timeout.
 *          run id·url·domain·title·description·promptText·provider·createdAt 방출.
 *   - 앱단 순수함수(aggregateBrandMentionUrls): 정규화·언급 판정·소유 제외·per-run dedup·집계·keyset 페이지네이션.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import { buildBrandMentionPrefilterFast } from "@/lib/server/citation-brand-host-filter";
import {
  filterCandidateRows,
  getCitationRowsCache,
  mentionCandidateSpec,
} from "@/lib/server/citation-rows-cache";
import {
  aggregateBrandMentionUrls,
  decodeCursor,
  encodeCursor,
  safeEnvInt,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";
import {
  citationPeriodMeta,
  isCitationParamError,
  parseCitationPeriod,
  parseNewOnly,
  parseProviderParam,
} from "@/lib/server/citation-period";
import { getFirstSeenCache, lookupFirstSeen } from "@/lib/server/citation-first-seen";
import { mentionFirstSeenSpec } from "@/lib/server/citation-first-seen-loaders";
import { compressedJson } from "@/lib/server/json-compress";

export const dynamic = "force-dynamic";

/**
 * env 파생 정수 상수 — 모두 Number.isInteger + 범위 검증 후 안전 기본값 fallback (계획 Info-2).
 * 특히 STATEMENT_TIMEOUT_MS 는 raw SQL 로 인라인되므로(B-1) 정수 검증이 필수다. urls 라우트와 동일값.
 */
const MAX_LOOKBACK_DAYS = safeEnvInt(process.env.CITATION_MAX_LOOKBACK_DAYS, {
  fallback: 730,
  min: 1,
  max: 3650,
});
const CITATION_ROW_CAP = safeEnvInt(process.env.CITATION_ROW_CAP, {
  fallback: 50000,
  min: 100,
  max: 1_000_000,
});
const STATEMENT_TIMEOUT_MS = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
  fallback: 15000,
  min: 1000,
  max: 120000,
});

function parsePageSize(v: string | null): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 500);
}

/** SQL 이 방출하는 펼쳐진 행의 shape (postgres.js 결과) — 언급 뷰는 title·description 추가 */
type ExpandedRow = {
  run_id: string;
  url: string | null;
  domain: string | null;
  title: string | null;
  description: string | null;
  prompt_text: string | null;
  provider: string | null;
  created_at: string | Date;
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
  const autoOnly = sp.get("auto") !== "false";
  const brandedView = sp.get("branded") === "true";
  const pageSize = parsePageSize(sp.get("pageSize"));

  // cursor 파싱 — 값이 있는데 파싱 실패면 400
  const rawCursor = sp.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  // 기간 — from/to 없으면 all-time(상한 MAX_LOOKBACK_DAYS). 형식 오류는 400.
  const period = parseCitationPeriod(sp, { maxLookbackDays: MAX_LOOKBACK_DAYS });
  if (isCitationParamError(period)) {
    return NextResponse.json({ error: period.error }, { status: 400 });
  }
  const prov = parseProviderParam(sp);
  if (isCitationParamError(prov)) {
    return NextResponse.json({ error: prov.error }, { status: 400 });
  }
  const provider = prov.provider;
  const newOnly = parseNewOnly(sp) && !period.allTime;

  try {
    // 소유(내 사이트) 제외 판정용 브랜드 매칭 key + 언급 판정용 브랜드 용어
    const [ws] = await db
      .select({ brandConfig: schema.workspaces.brandConfig })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${id}`)
      .limit(1);
    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig?.websites));

    // 언급 사전 필터 — 인용 제목/설명에 브랜드 용어를 포함할 가능성으로 미리 좁혀 행 cap 이 브랜드
    // 언급을 잘라내지 않게 한다. 최종 정확 판정(isBrandMentionText·소유 제외)은 JS 순수함수가 유지.
    // 브랜드 용어 미등록이면 buildBrandMentionPrefilter 가 FALSE 를 반환해 0 행 방출(빈 결과).
    const brandTerms = await getBrandTermsForWorkspace(id);
    // 2026-11-06 — 제목·설명을 한 번씩만 꺼내 용어 배열과 비교(같은 의미 · 더 빠름)
    const brandMentionPrefilter = buildBrandMentionPrefilterFast(brandTerms);

    // 소유 유튜브 영상은 "내 사이트" 뷰로 가야 하므로 언급 뷰에서 제외(R5·중복 방지). 언급 뷰는 owned
    // 후보를 넓게 볼 필요가 없어 별도 유튜브 쿼리는 두지 않고, keep 의 !owned 로만 걸러낸다. 실패/빈 시 빈 Set.
    const ownedVideoIds = await getOwnedYoutubeVideoIds(id);

    const whereClause = buildRunStatsWhereClause({
      workspaceId: id,
      fromDate: period.from,
      toDate: period.to,
      autoOnly,
      brandTerms,
      branded: brandedView,
      provider: provider ?? undefined,
    });

    // 「신규」 판정용 전체 기간 최초 인용 시점 — 기간 집계와 동시에 준비. 실패해도 목록은 보여준다.
    const firstSeenP = period.allTime
      ? Promise.resolve(null)
      : getFirstSeenCache()
          .get(
            mentionFirstSeenSpec({
              workspaceId: id,
              autoOnly,
              branded: brandedView,
              brandTerms,
              brandKeySet,
              ownedVideoIds,
              brandMentionPrefilter,
            }),
          )
          .catch((err) => {
            console.error("[/stats/citations/brand-mentions] 최초 인용 시점 계산 실패:", err);
            return null;
          });

    // SET LOCAL statement_timeout 은 bind 파라미터 불가 → safeEnvInt 검증 정수를 sql.raw 로 인라인(계획 B-1).
    // ORDER BY (계획 H-1): cap 도달 시 결정적으로 같은 앞부분을 자르게 한다.
    // jsonb_typeof 가드(계획 L-1): 비배열 citations 로 인한 쿼리 파손 방지.
    // 2026-11-05 검수 M3 — 상한에 닿으면 **최근 행부터** 남긴다. 이전엔 오래된 행부터 남겨 「전체」 기간에서
    // 최근 인용이 통째로 빠졌다(최근 30일 내 사이트 인용 88개 중 33개 누락 실측). 상한이 없을 때는 순서가
    // 집계 결과를 바꾸지 않는다(집계는 순서 무관 — 처음·마지막 시각은 최솟값·최댓값).
    // 2026-11-06 — 먼저 인용 후보 행 캐시(전체 이력 · 보기별)에서 기간·모델만 메모리로 거른다.
    // 캐시를 못 쓰면 기존 SQL 경로로 답한다.
    const cachedRows = await getCitationRowsCache()
      .get(mentionCandidateSpec({ workspaceId: id, autoOnly, branded: brandedView, brandTerms, brandMentionPrefilter }))
      .then((r) => r.index)
      .catch((err) => {
        console.error("[/stats/citations/brand-mentions] 인용 후보 캐시 실패 — SQL 경로로 답함:", err);
        return null;
      });

    const expanded = cachedRows
      ? (filterCandidateRows(cachedRows, period.from, period.to, provider) as ExpandedRow[])
      : ((await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return tx.execute<ExpandedRow>(sql`
        SELECT
          ${schema.runs.id}          AS run_id,
          cite->>'url'               AS url,
          cite->>'domain'            AS domain,
          cite->>'title'             AS title,
          cite->>'description'       AS description,
          ${schema.runs.promptText}  AS prompt_text,
          ${schema.runs.provider}    AS provider,
          ${schema.runs.createdAt}   AS created_at
        FROM ${schema.runs}
        CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
        WHERE ${whereClause}
          AND jsonb_typeof(${schema.runs.citations}) = 'array'
          AND ${brandMentionPrefilter}
        ORDER BY ${schema.runs.createdAt} DESC, ${schema.runs.id} DESC
        LIMIT ${CITATION_ROW_CAP}
      `);
    })) as unknown as ExpandedRow[]);

    // 캐시 경로는 상한 없이 전체 후보를 담으므로 잘리지 않는다
    const capped = !cachedRows && expanded.length >= CITATION_ROW_CAP;

    const rows: CitationRow[] = expanded.map((r) => ({
      runId: r.run_id,
      url: r.url,
      domain: r.domain,
      title: r.title,
      description: r.description,
      promptText: r.prompt_text,
      provider: r.provider,
      createdAt: r.created_at,
    }));

    const firstSeen = await firstSeenP;
    // 검수 C4 — 신규만 보기인데 최초 인용 계산이 실패하면 거르지 않은 목록을 신규인 척 돌려주지 않는다.
    // 빈 목록 + newStatus "unavailable" 로 답하고 화면이 그 사실을 안내한다.
    if (newOnly && !firstSeen) {
      return compressedJson(req, {
        allTime: period.allTime,
        period: citationPeriodMeta(period),
        provider,
        newOnly,
        newStatus: "unavailable",
        newUrlCount: null,
        maxLookbackDays: MAX_LOOKBACK_DAYS,
        uniqueUrlCount: 0,
        invalidCitationCount: 0,
        capped: false,
        urls: [],
        nextCursor: null,
      });
    }
    const agg = aggregateBrandMentionUrls(rows, {
      brandKeySet,
      brandTerms,
      ownedVideoIds,
      pageSize,
      cursor,
      newness: firstSeen
        ? {
            firstSeenMs: (key) => lookupFirstSeen(firstSeen.index, key, provider),
            fromMs: period.from.getTime(),
            newOnly,
          }
        : undefined,
    });

    // capped 이면 cap 을 넘은 URL 은 신뢰성 있게 페이지할 수 없으므로 "더 보기"(cursor)를 잠근다 (계획 H-1).
    const nextCursor = capped || !agg.nextCursor ? null : encodeCursor(agg.nextCursor);

    return compressedJson(req, {
      allTime: period.allTime,
      period: citationPeriodMeta(period),
      provider,
      newOnly,
      // ok = 신규 판정함 / all-time = 전체 기간이라 판정 안 함 / unavailable = 계산 실패
      newStatus: period.allTime ? "all-time" : firstSeen ? "ok" : "unavailable",
      newUrlCount: agg.newUrlCount,
      maxLookbackDays: MAX_LOOKBACK_DAYS,
      uniqueUrlCount: agg.uniqueUrlCount,
      invalidCitationCount: agg.invalidCitationCount,
      capped,
      urls: agg.urls,
      nextCursor,
    });
  } catch (err) {
    // 상세 메시지는 서버 로그에만 남기고, 클라이언트에는 내부 구조가 새지 않게 일반화한다 (보안 L-1).
    console.error("[/api/workspaces/:id/stats/citations/brand-mentions] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
