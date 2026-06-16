/**
 * gsc-actionable.ts — GSC 성과를 마케팅 실행 가능한 3섹션으로 변환하는 순수함수 (LOW-4).
 *
 * 외부 의존(googleapis·next) 없는 순수 계산만 모아 단위 테스트 가능하게 분리.
 *   - 기회 검색어: 노출 p75 이상 AND CTR 사이트 평균 미만 (노출 많은데 클릭 적음)
 *   - 빠른 개선 페이지: position 5~15 구간 (1페이지 진입 직전)
 *   - 뜨는 검색어: queryDelta 기준 클릭 증가 상위
 */

export interface GscQueryStat {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscPageStat {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryDelta {
  query: string;
  currentClicks: number;
  previousClicks: number;
  delta: number;
  deltaPct: number | null;
  currentPosition: number;
  previousPosition: number;
}

export interface OpportunityQuery extends GscQueryStat {
  /** 사이트 평균 CTR 대비 부족분 (퍼센트 포인트) */
  ctrGapPct: number;
  /** 평균 CTR까지 회복 시 기대 추가 클릭 (보수적 추정) */
  potentialClicks: number;
}

export interface GscActionable {
  thresholds: {
    impressionsP75: number;
    siteAvgCtr: number;
    quickWinPositionMin: number;
    quickWinPositionMax: number;
  };
  opportunityQueries: OpportunityQuery[];
  quickWinPages: GscPageStat[];
  risingQueries: GscQueryDelta[];
}

/** 빠른 개선 페이지 순위 구간 (1페이지 진입 직전) */
export const QUICK_WIN_POSITION_MIN = 5;
export const QUICK_WIN_POSITION_MAX = 15;

/** 오름차순 정렬된 표본에서 백분위(0~100) 값. 선형 보간. 빈 배열이면 0. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/**
 * GSC 쿼리·페이지·증감 데이터에서 실행 가능 3섹션을 계산.
 * 입력은 이미 매핑된 순수 배열(외부 호출 없음). 정렬·필터·추정만 수행.
 */
export function computeActionable(input: {
  queries: GscQueryStat[];
  pages: GscPageStat[];
  queryDelta: GscQueryDelta[];
  opportunityLimit?: number;
  quickWinLimit?: number;
  risingLimit?: number;
}): GscActionable {
  const {
    queries,
    pages,
    queryDelta,
    opportunityLimit = 15,
    quickWinLimit = 15,
    risingLimit = 10,
  } = input;

  // 사이트 평균 CTR = 전체 클릭 / 전체 노출
  const totalImpressions = queries.reduce((acc, r) => acc + r.impressions, 0);
  const totalClicks = queries.reduce((acc, r) => acc + r.clicks, 0);
  const siteAvgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

  // (a) 기회 검색어: 노출 p75 이상 AND CTR 사이트 평균 미만
  const imprSortedAsc = [...queries.map((r) => r.impressions)].sort(
    (a, b) => a - b,
  );
  const imprP75 = percentile(imprSortedAsc, 75);
  const opportunityQueries: OpportunityQuery[] = queries
    .filter(
      (r) => r.impressions >= imprP75 && r.impressions > 0 && r.ctr < siteAvgCtr,
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, opportunityLimit)
    .map((r) => ({
      ...r,
      ctrGapPct: (siteAvgCtr - r.ctr) * 100,
      potentialClicks: Math.max(
        0,
        Math.round(r.impressions * (siteAvgCtr - r.ctr)),
      ),
    }));

  // (b) 빠른 개선 페이지: position 5~15 구간
  const quickWinPages = pages
    .filter(
      (r) =>
        r.position >= QUICK_WIN_POSITION_MIN &&
        r.position <= QUICK_WIN_POSITION_MAX,
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, quickWinLimit);

  // (c) 뜨는 검색어: 클릭 증가 상위
  const risingQueries = [...queryDelta]
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, risingLimit);

  return {
    thresholds: {
      impressionsP75: Math.round(imprP75),
      siteAvgCtr,
      quickWinPositionMin: QUICK_WIN_POSITION_MIN,
      quickWinPositionMax: QUICK_WIN_POSITION_MAX,
    },
    opportunityQueries,
    quickWinPages,
    risingQueries,
  };
}
