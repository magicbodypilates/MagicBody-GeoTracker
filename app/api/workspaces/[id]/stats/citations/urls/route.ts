/**
 * GET /api/workspaces/[id]/stats/citations/urls
 *
 * "인용 출처" 탭의 내 사이트(브랜드 공식) URL 전수 노출 뷰.
 * 전체 기간(all-time) 동안 브랜드 공식 채널 URL 이 한 번이라도 인용된 개별 페이지 URL 을
 * cursor 페이지네이션으로 전수 조회한다. 각 URL 에는 그 URL 을 인용한 프롬프트 top-N 이 inline.
 *
 * 쿼리:
 *   ?auto=true|false   (기본 true — 자동 실행만)
 *   ?branded=true|false (기본 false — 질문 유형 필터: 브랜드명 포함 검색 여부. M-6)
 *   ?pageSize=100      (기본 100, 최대 500)
 *   ?cursor=<opaque>   (keyset cursor. 없으면 첫 페이지)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD (KST, 양끝 포함 — 2026-11-05 기간 검색). 없으면 all-time
 *                      (무한 스캔 방지 상한 MAX_LOOKBACK_DAYS 만 적용)
 *   ?provider=<AI 모델> (없으면 전체 모델)
 *   ?newOnly=true      (선택 기간 안에서 처음 인용된 URL 만. 기간 지정 시에만 의미)
 *   처음·마지막 인용일은 선택 기간 안에서 계산한다. 「신규」 = 전체 기간 최초 인용 시점이 선택 기간
 *   시작 이후 (citation-first-seen.ts 캐시). 전체 기간이면 판정하지 않는다(전부 신규가 되므로).
 *
 * 설계(계획 v2 §4):
 *   - SQL: runs → jsonb_array_elements(citations) 로 citation 을 행으로 펼침. 사전 필터(shared helper)
 *          + 행 cap(CITATION_ROW_CAP) + statement_timeout. run id·url·domain·promptText·provider·createdAt 방출.
 *   - 앱단 순수함수(aggregateBrandCitationUrls): 정규화·브랜드 매칭·per-run dedup·집계·keyset 페이지네이션.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import {
  buildBrandKeyPrefilter,
  buildYoutubeVideoPrefilterFast,
} from "@/lib/server/citation-brand-host-filter";
import {
  filterCandidateRows,
  getCitationRowsCache,
  ownedCandidateSpec,
} from "@/lib/server/citation-rows-cache";
import {
  aggregateBrandCitationUrls,
  decodeCursor,
  encodeCursor,
  safeEnvInt,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";
import {
  getOwnedYoutubeVideoIds,
  getOwnedVideosMeta,
} from "@/lib/server/brand-youtube-videos";
import {
  citationPeriodMeta,
  isCitationParamError,
  parseCitationPeriod,
  parseNewOnly,
  parseProviderParam,
} from "@/lib/server/citation-period";
import { getFirstSeenCache, lookupFirstSeen } from "@/lib/server/citation-first-seen";
import { ownedFirstSeenSpec } from "@/lib/server/citation-first-seen-loaders";
import { compressedJson } from "@/lib/server/json-compress";

export const dynamic = "force-dynamic";

/**
 * env 파생 정수 상수 — 모두 Number.isInteger + 범위 검증 후 안전 기본값 fallback (계획 Info-2).
 * 특히 STATEMENT_TIMEOUT_MS 는 raw SQL 로 인라인되므로(B-1) 정수 검증이 필수다.
 */
/** 무한 스캔 방지 상한(일) — UI 엔 "전체 기간"으로 표기. env 로 조정 가능 (계획 D6). 1일~10년 */
const MAX_LOOKBACK_DAYS = safeEnvInt(process.env.CITATION_MAX_LOOKBACK_DAYS, {
  fallback: 730,
  min: 1,
  max: 3650,
});
/** SQL 이 펼쳐 방출할 최대 citation 행 수 (계획 H-3 · 위험표). 100~1,000,000 */
const CITATION_ROW_CAP = safeEnvInt(process.env.CITATION_ROW_CAP, {
  fallback: 50000,
  min: 100,
  max: 1_000_000,
});
/** all-time 스캔 상한 (ms) — SET LOCAL statement_timeout. 1초~120초 (raw SQL 인라인·B-1) */
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

/** SQL 이 방출하는 펼쳐진 행의 shape (postgres.js 결과) */
type ExpandedRow = {
  run_id: string;
  url: string | null;
  domain: string | null;
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
    // 브랜드 매칭 key (소셜은 채널 핸들까지 포함)
    const [ws] = await db
      .select({ brandConfig: schema.workspaces.brandConfig })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${id}`)
      .limit(1);
    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig?.websites));

    // 브랜드 호스트 superset 사전 필터 — 펼쳐지는 citation 을 "브랜드 도메인을 포함할 가능성" 으로 미리
    // 좁혀 행 cap 이 브랜드 인용을 잘라내지 않게 한다(실데이터 스모크 결함). 최종 정확 판정은 아래
    // aggregateBrandCitationUrls(JS 순수함수)가 그대로 수행 → 정확성 불변, cap truncation 만 제거.
    // 브랜드 URL 미등록(hosts 빈 배열)이면 buildBrandHostPrefilter 가 FALSE 를 반환해 0 행 방출(빈 결과).
    // 2026-11-06 — 호스트 대신 판정 키(일반 사이트=호스트, 소셜=호스트/채널)로 거르고, 주소를 한 번만 꺼내
    // 비교한다(buildBrandKeyPrefilter 머리말 — 90일 27,696 → 3,530줄). 최종 판정은 그대로라 상위 집합이다.
    const brandHostPrefilter = buildBrandKeyPrefilter([...brandKeySet]);
    // 유튜브 영상 superset — 브랜드 host 필터와 별도 cap 으로 뽑는다(계획 v2 §5 결정 E·H2).
    const youtubeVideoPrefilter = buildYoutubeVideoPrefilterFast();

    // 우리 소유 유튜브 영상 집합 + 신선도 메타 로드 (§5 결정 D2·§2.2). 실패/빈 시 빈 Set·stale 안전.
    const [ownedVideoIds, ownedVideos] = await Promise.all([
      getOwnedYoutubeVideoIds(id),
      getOwnedVideosMeta(id),
    ]);
    // 소유 영상이 하나도 없으면(기능 미사용 워크스페이스) 유튜브 superset 쿼리를 아예 돌리지 않는다.
    // (reviewer HIGH) 소유 0개인데도 유튜브 쿼리를 실행하면 ① 매 조회마다 쿼리 부하가 2배가 되고
    // ② cappedYoutube 가 브랜드 cursor 를 잠가 페이지네이션이 회귀한다. owned off 시엔 브랜드 단일
    // 쿼리 경로(legacy)와 결과가 바이트 단위로 동일해야 한다 → 유튜브 쿼리 skip·cappedYoutube=false·
    // 앱단 union·dedup 도 건너뛰고 브랜드 행을 그대로 사용한다.
    const ownedEnabled = ownedVideoIds.size > 0;

    const brandTerms = await getBrandTermsForWorkspace(id);
    const whereClause = buildRunStatsWhereClause({
      workspaceId: id,
      fromDate: period.from,
      toDate: period.to,
      autoOnly,
      brandTerms,
      branded: brandedView,
      provider: provider ?? undefined,
    });

    // SQL: citations 를 jsonb_array_elements 로 펼침. citation 은 파라미터화된 조건만 통과.
    // 행 cap 은 LIMIT 로, statement_timeout 은 트랜잭션 내 SET LOCAL 로 적용해 커넥션에 누수되지 않게 한다.
    //
    // 별도 cap 2쿼리(계획 v2 §5 결정 E·H2): 브랜드 host 후보와 유튜브 영상 superset 을 단일 WHERE OR 로
    // 묶으면, 데이터가 늘 때 한쪽(주로 브랜드)이 행 cap 뒤로 밀려 잘릴 수 있다. 그래서 각각 자체 LIMIT
    // 으로 뽑은 뒤 앱단에서 union·dedup 한다. 한 트랜잭션·한 SET LOCAL 로 두 쿼리를 함께 실행한다.
    //
    // SET LOCAL statement_timeout 은 bind 파라미터($1)를 못 받는다(PostgreSQL 문법 제약) → drizzle 이
    // ${STATEMENT_TIMEOUT_MS} 를 $1 로 렌더하면 런타임에 100% 실패한다(계획 B-1). 값은 위에서
    // safeEnvInt 로 정수·범위 검증을 마쳤으므로(사용자 입력 아님) sql.raw 로 정수 리터럴을 인라인한다.
    //
    // 정렬(계획 H-1): 행 cap(LIMIT)에 도달하면 어떤 앞부분을 자를지 결정적이어야 페이지 누락/중복이
    // 없다 → ORDER BY runs.created_at, runs.id 로 항상 같은 앞부분을 자르게 한다.
    // legacy 방어(계획 L-1): citations 가 배열이 아닌 legacy run 이 jsonb_array_elements 에 들어가면
    // 쿼리 전체가 깨진다 → jsonb_typeof(citations) = 'array' 가드로 비배열 run 을 미리 배제한다.
    // 2026-11-05 검수 M3 — 상한에 닿으면 **최근 행부터** 남긴다. 이전엔 오래된 행부터 남겨 「전체」 기간에서
    // 최근 인용이 통째로 빠졌다(최근 30일 내 사이트 인용 88개 중 33개 누락 실측). 상한이 없을 때는 순서가
    // 집계 결과를 바꾸지 않는다(집계는 순서 무관 — 처음·마지막 시각은 최솟값·최댓값).
    const buildExpandSql = (prefilter: typeof brandHostPrefilter) => sql`
        SELECT
          ${schema.runs.id}          AS run_id,
          cite->>'url'               AS url,
          cite->>'domain'            AS domain,
          ${schema.runs.promptText}  AS prompt_text,
          ${schema.runs.provider}    AS provider,
          ${schema.runs.createdAt}   AS created_at
        FROM ${schema.runs}
        CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
        WHERE ${whereClause}
          AND jsonb_typeof(${schema.runs.citations}) = 'array'
          AND ${prefilter}
        ORDER BY ${schema.runs.createdAt} DESC, ${schema.runs.id} DESC
        LIMIT ${CITATION_ROW_CAP}
      `;

    // 「신규」 판정용 전체 기간 최초 인용 시점 — 기간 집계와 동시에 준비한다. 실패해도 목록은 보여준다.
    const firstSeenP = period.allTime
      ? Promise.resolve(null)
      : getFirstSeenCache()
          .get(
            ownedFirstSeenSpec({
              workspaceId: id,
              autoOnly,
              branded: brandedView,
              brandTerms,
              brandKeySet,
              ownedVideoIds,
              brandHostPrefilter,
              youtubeVideoPrefilter: ownedEnabled ? youtubeVideoPrefilter : null,
            }),
          )
          .catch((err) => {
            console.error("[/stats/citations/urls] 최초 인용 시점 계산 실패:", err);
            return null;
          });

    // 두 쿼리는 서로 독립이라 각자 트랜잭션(각자 SET LOCAL)으로 **동시에** 돌린다 (2026-11-05 — 30일 기본 화면
    // 실측: 브랜드 약 0.5초 + 유튜브 약 0.2초를 순서대로 기다리던 것을 겹친다). 시간 제한·행 상한·정렬은 그대로.
    const runExpand = (prefilter: typeof brandHostPrefilter) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
        return (await tx.execute<ExpandedRow>(buildExpandSql(prefilter))) as unknown as ExpandedRow[];
      });
    // 2026-11-06 — 먼저 인용 후보 행 캐시(전체 이력 · 보기별)에서 기간·모델만 메모리로 거른다
    // (citation-rows-cache.ts). 캐시를 못 쓰면(로더 실패·행 상한 초과) 아래 기존 SQL 경로로 답한다.
    const cachedRows = await getCitationRowsCache()
      .get(
        ownedCandidateSpec({
          workspaceId: id,
          autoOnly,
          branded: brandedView,
          brandTerms,
          brandKeys: [...brandKeySet],
          brandKeyPrefilter: brandHostPrefilter,
          youtubeVideoPrefilter: ownedEnabled ? youtubeVideoPrefilter : null,
        }),
      )
      .then((r) => r.index)
      .catch((err) => {
        console.error("[/stats/citations/urls] 인용 후보 캐시 실패 — SQL 경로로 답함:", err);
        return null;
      });

    const [brandRows, youtubeRows] = cachedRows
      ? [filterCandidateRows(cachedRows, period.from, period.to, provider) as ExpandedRow[], [] as ExpandedRow[]]
      : await Promise.all([
          runExpand(brandHostPrefilter),
          // 소유 영상이 있을 때만 유튜브 superset 쿼리 실행 (owned off → skip, legacy 경로 보존).
          ownedEnabled ? runExpand(youtubeVideoPrefilter) : Promise.resolve([] as ExpandedRow[]),
        ]);

    // 각 쿼리 독립 cap 판정(관측성 — capped 원인을 분리 노출). 어느 하나라도 cap 이면 cursor 잠금.
    // owned off 면 유튜브 쿼리를 안 돌렸으므로 cappedYoutube 는 항상 false (브랜드 cursor 무영향).
    // 캐시 경로는 상한 없이 전체 후보를 담으므로 잘리지 않는다
    const cappedBrand = !cachedRows && brandRows.length >= CITATION_ROW_CAP;
    const cappedYoutube = !cachedRows && ownedEnabled && youtubeRows.length >= CITATION_ROW_CAP;
    const capped = cappedBrand || cappedYoutube;

    // 앱단 union·dedup(계획 v2 §5 결정 E ③): 브랜드에 youtube.com 이 등록된 경우 두 결과가 겹칠 수 있어
    // (run_id,url,domain) 단위로 중복을 제거한다. per-run dedup 상 count 는 멱등이지만
    // invalidCitationCount 이중계수·낭비를 막기 위해 명시 dedup.
    // owned off 면 유튜브 행이 없으므로 dedup 을 건너뛰고 브랜드 행을 그대로 써서 legacy 단일 브랜드
    // 쿼리 경로와 바이트 단위로 동일하게 한다 (dedup 로 인한 invalidCitationCount 변화 방지).
    let sourceRows: ExpandedRow[];
    if (ownedEnabled && !cachedRows) {
      const dedup = new Map<string, ExpandedRow>();
      for (const r of [...brandRows, ...youtubeRows]) {
        const key = `${r.run_id} ${r.url ?? ""} ${r.domain ?? ""}`;
        if (!dedup.has(key)) dedup.set(key, r);
      }

      sourceRows = [...dedup.values()];
    } else {
      sourceRows = brandRows;
    }

    const rows: CitationRow[] = sourceRows.map((r) => ({
      runId: r.run_id,
      url: r.url,
      domain: r.domain,
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
    const agg = aggregateBrandCitationUrls(rows, {
      brandKeySet,
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

    // capped 이면 cap 을 넘은 URL 은 신뢰성 있게 페이지할 수 없으므로 "더 보기"(cursor)를 잠근다
    // (계획 H-1). 이 페이지까지만 노출하고, UI 는 capped 안내만 보여준다.
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
      cappedBrand,
      cappedYoutube,
      // 소유 유튜브 영상 신선도(§2.2) — 화면 배지·stale 감지용
      ownedVideos,
      urls: agg.urls,
      nextCursor,
    });
  } catch (err) {
    // 상세 메시지는 서버 로그에만 남기고, 클라이언트에는 내부 구조가 새지 않게 일반화한다 (보안 L-1).
    console.error("[/api/workspaces/:id/stats/citations/urls] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
