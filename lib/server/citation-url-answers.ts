/**
 * citation-url-answers.ts — 「이 URL 을 인용한 질문」 한 줄을 펼쳤을 때 보여 줄 **AI 답변 찾기** 순수함수
 * (2026-11-06 — 질문별 AI 답변 보기). DB·Next 무의존.
 *
 * 무엇을 찾나: 그 질문(promptText)에 대해 AI 가 답한 응답 중 **이 URL(canonicalUrlKey)을 인용한 응답**.
 * 질문 줄의 「N회」 숫자와 같은 판정을 써야 두 숫자가 어긋나지 않으므로, 질문 집계(aggregatePromptsCore)와
 * 똑같이 한 줄씩 ① 소유 유튜브 영상 치환(resolveOwned) → ② 주소 정규화(normalizeCitationUrl) →
 * ③ 대상 key 일치 → ④ 보기별 포함 판정(ownedViewKeep / mentionViewKeep) → ⑤ 질문 문구 일치(normalizePromptText)
 * 를 거친 뒤 **응답(run) 단위로 한 번만** 센다(같은 응답이 같은 주소를 두 번 인용해도 1).
 *
 * 정렬은 최신순(created_at 내림차순 · 같은 시각이면 run id 내림차순)이고, 쪽 넘김은 그 순서의
 * keyset cursor(시각 ms, run id)로 한다 — 새 응답이 들어와도 이미 본 쪽이 밀리지 않는다.
 */

import { createHash } from "node:crypto";
import {
  mentionViewKeep,
  normalizeCitationUrl,
  normalizePromptText,
  ownedViewKeep,
  resolveOwned,
  UNKNOWN_PROVIDER,
  type CitationKeepFn,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";

/** 답변 목록의 한 응답 (본문은 라우트가 이 id 로 따로 읽는다) */
export type AnswerRunRef = {
  runId: string;
  createdAtMs: number;
  provider: string;
};

/** 답변 목록 쪽 넘김 cursor — (시각 ms, run id) */
export type AnswerCursor = { t: number; r: string };

/** 한 번에 보여 줄 답변 수 기본값 · 최대값 */
export const DEFAULT_ANSWER_PAGE_SIZE = 10;
export const MAX_ANSWER_PAGE_SIZE = 50;

/**
 * 질문 식별 — 문구 그대로(promptText) 또는 정규화한 문구의 SHA-256 16진수(promptHash).
 * 긴 질문은 주소창 길이 한도에 걸리므로 화면은 해시로 보낸다(검수 A-C3). 해시 대상은 질문 집계가 쓰는
 * 정규화 결과(normalizePromptText)이고, 화면이 받은 질문 문구는 이미 그 결과다.
 */
export type PromptSelector = { promptText: string } | { promptHash: string };

export function hashPromptText(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function isPromptHash(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/** 질문 문구(정규화 전) → 대상 질문인가. 해시는 문구별로 한 번만 계산한다 */
export function promptMatcher(sel: PromptSelector): (rawPrompt: string | null | undefined) => boolean {
  if ("promptText" in sel) {
    const wanted = normalizePromptText(sel.promptText);
    return (raw) => normalizePromptText(raw) === wanted;
  }
  const memo = new Map<string, boolean>();
  return (raw) => {
    const n = normalizePromptText(raw);
    let hit = memo.get(n);
    if (hit === undefined) {
      hit = hashPromptText(n) === sel.promptHash;
      memo.set(n, hit);
    }
    return hit;
  };
}

/** 살아 있는(보관되지 않은) 응답만 남긴다 — 순서 유지 (검수 A-C1) */
export function keepLiveAnswerRuns(list: readonly AnswerRunRef[], live: ReadonlySet<string>): AnswerRunRef[] {
  return list.filter((a) => live.has(a.runId));
}

function toMs(v: string | Date): number {
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 최신순 비교 — 시각 내림차순, 같으면 run id 내림차순 */
export function compareAnswerRun(a: AnswerRunRef, b: AnswerRunRef): number {
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
}

/**
 * 대상 URL·질문에 해당하는 응답(run) 목록 — 응답 단위 중복 제거 후 최신순.
 * rows 는 기간·AI 모델로 이미 거른 후보 행이다(집계와 같은 입력).
 */
export function collectAnswerRuns(
  rows: readonly CitationRow[],
  targetCanonicalUrlKey: string,
  prompt: string | PromptSelector,
  opts: { keep: CitationKeepFn; ownedVideoIds?: Set<string> },
): AnswerRunRef[] {
  const matches = promptMatcher(typeof prompt === "string" ? { promptText: prompt } : prompt);
  const byRun = new Map<string, AnswerRunRef>();
  for (const row of rows) {
    if (byRun.has(row.runId)) continue;
    if (!matches(row.promptText)) continue;
    const raw = row.url || row.domain || "";
    const { owned, effectiveRaw } = resolveOwned(raw, opts.ownedVideoIds);
    const norm = normalizeCitationUrl(effectiveRaw);
    if (!norm) continue;
    if (norm.canonicalUrlKey !== targetCanonicalUrlKey) continue;
    if (!opts.keep(row, norm, owned)) continue;
    const provider = (row.provider ?? "").trim() || UNKNOWN_PROVIDER;
    byRun.set(row.runId, { runId: row.runId, createdAtMs: toMs(row.createdAt), provider });
  }
  return [...byRun.values()].sort(compareAnswerRun);
}

/** 내 사이트 인용 URL 보기 — 목록·질문 집계와 같은 포함 판정 */
export function collectOwnedAnswerRuns(
  rows: readonly CitationRow[],
  targetCanonicalUrlKey: string,
  prompt: string | PromptSelector,
  opts: { brandKeySet: Set<string>; ownedVideoIds?: Set<string> },
): AnswerRunRef[] {
  return collectAnswerRuns(rows, targetCanonicalUrlKey, prompt, {
    keep: ownedViewKeep(opts.brandKeySet),
    ownedVideoIds: opts.ownedVideoIds,
  });
}

/** 브랜드 언급 출처 보기 — 목록·질문 집계와 같은 포함 판정 */
export function collectMentionAnswerRuns(
  rows: readonly CitationRow[],
  targetCanonicalUrlKey: string,
  prompt: string | PromptSelector,
  opts: { brandKeySet: Set<string>; brandTerms: string[]; ownedVideoIds?: Set<string> },
): AnswerRunRef[] {
  return collectAnswerRuns(rows, targetCanonicalUrlKey, prompt, {
    keep: mentionViewKeep(opts.brandKeySet, opts.brandTerms, opts.ownedVideoIds),
    ownedVideoIds: opts.ownedVideoIds,
  });
}

/** 정렬된 목록에서 cursor 다음 항목의 위치 */
function firstIndexAfter(sorted: readonly AnswerRunRef[], cursor: AnswerCursor): number {
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.createdAtMs < cursor.t) return i;
    if (a.createdAtMs === cursor.t && a.runId < cursor.r) return i;
  }
  return sorted.length;
}

/** 한 쪽 자르기 — 다음 쪽이 있으면 cursor 를 돌려준다 */
export function pageAnswerRuns(
  sorted: readonly AnswerRunRef[],
  opts: { pageSize: number; cursor: AnswerCursor | null },
): { page: AnswerRunRef[]; nextCursor: AnswerCursor | null } {
  const start = opts.cursor ? firstIndexAfter(sorted, opts.cursor) : 0;
  const page = sorted.slice(start, start + opts.pageSize);
  const hasMore = start + opts.pageSize < sorted.length;
  const last = page[page.length - 1];
  return { page, nextCursor: hasMore && last ? { t: last.createdAtMs, r: last.runId } : null };
}

/** AI 모델별 답변 수 — 화면 머리말·검증용. 이름순 */
export function countAnswerProviders(list: readonly AnswerRunRef[]): Array<{ provider: string; count: number }> {
  const m = new Map<string, number>();
  for (const a of list) m.set(a.provider, (m.get(a.provider) ?? 0) + 1);
  return [...m.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
}

export function parseAnswerPageSize(v: string | null): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ANSWER_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_ANSWER_PAGE_SIZE);
}

export function encodeAnswerCursor(c: AnswerCursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, r: c.r }), "utf8").toString("base64url");
}

/** 형식이 틀리면 null (라우트가 400 으로 답한다) */
export function decodeAnswerCursor(raw: string | null | undefined): AnswerCursor | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      p &&
      typeof p === "object" &&
      typeof (p as AnswerCursor).t === "number" &&
      Number.isFinite((p as AnswerCursor).t) &&
      typeof (p as AnswerCursor).r === "string" &&
      (p as AnswerCursor).r.length > 0
    ) {
      return { t: (p as AnswerCursor).t, r: (p as AnswerCursor).r };
    }
    return null;
  } catch {
    return null;
  }
}
