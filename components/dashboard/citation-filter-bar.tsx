/**
 * 「인용 출처」 탭 상단 공통 필터 막대 — 기간(7/30/90일·전체·직접 선택) · AI 모델 · 신규만 보기 (2026-11-05).
 * 이 막대의 조건이 탭 안 세 덩어리(내 사이트 인용 URL · 브랜드 언급 출처 · 전체 출처 표)에 똑같이 걸린다.
 * 직접 선택 검증 규칙은 기간 선택 버튼(range-selector.tsx)의 validateCustomRange 를 그대로 쓴다.
 */

"use client";

import { useState } from "react";
import { toKstDateKey } from "@/lib/client/date-kst";
import { validateCustomRange } from "@/components/dashboard/range-selector";
import {
  CITATION_PRESET_OPTIONS,
  CITATION_PROVIDER_OPTIONS,
  describeCitationFilter,
  isNewFlagAvailable,
  shiftDateKey,
  type CitationFilter,
} from "@/components/dashboard/citation-filters";

// 휴대폰 폭에서 글자가 한 글자씩 끊기지 않게 버튼·라벨은 줄바꿈 금지(whitespace-nowrap), 넘치면 버튼 단위로
// 다음 줄로 간다(묶음 flex-wrap) — 검수 M1 (390px 캡처에서 「7/일」「직접 선/택」「기/간:」)
const btn = (active: boolean) =>
  `shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:px-3 ${
    active ? "bg-th-accent text-th-text-inverse shadow-sm" : "text-th-text-secondary hover:bg-th-card-hover"
  }`;

export function CitationFilterBar({
  value,
  onChange,
}: {
  value: CitationFilter;
  onChange: (next: CitationFilter) => void;
}) {
  const todayKst = toKstDateKey(new Date());
  const [panelOpen, setPanelOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(() => value.custom?.from ?? shiftDateKey(todayKst, -29));
  const [draftTo, setDraftTo] = useState(() => value.custom?.to ?? todayKst);
  const [error, setError] = useState<string | null>(null);
  const newAvailable = isNewFlagAvailable(value, todayKst);

  function applyCustom() {
    const msg = validateCustomRange(draftFrom, draftTo, todayKst);
    if (msg) {
      setError(msg);
      return;
    }
    setError(null);
    setPanelOpen(false);
    onChange({ ...value, preset: "custom", custom: { from: draftFrom, to: draftTo } });
  }

  return (
    <div className="rounded-xl border border-th-border bg-th-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {/* 기간 */}
        <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 whitespace-nowrap text-xs font-medium text-th-text-muted">기간:</span>
          <div className="flex flex-wrap gap-0.5 rounded-lg border border-th-border bg-th-card-alt p-0.5">
            {CITATION_PRESET_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  setPanelOpen(false);
                  setError(null);
                  // 전체 기간에는 신규 구분이 없으므로 신규만 보기를 끈다
                  onChange({ ...value, preset: o.value, custom: null, newOnly: o.value === "all" ? false : value.newOnly });
                }}
                className={btn(value.preset === o.value)}
                aria-pressed={value.preset === o.value}
              >
                {o.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                const opening = !panelOpen;
                if (opening && value.custom) {
                  setDraftFrom(value.custom.from);
                  setDraftTo(value.custom.to);
                }
                setPanelOpen(opening);
              }}
              className={btn(value.preset === "custom")}
              aria-pressed={value.preset === "custom"}
              aria-expanded={panelOpen}
            >
              직접 선택
            </button>
          </div>

          {panelOpen && (
            <div className="absolute left-0 top-full z-30 mt-2 flex w-max max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-th-border bg-th-card p-3 shadow-lg">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 whitespace-nowrap text-xs text-th-text-secondary">
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
                <label className="flex items-center gap-1 whitespace-nowrap text-xs text-th-text-secondary">
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
                  className="whitespace-nowrap rounded-md bg-th-accent px-3 py-1 text-xs font-medium text-th-text-inverse"
                >
                  적용
                </button>
              </div>
              {error && (
                <div role="alert" className="text-[11px] text-th-danger">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* AI 모델 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 whitespace-nowrap text-xs font-medium text-th-text-muted">AI 모델:</span>
          <div className="flex flex-wrap gap-0.5 rounded-lg border border-th-border bg-th-card-alt p-0.5">
            {CITATION_PROVIDER_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange({ ...value, provider: o.value })}
                className={btn(value.provider === o.value)}
                aria-pressed={value.provider === o.value}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* 신규만 보기 — 전체 기간에는 모두 신규가 되므로 숨긴다 */}
        {newAvailable && (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-th-text-secondary">
            <input
              type="checkbox"
              checked={value.newOnly}
              onChange={(e) => onChange({ ...value, newOnly: e.target.checked })}
              className="h-3.5 w-3.5 accent-current"
            />
            <span>신규만 보기</span>
          </label>
        )}
      </div>

      <p className="mt-2 text-[11px] text-th-text-muted">
        보는 범위: {describeCitationFilter(value, todayKst)}
        {newAvailable
          ? " · 「신규」는 이 기간에 처음으로 AI 답변에 인용된 주소입니다(그 전 기록에는 없음 · AI 모델을 고르면 그 모델 기준)."
          : " · 전체 기간을 볼 때는 신규 구분을 하지 않습니다."}
      </p>
    </div>
  );
}
