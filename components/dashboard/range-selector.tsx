/**
 * 조회 기간 선택 버튼 — 7 / 30 / 90일 (+ 선택적으로 "직접 선택").
 *
 * AI 응답 탭(ReputationSourcesTab)·가시성 분석 탭(VisibilityAnalyticsTab)·
 * 마케팅 성과 탭(Ga4MarketingTab) 공용.
 *
 * 프리셋(7/30/90) 은 부모가 전역 runs 윈도우를 재로드하는 기존 동작 그대로다.
 *
 * "직접 선택"(시작일·종료일 지정) 은 **opt-in** 이다 — `allowCustomRange` 를 켠 호출부에서만
 * 나타난다. 켜지 않은 기존 호출부(AI 응답·마케팅 성과)는 렌더 결과가 이전과 완전히 동일하다.
 */

"use client";

import { useState } from "react";
import { toKstDateKey } from "@/lib/client/date-kst";

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

/** 직접 선택 구간 상한(일, 양끝 포함) — 서버 stats-range 상한과 일치 */
export const CUSTOM_RANGE_MAX_DAYS = 730;

export type CustomRange = { from: string; to: string };

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 양끝 포함 일수 */
function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * 직접 선택 입력값 검증 — 통과하면 null, 아니면 한글 안내 문구.
 * 화면·서버 양쪽이 같은 규칙을 쓰도록 export 한다(테스트 가능).
 */
export function validateCustomRange(
  from: string,
  to: string,
  todayKst: string,
  maxDays = CUSTOM_RANGE_MAX_DAYS,
): string | null {
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) {
    return "시작일과 종료일을 모두 선택해 주세요.";
  }
  if (from > to) return "시작일이 종료일보다 늦습니다.";
  if (to > todayKst) return "종료일은 오늘 이후로 지정할 수 없습니다.";
  if (inclusiveDays(from, to) > maxDays) {
    return `조회 구간은 최대 ${maxDays}일까지 지정할 수 있습니다.`;
  }
  return null;
}

export function RangeSelector({
  value,
  onChange,
  allowCustomRange = false,
  customRange = null,
  onCustomRangeChange,
}: {
  value: number;
  onChange: (days: number) => void;
  /** true 면 "직접 선택"(시작일·종료일) UI 를 노출. 기본 false — 기존 호출부 동작 불변 */
  allowCustomRange?: boolean;
  /** 현재 적용된 직접 선택 구간. null 이면 프리셋(7/30/90) 모드 */
  customRange?: CustomRange | null;
  /** 직접 선택 적용/해제 콜백. null 이면 프리셋 모드로 복귀 */
  onCustomRangeChange?: (range: CustomRange | null) => void;
}) {
  const customEnabled = allowCustomRange && !!onCustomRangeChange;
  const [panelOpen, setPanelOpen] = useState(false);
  // 기본값 — 종료일 = 오늘(KST), 시작일 = 30일 전 (첫 렌더에서 한 번만 계산)
  const [draftFrom, setDraftFrom] = useState(
    () => customRange?.from ?? toKstDateKey(new Date(Date.now() - 29 * DAY_MS)),
  );
  const [draftTo, setDraftTo] = useState(() => customRange?.to ?? toKstDateKey(new Date()));
  const [error, setError] = useState<string | null>(null);
  const todayKst = toKstDateKey(new Date());

  const presetActive = !customRange;

  function applyCustom() {
    const msg = validateCustomRange(draftFrom, draftTo, todayKst);
    if (msg) {
      setError(msg);
      return;
    }
    setError(null);
    onCustomRangeChange?.({ from: draftFrom, to: draftTo });
  }

  // opt-in 이 아니면 기존 마크업을 **그대로** 반환한다 (기존 호출부 픽셀 불변).
  if (!customEnabled) {
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

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-th-text-muted">조회 기간:</span>
        <div className="flex gap-0.5 rounded-lg border border-th-border bg-th-card-alt p-0.5">
          {RANGE_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                if (customEnabled) {
                  setPanelOpen(false);
                  setError(null);
                  onCustomRangeChange?.(null);
                }
                onChange(d);
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                presetActive && value === d
                  ? "bg-th-accent text-th-text-inverse shadow-sm"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
              aria-pressed={presetActive && value === d}
            >
              {d}일
            </button>
          ))}
          {customEnabled && (
            <button
              type="button"
              onClick={() => {
                // 패널을 열 때 현재 적용 구간을 초안에 반영 (effect 대신 이벤트로 동기화)
                const opening = !panelOpen;
                if (opening && customRange) {
                  setDraftFrom(customRange.from);
                  setDraftTo(customRange.to);
                }
                setPanelOpen(opening);
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                customRange
                  ? "bg-th-accent text-th-text-inverse shadow-sm"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
              aria-pressed={!!customRange}
              aria-expanded={panelOpen}
            >
              직접 선택
            </button>
          )}
        </div>
      </div>

      {customEnabled && customRange && !panelOpen && (
        <div className="text-[11px] text-th-text-muted">
          {customRange.from} ~ {customRange.to} 조회 중
        </div>
      )}

      {customEnabled && panelOpen && (
        <div className="flex flex-col gap-2 rounded-lg border border-th-border bg-th-card p-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-1 text-xs text-th-text-secondary">
              <span>시작일</span>
              <input
                type="date"
                value={draftFrom}
                max={todayKst}
                onChange={(e) => {
                  setDraftFrom(e.target.value);
                  setError(null);
                }}
                className="rounded-md border border-th-border bg-th-card-alt px-2 py-1 text-xs text-th-text"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-th-text-secondary">
              <span>종료일</span>
              <input
                type="date"
                value={draftTo}
                max={todayKst}
                onChange={(e) => {
                  setDraftTo(e.target.value);
                  setError(null);
                }}
                className="rounded-md border border-th-border bg-th-card-alt px-2 py-1 text-xs text-th-text"
              />
            </label>
            <button
              type="button"
              onClick={applyCustom}
              className="rounded-md bg-th-accent px-3 py-1 text-xs font-medium text-th-text-inverse"
            >
              적용
            </button>
            {customRange && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPanelOpen(false);
                  onCustomRangeChange?.(null);
                }}
                className="rounded-md border border-th-border px-3 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover"
              >
                해제
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="text-right text-[11px] text-th-danger">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
