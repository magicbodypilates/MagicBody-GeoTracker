/**
 * response-archive-utils.ts — 응답 보관 화면의 문구·표시 조립(순수 함수).
 * 계획 geotracker-response-archive-260924 §5-3 의 확인 창·안내 문구를 그대로 쓴다.
 *
 * 화면(AI 응답 탭·보관함 패널)과 대시보드 핸들러가 같은 문구를 쓰도록 한 곳에 둔다.
 */

import { toKstDateKey } from "@/lib/client/date-kst";

/** 확인 창·안내에 넣는 문구 — 40자 넘으면 줄임표. */
export function shortPromptLabel(text: string, max = 40): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

const ARCHIVE_EFFECT_LINES = [
  "옮긴 응답은 AI 응답 목록과 홈·가시성·인용 통계에서 빠집니다.",
  "보관함에서 언제든 되돌릴 수 있습니다.",
];

/** 보관(질문 1개) 확인 창. */
export function buildArchiveConfirm(promptText: string): string {
  return [
    `'${shortPromptLabel(promptText)}'`,
    "",
    "이 질문의 응답을 모두 보관함으로 옮길까요? (자동·수동, 기간 구분 없이 전부)",
    ...ARCHIVE_EFFECT_LINES,
  ].join("\n");
}

/** 모두 보관(보관함 ①) 확인 창 — 숫자는 보관함 ①의 전체 질문·응답 수. */
export function buildBulkArchiveConfirm(questions: number, runs: number): string {
  return [
    `질문 ${questions}개의 응답 ${runs}건을 모두 보관함으로 옮길까요?`,
    "화면에 다 보이지 않는 질문도 포함합니다. 이 목록을 불러온 뒤 새로 생긴 응답은 옮기지 않습니다.",
    ...ARCHIVE_EFFECT_LINES,
  ].join("\n");
}

/** 영구 삭제 확인 창 — runCount 가 없으면(AI 응답 탭) 건수 대신 「모두」. */
export function buildPurgeConfirm(promptText: string, runCount?: number | null): string {
  const ask =
    typeof runCount === "number"
      ? `이 질문의 응답 ${runCount}건을 영구 삭제할까요?`
      : "이 질문의 응답을 모두 영구 삭제할까요?";
  return [`'${shortPromptLabel(promptText)}'`, "", ask, "삭제하면 되돌릴 수 없습니다."].join("\n");
}

/** 기간 표시 — KST 날짜 「2026-08-01 ～ 2026-09-20」, 같은 날이면 하루만. */
export function formatArchivePeriod(firstAt: string, lastAt: string): string {
  const a = toKstDateKey(firstAt);
  const b = toKstDateKey(lastAt);
  if (!a && !b) return "";
  if (!a || !b || a === b) return a || b;
  return `${a} ～ ${b}`;
}

/** 응답 건수 표시 — 「응답 12건 (자동 10 · 수동 2)」 */
export function formatArchiveRunCounts(runCount: number, autoCount: number, manualCount: number): string {
  return `응답 ${runCount}건 (자동 ${autoCount} · 수동 ${manualCount})`;
}

/** 질문 묶음을 질문 목록에 있는 것·없는 것으로 나눈다(문구 정확 일치 — 서버와 같은 기준). */
export function splitTrackedGroups<T extends { prompt: string }>(
  groups: readonly T[],
  trackedPrompts: readonly string[],
): { tracked: T[]; untracked: T[] } {
  const set = new Set(trackedPrompts);
  const tracked: T[] = [];
  const untracked: T[] = [];
  for (const g of groups) (set.has(g.prompt) ? tracked : untracked).push(g);
  return { tracked, untracked };
}

/* ── 끝난 뒤 안내 ── */

export function archiveDoneMessage(affectedRuns: number, skippedInList: readonly string[] = []): string {
  const base = `응답 ${affectedRuns}건을 보관함으로 옮겼습니다.`;
  return skippedInList.length > 0 ? `${base} 질문 목록에 있는 질문 ${skippedInList.length}개는 옮기지 않았습니다.` : base;
}

export function restoreDoneMessage(affectedRuns: number): string {
  return `응답 ${affectedRuns}건을 되돌렸습니다. 통계에 다시 들어갑니다.`;
}

export function purgeDoneMessage(affectedRuns: number): string {
  return `응답 ${affectedRuns}건을 영구 삭제했습니다.`;
}

export function readdRestoredMessage(restoredRuns: number): string {
  return `추적 프롬프트가 추가되었습니다. 보관함에 있던 이 질문의 응답 ${restoredRuns}건도 함께 되돌렸습니다.`;
}
