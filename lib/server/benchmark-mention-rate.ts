/**
 * 경쟁사 벤치마크 언급 판정 — 우리 브랜드와 경쟁사에 **같은 기준일·같은 규칙**을 쓴다.
 *
 * 기준일 이후 응답: 본문에 용어가 있어도 주소·채널 이름·출처 칩·영상 카드 형태뿐이면 언급이
 * 아니다(brand-link-only.ts — 가시성 점수 v18a 와 같은 판정).
 * 기준일 이전 응답: 예전 기준 그대로 — 우리 브랜드는 저장된 언급 배열, 경쟁사는 저장 배열 또는
 * 본문 포함 여부.
 *
 * 순수 함수 · DB 무의존.
 */

import { hasProseBrandMention } from "@/lib/server/brand-link-only";

/** 링크만 제외 규칙 시작 시각(KST 2026-11-10 00:00) — 사장님 결정: 이날 이후 응답부터 새 기준으로 센다. */
export const LINK_ONLY_RULE_FROM_UTC = "2026-11-09T15:00:00.000Z";
const LINK_ONLY_RULE_FROM_MS = Date.parse(LINK_ONLY_RULE_FROM_UTC);

export type BenchmarkRow = {
  answer: string | null;
  createdAt: Date | string;
  brandMentions?: string[] | null;
  competitorMentions?: string[] | null;
};

export function usesLinkOnlyRule(createdAt: Date | string): boolean {
  const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(ms) && ms >= LINK_ONLY_RULE_FROM_MS;
}

/** 우리 브랜드 — 기준일 이후는 본문 규칙, 이전은 저장된 언급 배열(예전 집계와 같음). */
export function isBrandMentionedForBenchmark(row: BenchmarkRow, terms: readonly string[]): boolean {
  if (usesLinkOnlyRule(row.createdAt)) return hasProseBrandMention(row.answer, terms);
  return (row.brandMentions?.length ?? 0) > 0;
}

/** 경쟁사 — 기준일 이후는 본문 규칙, 이전은 저장 배열 또는 본문 포함(예전 매칭과 같음). */
export function isCompetitorMentionedForBenchmark(
  row: BenchmarkRow,
  terms: readonly string[],
): boolean {
  if (usesLinkOnlyRule(row.createdAt)) return hasProseBrandMention(row.answer, terms);
  const lowerTerms = terms.filter(Boolean).map((t) => t.toLowerCase());
  const targets = new Set(lowerTerms);
  if ((row.competitorMentions ?? []).some((m) => targets.has(m.toLowerCase()))) return true;
  const answerLower = (row.answer ?? "").toLowerCase();
  return lowerTerms.some((t) => answerLower.includes(t));
}

/** 본문 언급이 있는 응답 수(기준일과 무관하게 본문 규칙만). */
export function countProseMentionRuns(
  answers: readonly (string | null | undefined)[],
  terms: readonly string[],
): number {
  if (terms.length === 0) return 0;
  let n = 0;
  for (const a of answers) if (hasProseBrandMention(a, terms)) n += 1;
  return n;
}
