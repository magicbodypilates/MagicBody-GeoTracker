/**
 * citation-filters.test.ts — 인용 출처 탭 공통 필터 규칙 (2026-11-05).
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANSWER_PERIOD,
  DEFAULT_CITATION_FILTER,
  citationAnswerParams,
  citationFilterParams,
  describeCitationAnswerPeriod,
  describeCitationFilter,
  isNewFlagAvailable,
  resolveCitationRange,
  shiftDateKey,
} from "./citation-filters";

const TODAY = "2026-11-05";

describe("citation-filters", () => {
  it("기본값은 최근 30일(오늘 포함) · 전체 모델", () => {
    expect(resolveCitationRange(DEFAULT_CITATION_FILTER, TODAY)).toEqual({ from: "2026-10-07", to: TODAY });
    expect(citationFilterParams(DEFAULT_CITATION_FILTER, TODAY)).toEqual({ from: "2026-10-07", to: TODAY });
  });

  it("7일·90일·전체", () => {
    expect(resolveCitationRange({ ...DEFAULT_CITATION_FILTER, preset: "7" }, TODAY)).toEqual({ from: "2026-10-30", to: TODAY });
    expect(resolveCitationRange({ ...DEFAULT_CITATION_FILTER, preset: "90" }, TODAY)?.from).toBe("2026-08-08");
    expect(resolveCitationRange({ ...DEFAULT_CITATION_FILTER, preset: "all" }, TODAY)).toBeNull();
    expect(isNewFlagAvailable({ ...DEFAULT_CITATION_FILTER, preset: "all" }, TODAY)).toBe(false);
  });

  it("모델·신규만 보기 — 신규만 보기는 목록 요청에만, 전체 기간이면 안 붙인다", () => {
    const f = { ...DEFAULT_CITATION_FILTER, provider: "gemini" as const, newOnly: true };
    expect(citationFilterParams(f, TODAY)).toEqual({ from: "2026-10-07", to: TODAY, provider: "gemini" });
    expect(citationFilterParams(f, TODAY, { includeNewOnly: true }).newOnly).toBe("true");
    expect(citationFilterParams({ ...f, preset: "all" }, TODAY, { includeNewOnly: true })).toEqual({ provider: "gemini" });
  });

  it("직접 선택", () => {
    const f = { ...DEFAULT_CITATION_FILTER, preset: "custom" as const, custom: { from: "2026-09-01", to: "2026-09-30" } };
    expect(citationFilterParams(f, TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(describeCitationFilter(f, TODAY)).toBe("2026-09-01 ~ 2026-09-30 · 전체 AI 모델");
  });

  it("shiftDateKey 는 월·연 경계를 넘는다", () => {
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("질문별 AI 답변 — 답변 기간 (2026-11-06)", () => {
  it("기본은 최근 7일(오늘 포함) — 탭 상단 기간과 별개", () => {
    expect(DEFAULT_ANSWER_PERIOD).toEqual({ preset: "7", custom: null });
    expect(citationAnswerParams(DEFAULT_ANSWER_PERIOD, undefined, TODAY)).toEqual({ from: "2026-10-30", to: TODAY });
  });
  it("AI 모델은 탭 상단 값을 따른다", () => {
    expect(citationAnswerParams({ preset: "30", custom: null }, "gemini", TODAY)).toEqual({
      from: "2026-10-07",
      to: TODAY,
      provider: "gemini",
    });
  });
  it("전체는 날짜를 보내지 않는다 · 직접 선택은 그 구간", () => {
    expect(citationAnswerParams({ preset: "all", custom: null }, undefined, TODAY)).toEqual({});
    expect(
      citationAnswerParams({ preset: "custom", custom: { from: "2026-09-01", to: "2026-09-10" } }, "chatgpt", TODAY),
    ).toEqual({ from: "2026-09-01", to: "2026-09-10", provider: "chatgpt" });
  });
  it("설명 문구", () => {
    expect(describeCitationAnswerPeriod(DEFAULT_ANSWER_PERIOD, undefined, TODAY)).toBe(
      "최근 7일(2026-10-30 ~ 2026-11-05) · 전체 AI 모델",
    );
  });
});
