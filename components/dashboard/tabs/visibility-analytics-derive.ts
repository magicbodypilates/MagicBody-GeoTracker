/**
 * visibility-analytics-derive.ts — 가시성 분석 탭의 파생 계산 순수함수.
 *
 * 화면 컴포넌트 안에 있으면 확인할 방법이 브라우저밖에 없어서, 검수에서 지적된 두 규칙
 * (CSV 구간 자르기·빈 날 선 끊기)을 순수함수로 빼 단위 테스트로 고정한다.
 */

import { toKstDateKey } from "@/lib/client/date-kst";

/** 자르기에 필요한 최소 형태 — ScrapeRun 의 부분집합 */
type HasCreatedAt = { createdAt: string };

/**
 * runs 를 **KST 일자 기준** 조회 구간(양끝 포함)으로 자른다.
 *
 * 화면은 서버 집계를 보지만 CSV 는 브라우저가 들고 있는 runs 원본으로 만든다. runs 는
 * 전역 윈도우(최근 N일)로 로드되므로 자르지 않으면 화면보다 넓은 파일이 내려간다(M2).
 */
export function sliceRunsByKstRange<T extends HasCreatedAt>(
  runs: T[],
  fromKey: string,
  toKey: string,
): T[] {
  return runs.filter((r) => {
    const key = toKstDateKey(r.createdAt);
    return key >= fromKey && key <= toKey;
  });
}

export type TrendPoint = { day: string; visibility: number | null };

/**
 * 전체 평균 추이 시리즈 — 축을 `days` 로 맞추고 실행이 없는 날은 null 로 채운다.
 *
 * 모델별 차트가 `connectNulls={false}` 로 선을 끊으므로 전체 평균도 같은 규칙을 써야
 * 두 차트의 빈 구간이 어긋나지 않는다(m7). `days` 가 비면 값이 있는 날만 오름차순으로 쓴다.
 */
export function buildTrendSeries(
  days: string[] | undefined,
  totals: Array<{ date: string; avgVisibility: number; avgVisibilityRaw?: number }> | undefined,
): TrendPoint[] {
  const byDay = new Map<string, number>();
  for (const t of totals ?? []) {
    byDay.set(t.date, Math.round(t.avgVisibilityRaw ?? t.avgVisibility));
  }
  const axis = days?.length
    ? days
    : [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  return axis.map((day) => ({ day, visibility: byDay.get(day) ?? null }));
}
