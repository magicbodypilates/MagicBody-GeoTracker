/**
 * gsc-actionable.test.ts — GSC 마케팅 actionable 3섹션 순수함수 단위 테스트.
 *
 * 계획 geotracker-ai-data-pipeline-v2 단계5(R5) Hard Gate + §6 테스트 케이스 MED-7:
 *   ⑦ GSC empty data + actionable threshold(LOW-4) 검증.
 * 행동 기반(입력→기대 출력). 외부 의존 없음(순수함수) — mock 불필요.
 */

import { describe, it, expect } from "vitest";
import {
  percentile,
  computeActionable,
  QUICK_WIN_POSITION_MIN,
  QUICK_WIN_POSITION_MAX,
  type GscQueryStat,
  type GscPageStat,
  type GscQueryDelta,
} from "@/lib/server/gsc-actionable";

describe("percentile (선형 보간)", () => {
  it("빈 배열 → 0", () => {
    expect(percentile([], 75)).toBe(0);
  });
  it("단일 원소 → 그 값", () => {
    expect(percentile([42], 75)).toBe(42);
  });
  it("p100 → 최대값, p0 → 최소값", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(5);
  });
  it("p50 → 중앙값", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });
  it("p75 보간 (1..5 → 4)", () => {
    expect(percentile([1, 2, 3, 4, 5], 75)).toBe(4);
  });
});

function q(
  query: string,
  impressions: number,
  clicks: number,
  position = 10,
): GscQueryStat {
  return {
    query,
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position,
  };
}

describe("computeActionable — 빈 데이터 (GSC empty)", () => {
  it("모든 입력 빈 배열이면 빈 섹션 + 안전한 threshold", () => {
    const a = computeActionable({ queries: [], pages: [], queryDelta: [] });
    expect(a.opportunityQueries).toEqual([]);
    expect(a.quickWinPages).toEqual([]);
    expect(a.risingQueries).toEqual([]);
    expect(a.thresholds.siteAvgCtr).toBe(0);
    expect(a.thresholds.impressionsP75).toBe(0);
    expect(a.thresholds.quickWinPositionMin).toBe(QUICK_WIN_POSITION_MIN);
    expect(a.thresholds.quickWinPositionMax).toBe(QUICK_WIN_POSITION_MAX);
  });
});

describe("computeActionable — 기회 검색어 (노출 p75↑ AND CTR 평균↓)", () => {
  it("노출 높고 CTR 낮은 검색어만 선별 + 기대 추가 클릭 계산", () => {
    // 사이트 평균 CTR 계산: 총클릭/총노출
    const queries: GscQueryStat[] = [
      q("high-impr-low-ctr", 1000, 5), // 0.5% — 노출 최상위, CTR 낮음 → 기회
      q("high-impr-high-ctr", 900, 200), // 22% — 노출 높지만 CTR 높음 → 제외
      q("low-impr", 10, 0), // 노출 낮음 → p75 미만 제외
      q("mid", 100, 3),
    ];
    const a = computeActionable({ queries, pages: [], queryDelta: [] });

    const picked = a.opportunityQueries.map((r) => r.query);
    expect(picked).toContain("high-impr-low-ctr");
    expect(picked).not.toContain("high-impr-high-ctr"); // CTR 평균 이상
    expect(picked).not.toContain("low-impr"); // 노출 p75 미만

    const opp = a.opportunityQueries.find(
      (r) => r.query === "high-impr-low-ctr",
    )!;
    // 기대 추가 클릭 = 노출 × (평균CTR − 현재CTR), 음수면 0
    expect(opp.potentialClicks).toBeGreaterThan(0);
    expect(opp.ctrGapPct).toBeGreaterThan(0);
  });

  it("CTR이 0인 노출 검색어도 평균보다 낮으면 기회로 포착", () => {
    const queries: GscQueryStat[] = [
      q("zero-ctr-high-impr", 500, 0),
      q("a", 500, 50),
      q("b", 400, 40),
      q("c", 300, 30),
    ];
    const a = computeActionable({ queries, pages: [], queryDelta: [] });
    expect(a.opportunityQueries.some((r) => r.query === "zero-ctr-high-impr")).toBe(
      true,
    );
  });
});

describe("computeActionable — 빠른 개선 페이지 (position 5~15)", () => {
  it("순위 5~15 구간 페이지만, 노출 내림차순", () => {
    const pages: GscPageStat[] = [
      { page: "/p-rank3", clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
      { page: "/p-rank7", clicks: 5, impressions: 300, ctr: 0.016, position: 7 },
      { page: "/p-rank12", clicks: 3, impressions: 500, ctr: 0.006, position: 12 },
      { page: "/p-rank20", clicks: 1, impressions: 50, ctr: 0.02, position: 20 },
    ];
    const a = computeActionable({ queries: [], pages, queryDelta: [] });
    const picked = a.quickWinPages.map((p) => p.page);
    expect(picked).toEqual(["/p-rank12", "/p-rank7"]); // 노출 내림차순, 5~15만
    expect(picked).not.toContain("/p-rank3");
    expect(picked).not.toContain("/p-rank20");
  });

  it("경계값 포함 (position 정확히 5, 15)", () => {
    const pages: GscPageStat[] = [
      { page: "/exact5", clicks: 2, impressions: 200, ctr: 0.01, position: 5 },
      { page: "/exact15", clicks: 1, impressions: 100, ctr: 0.01, position: 15 },
    ];
    const a = computeActionable({ queries: [], pages, queryDelta: [] });
    expect(a.quickWinPages.map((p) => p.page).sort()).toEqual([
      "/exact15",
      "/exact5",
    ]);
  });
});

describe("computeActionable — 뜨는 검색어 (delta 양수 상위)", () => {
  it("클릭 증가 검색어만 delta 내림차순, 감소·동일 제외", () => {
    const queryDelta: GscQueryDelta[] = [
      d("rising-big", 50, 10), // +40
      d("rising-small", 12, 10), // +2
      d("falling", 3, 20), // -17 제외
      d("flat", 5, 5), // 0 제외
    ];
    const a = computeActionable({ queries: [], pages: [], queryDelta });
    expect(a.risingQueries.map((r) => r.query)).toEqual([
      "rising-big",
      "rising-small",
    ]);
  });
});

function d(
  query: string,
  currentClicks: number,
  previousClicks: number,
): GscQueryDelta {
  const delta = currentClicks - previousClicks;
  return {
    query,
    currentClicks,
    previousClicks,
    delta,
    deltaPct: previousClicks > 0 ? (delta / previousClicks) * 100 : null,
    currentPosition: 8,
    previousPosition: 9,
  };
}
