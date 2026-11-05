/**
 * citation-filters.ts — 「인용 출처」 탭 공통 필터(기간·AI 모델·신규만 보기)의 순수 규칙 (2026-11-05).
 *
 * 세 덩어리(내 사이트 인용 URL · 브랜드 언급 출처 · 전체 출처 표)와 각 질문 드릴다운이 **같은 조건**으로
 * 서버를 부르도록 쿼리 문자열을 한 곳에서 만든다.
 *
 * 기간은 KST 날짜(양끝 포함)로 보낸다 — 서버 parseStatsRange 와 같은 규약.
 *   7·30·90일 = 오늘(KST)을 포함한 최근 N일. 30일은 이전 화면의 응답 목록 창(오늘 포함 30일)과 같은 범위다.
 *   전체 = 날짜를 보내지 않는다(서버가 최대 보관 기간 전체를 본다). 이때는 「신규」 판정을 하지 않는다.
 */

import { PROVIDER_LABELS, VISIBLE_PROVIDERS, type Provider } from "@/components/dashboard/types";

export type CitationPeriodPreset = "7" | "30" | "90" | "all" | "custom";

export type CitationDateRange = { from: string; to: string };

export type CitationFilter = {
  preset: CitationPeriodPreset;
  /** preset = "custom" 일 때만 쓰는 구간 */
  custom: CitationDateRange | null;
  /** "all" = 전체 모델 */
  provider: "all" | Provider;
  /** 선택 기간 안에서 처음 인용된 주소만 */
  newOnly: boolean;
};

/** 처음 열었을 때 — 최근 30일 · 전체 모델 (사용자 승인 기본값) */
export const DEFAULT_CITATION_FILTER: CitationFilter = {
  preset: "30",
  custom: null,
  provider: "all",
  newOnly: false,
};

export const CITATION_PRESET_OPTIONS: Array<{ value: Exclude<CitationPeriodPreset, "custom">; label: string }> = [
  { value: "7", label: "7일" },
  { value: "30", label: "30일" },
  { value: "90", label: "90일" },
  { value: "all", label: "전체" },
];

export const CITATION_PROVIDER_OPTIONS: Array<{ value: "all" | Provider; label: string }> = [
  { value: "all", label: "전체" },
  ...VISIBLE_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] })),
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 날짜 문자열을 n 일 옮긴다 */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 선택한 기간 → KST 구간. null = 전체 기간 */
export function resolveCitationRange(filter: CitationFilter, todayKst: string): CitationDateRange | null {
  if (filter.preset === "all") return null;
  if (filter.preset === "custom") return filter.custom;
  const n = Number(filter.preset);
  return { from: shiftDateKey(todayKst, -(n - 1)), to: todayKst };
}

/** 이 필터에서 「신규」 표시·신규만 보기를 쓸 수 있는가 — 전체 기간이면 전부 신규가 되므로 숨긴다 */
export function isNewFlagAvailable(filter: CitationFilter, todayKst: string): boolean {
  return resolveCitationRange(filter, todayKst) !== null;
}

/**
 * 서버 쿼리 — 세 덩어리·드릴다운 공통. 신규만 보기는 목록 요청에만 붙인다(includeNewOnly).
 */
export function citationFilterParams(
  filter: CitationFilter,
  todayKst: string,
  opts: { includeNewOnly?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const range = resolveCitationRange(filter, todayKst);
  if (range) {
    out.from = range.from;
    out.to = range.to;
  }
  if (filter.provider !== "all") out.provider = filter.provider;
  if (opts.includeNewOnly && range && filter.newOnly) out.newOnly = "true";
  return out;
}

/** 화면에 보이는 기간·모델 설명 — 예: "최근 30일(2026-10-07 ~ 2026-11-05) · 전체 모델" */
export function describeCitationFilter(filter: CitationFilter, todayKst: string): string {
  const range = resolveCitationRange(filter, todayKst);
  const periodText = !range
    ? "전체 기간"
    : filter.preset === "custom"
      ? `${range.from} ~ ${range.to}`
      : `최근 ${filter.preset}일(${range.from} ~ ${range.to})`;
  const modelText =
    filter.provider === "all" ? "전체 AI 모델" : PROVIDER_LABELS[filter.provider as Provider] ?? filter.provider;
  return `${periodText} · ${modelText}`;
}

/** 요청을 구분하는 짧은 문자열 — 필터가 바뀌면 목록 행 상태(펼침·추가 질문)를 새로 시작하게 key 로 쓴다 */
export function citationFilterKey(filter: CitationFilter, todayKst: string): string {
  return JSON.stringify(citationFilterParams(filter, todayKst, { includeNewOnly: true }));
}
