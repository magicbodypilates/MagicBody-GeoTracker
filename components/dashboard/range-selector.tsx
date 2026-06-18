/**
 * 조회 기간 선택 버튼 — 7 / 30 / 90일.
 *
 * AI 응답 탭(ReputationSourcesTab)·가시성 분석 탭(VisibilityAnalyticsTab) 공용.
 * 두 탭 모두 전역 state.runs 를 보므로, 선택 변경 시 부모(sovereign-dashboard)가
 * 해당 윈도우로 전역 runs 를 재로드한다.
 */

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

export function RangeSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-th-text-muted">조회 기간:</span>
      <div className="flex gap-0.5 rounded-lg border border-th-border bg-th-card-alt p-0.5">
        {RANGE_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onChange(d)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              value === d
                ? "bg-th-accent text-th-text-inverse shadow-sm"
                : "text-th-text-secondary hover:bg-th-card-hover"
            }`}
            aria-pressed={value === d}
          >
            {d}일
          </button>
        ))}
      </div>
    </div>
  );
}
