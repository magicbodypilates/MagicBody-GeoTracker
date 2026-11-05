/**
 * prompt-sets.ts — 질문 세트 화면 규칙 (순수 함수 · 계획 prompt-sets-plan-v2 §5·§9-1).
 *
 * 허브·자동화·AI 응답 탭이 같은 규칙으로 질문을 세트별로 묶는다:
 *   - 질문의 세트 번호가 알려진 세트면 그 세트
 *   - 번호가 없거나(0011 전 옛 코드가 넣은 질문·낙관 항목) 모르는 세트면 기존 세트
 *   - 기존 세트 객체도 없으면 「분류 전」 묶음
 * 응답(runs)은 질문 문장으로만 이어지므로, 응답의 세트 = 그 문장의 질문이 **지금** 속한 세트다(사용자 확정).
 * 목록에 없는 문장의 응답은 어느 세트에도 속하지 않는다.
 */

import type { PromptSet, TaggedPrompt } from "@/components/dashboard/types";

/** 허브 「전체」 보기 · 자동화 「모든 세트」 */
export const ALL_SETS = "all";
/** 기존 세트 객체가 없을 때 세트 번호 없는 질문을 담는 묶음 */
export const UNSORTED_KEY = "__unsorted__";
export const UNSORTED_LABEL = "분류 전";

export type SetGroup<T> = {
  /** 세트 번호 또는 UNSORTED_KEY */
  key: string;
  label: string;
  set: PromptSet | null;
  items: T[];
};

/** 세트 정렬 — 기존 세트 먼저, 그다음 만든 순서(서버와 같은 규칙). */
export function sortSets(sets: readonly PromptSet[]): PromptSet[] {
  return [...sets].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export function findDefaultSet(sets: readonly PromptSet[] | undefined): PromptSet | null {
  return sets?.find((s) => s.isDefault) ?? null;
}

/** 질문이 보이는 세트 번호 — 알려진 세트면 그대로, 아니면 기존 세트, 그것도 없으면 UNSORTED_KEY. */
export function effectiveSetId(setId: string | null | undefined, sets: readonly PromptSet[]): string {
  if (setId && sets.some((s) => s.id === setId)) return setId;
  return findDefaultSet(sets)?.id ?? UNSORTED_KEY;
}

/**
 * 질문을 세트별로 묶는다. 빈 세트도 묶음으로 낸다(세트 막대·자동화 묶음에 0개로 보여야 한다).
 * 「분류 전」 묶음은 그 안에 질문이 있을 때만 맨 뒤에 붙는다.
 */
export function groupBySet<T extends { setId?: string | null }>(
  items: readonly T[],
  sets: readonly PromptSet[],
): SetGroup<T>[] {
  const ordered = sortSets(sets);
  const groups: SetGroup<T>[] = ordered.map((s) => ({ key: s.id, label: s.name, set: s, items: [] }));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const unsorted: SetGroup<T> = { key: UNSORTED_KEY, label: UNSORTED_LABEL, set: null, items: [] };
  for (const it of items) {
    const key = effectiveSetId(it.setId, sets);
    (byKey.get(key) ?? unsorted).items.push(it);
  }
  if (unsorted.items.length > 0) groups.push(unsorted);
  return groups;
}

/** 문장 → 세트 번호 지도(켜진 질문 목록 기준). AI 응답 탭이 응답 묶음을 세트로 거를 때 쓴다. */
export function buildSetIdByPrompt(
  prompts: readonly TaggedPrompt[],
  sets: readonly PromptSet[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of prompts) map.set(p.text, effectiveSetId(p.setId, sets));
  return map;
}

/* ── AI 응답 「질문 범위」 ── */

/** "all" · "tracked"(목록에 있는 질문 전체) · "untracked"(목록에 없는 질문만) · "set:<세트 번호>" */
export type ResponseScope = string;
export const SCOPE_ALL = "all";
export const SCOPE_TRACKED = "tracked";
export const SCOPE_UNTRACKED = "untracked";
export const scopeForSet = (setId: string): ResponseScope => `set:${setId}`;

/** 저장된 범위 값이 지금도 쓸 수 있는지 — 지워진 세트면 「모든 질문」으로 돌아간다. */
export function normalizeScope(scope: string | null | undefined, validSetKeys: readonly string[]): ResponseScope {
  if (scope === SCOPE_ALL || scope === SCOPE_TRACKED || scope === SCOPE_UNTRACKED) return scope;
  if (scope && scope.startsWith("set:") && validSetKeys.includes(scope.slice(4))) return scope;
  return SCOPE_ALL;
}

/**
 * 응답(또는 응답 묶음)을 질문 범위로 거른다.
 * setIdByPrompt 는 켜진 질문 목록의 문장 → 세트 번호. 거기 없는 문장이 「목록에 없는 질문」이다.
 */
export function filterByScope<T extends { prompt: string }>(
  rows: readonly T[],
  scope: ResponseScope,
  setIdByPrompt: ReadonlyMap<string, string>,
): T[] {
  if (scope === SCOPE_ALL) return [...rows];
  if (scope === SCOPE_TRACKED) return rows.filter((r) => setIdByPrompt.has(r.prompt));
  if (scope === SCOPE_UNTRACKED) return rows.filter((r) => !setIdByPrompt.has(r.prompt));
  if (scope.startsWith("set:")) {
    const setId = scope.slice(4);
    return rows.filter((r) => setIdByPrompt.get(r.prompt) === setId);
  }
  return [...rows];
}

/* ── 허브 ── */

/** 허브에서 보고 있는 범위의 질문 — 「전체」면 전부. */
export function promptsInView<T extends { setId?: string | null }>(
  prompts: readonly T[],
  sets: readonly PromptSet[],
  viewSetId: string,
): T[] {
  if (viewSetId === ALL_SETS) return [...prompts];
  return prompts.filter((p) => effectiveSetId(p.setId, sets) === viewSetId);
}

/**
 * 허브에서 고른 보기(세트 번호·「전체」)를 지금 세트 목록에 맞춘다.
 * 저장된 값이 없거나 지워진 세트면 기존 세트, 기존 세트도 없으면 「전체」.
 */
export function normalizeHubSetId(saved: string | null | undefined, sets: readonly PromptSet[]): string {
  if (saved === ALL_SETS) return ALL_SETS;
  if (saved && sets.some((s) => s.id === saved)) return saved;
  return findDefaultSet(sets)?.id ?? ALL_SETS;
}

/** 새 질문을 넣을 세트 — 보고 있는 세트, 「전체」·모르는 값이면 기존 세트(없으면 지정 안 함 = 서버가 기존 세트로). */
export function resolveAddTargetSetId(viewSetId: string, sets: readonly PromptSet[]): string | undefined {
  if (viewSetId !== ALL_SETS && sets.some((s) => s.id === viewSetId)) return viewSetId;
  return findDefaultSet(sets)?.id;
}

/** 세트 이름 — 모르면 undefined */
export function setNameOf(setId: string | undefined, sets: readonly PromptSet[] | undefined): string | undefined {
  if (!setId || !sets) return undefined;
  return sets.find((s) => s.id === setId)?.name;
}

/**
 * 낙관 추가 — 목록 맨 앞에 넣는다. 이미 같은 문장이 있으면 그대로(서버가 alreadyInSet 으로 알려 준다).
 * 항목은 **만들 때부터** 고른 세트 번호를 갖는다(D8). 번호(id)는 서버 응답으로 채운다.
 */
export function addOptimisticPrompt(
  list: readonly TaggedPrompt[],
  text: string,
  setId: string | undefined,
): TaggedPrompt[] {
  if (list.some((p) => p.text === text)) return list as TaggedPrompt[];
  const item: TaggedPrompt = { text, tags: [] };
  if (setId) item.setId = setId;
  return [item, ...list];
}

/** 서버 응답으로 낙관 항목의 번호·세트를 채운다(이미 다른 세트에 있던 문장이면 서버의 세트로 바뀐다). */
export function applySavedPrompt(
  list: readonly TaggedPrompt[],
  saved: { text: string; id: string; setId?: string | null },
): TaggedPrompt[] {
  return list.map((p) =>
    p.text === saved.text ? { ...p, id: saved.id, ...(saved.setId ? { setId: saved.setId } : {}) } : p,
  );
}

/**
 * 자동화 탭 동기화가 서버로 다시 보낼 질문 — 서버에 없는 문장만, 그 항목의 세트 번호를 함께(D8).
 * 허브 저장이 실패해 남은 낙관 항목이 여기서 다시 보내질 때도 사용자가 고른 세트로 간다.
 */
export function buildSyncPayloads(
  customPrompts: readonly TaggedPrompt[],
  serverTexts: ReadonlySet<string>,
): { text: string; tags: string[]; setId?: string }[] {
  const out: { text: string; tags: string[]; setId?: string }[] = [];
  for (const p of customPrompts) {
    if (!p.text?.trim() || serverTexts.has(p.text)) continue;
    out.push(p.setId ? { text: p.text, tags: p.tags ?? [], setId: p.setId } : { text: p.text, tags: p.tags ?? [] });
  }
  return out;
}

/** 옮기기 결과를 화면 목록에 반영 — 옮겨진 번호만 새 세트로. */
export function applyMove(
  list: readonly TaggedPrompt[],
  movedIds: readonly string[],
  setId: string,
): TaggedPrompt[] {
  const ids = new Set(movedIds);
  return list.map((p) => (p.id && ids.has(p.id) ? { ...p, setId } : p));
}

/* ── 자동화 질문 고르기 ── */

/** 세트 묶음별 선택 수 — 「기존 세트 (선택 8/45)」 */
export function countSelected<T extends { id: string }>(items: readonly T[], selected: ReadonlySet<string>): number {
  let n = 0;
  for (const it of items) if (selected.has(it.id)) n += 1;
  return n;
}

/** 묶음 하나를 모두 고르거나 모두 푼다 — 다른 묶음의 선택은 그대로 둔다. */
export function toggleGroupSelection<T extends { id: string }>(
  selected: ReadonlySet<string>,
  items: readonly T[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const it of items) {
    if (on) next.add(it.id);
    else next.delete(it.id);
  }
  return next;
}

/** 처음 펼쳐 둘 묶음 — 고른 질문이 있는 묶음. 하나도 없으면 첫 묶음(기존 세트). */
export function initiallyExpandedKeys<T extends { id: string }>(
  groups: readonly SetGroup<T>[],
  selected: ReadonlySet<string>,
): Set<string> {
  const keys = new Set(groups.filter((g) => countSelected(g.items, selected) > 0).map((g) => g.key));
  if (keys.size === 0 && groups.length > 0) keys.add(groups[0].key);
  return keys;
}

/** 허브 보기를 브라우저에 기억하는 키 — 워크스페이스마다 따로. */
export const hubSetStorageKey = (wsId: string) => `geotracker:hub-set:${wsId}`;
/** AI 응답 「질문 범위」를 브라우저에 기억하는 키 — 워크스페이스마다 따로. */
export const responsesScopeStorageKey = (wsId: string) => `geotracker:responses-scope:${wsId}`;

/** 브라우저 저장소 읽기·쓰기 — 막혀 있어도(사생활 보호 창 등) 화면은 그대로 돈다. */
export function readStored(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeStored(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    // 저장 못 해도 이번 화면에서는 그대로 쓴다
  }
}

/* ── 검수 1회차 수정 (결함 대장 P1～P3) ── */

export type SyncRetry = "done" | "drop-set" | "same" | "give-up";

/**
 * 자동화 동기화가 질문 저장에 실패했을 때 다음 행동(P1).
 *   - 세트 문제(invalid_set·set_gone)일 때만 세트를 빼고 다시 보낸다(서버가 기존 세트로)
 *   - 잠금 대기(archive_lock_busy)는 **같은 세트로** 다시 보낸다 — 세트를 빼면 엉뚱한 세트에 들어간다
 *   - 그 밖의 400·409·500 은 다시 보내지 않는다
 */
export function syncRetryDecision(ok: boolean, errorCode: string | undefined, hadSetId: boolean): SyncRetry {
  if (ok) return "done";
  if (hadSetId && (errorCode === "invalid_set" || errorCode === "set_gone")) return "drop-set";
  if (errorCode === "archive_lock_busy") return "same";
  return "give-up";
}

/**
 * 서버 질문 목록으로 화면 목록을 맞춘다(P2) — 번호·세트는 서버 값.
 * 서버 목록에 없는 화면 항목 중 남기는 것:
 *   - 번호가 없는 낙관 항목(아직 저장 안 됨 — 자동화 탭이 다시 보낼 수 있게, D8)
 *   - 재조회가 **출발한 뒤** 화면에 생긴 항목(idsAtStart 에 없는 번호) — 재조회가 늦게 도착해도 그 사이 저장된
 *     질문을 지우지 않는다(결함 대장 N1). idsAtStart 를 주지 않으면 번호 있는 항목은 서버 목록을 따른다.
 */
export function mergeServerPrompts(
  local: readonly TaggedPrompt[],
  server: readonly TaggedPrompt[],
  idsAtStart?: ReadonlySet<string>,
): TaggedPrompt[] {
  const serverTexts = new Set(server.map((p) => p.text));
  const keep = local.filter(
    (p) => !serverTexts.has(p.text) && (!p.id || (idsAtStart !== undefined && !idsAtStart.has(p.id))),
  );
  return [...keep, ...server];
}

/** 화면에 번호 없이 남은 항목이 서버에는 이미 저장돼 있는가 — 그러면 화면을 서버와 맞춰야 한다(P2-잔여). */
export function hasUnsyncedLocalIds(
  customPrompts: readonly TaggedPrompt[],
  serverTexts: ReadonlySet<string>,
): boolean {
  return customPrompts.some((p) => !p.id && serverTexts.has(p.text));
}

export type SyncPost = (body: { text: string; tags: string[]; setId?: string }) => Promise<{ ok: boolean; code?: string }>;

/**
 * 자동화 탭의 질문 동기화 한 바퀴(P1·P2). 저장이 하나라도 성공하면 **탭을 떠났어도(cancelled)** onSaved 를
 * 한 번 부른다 — 부모(대시보드)는 남아 있고, 부르지 않으면 허브의 번호 없는 항목이 영영 남는다(P2-잔여).
 * 탭을 떠나면 다음 질문은 보내지 않는다. 반환값 = 저장 성공 수.
 */
export async function runPromptSync(opts: {
  payloads: readonly { text: string; tags: string[]; setId?: string }[];
  post: SyncPost;
  isCancelled: () => boolean;
  wait: (ms: number) => Promise<void>;
  onSaved?: () => void;
}): Promise<number> {
  let saved = 0;
  for (const payload of opts.payloads) {
    if (opts.isCancelled()) break;
    let r = await opts.post(payload);
    const next = syncRetryDecision(r.ok, r.code, !!payload.setId);
    if (next === "drop-set") r = await opts.post({ text: payload.text, tags: payload.tags });
    else if (next === "same") {
      await opts.wait(1500);
      if (!opts.isCancelled()) r = await opts.post(payload);
    }
    if (r.ok) saved += 1;
  }
  if (saved > 0) opts.onSaved?.();
  return saved;
}

/**
 * 워크스페이스를 바꾼 뒤 늦게 도착한 이전 워크스페이스 조회 결과를 버리는 표(P3).
 * 출발 때 capture(ws) → 도착 때 accept(token). 워크스페이스가 바뀌면(setCurrent) 세대가 올라간다.
 */
export type WorkspaceToken = { ws: string; gen: number };
export function createWorkspaceGuard() {
  let current: string | null = null;
  let gen = 0;
  return {
    setCurrent(ws: string | null) {
      if (ws !== current) {
        current = ws;
        gen += 1;
      }
    },
    capture(ws: string): WorkspaceToken {
      return { ws, gen };
    },
    accept(t: WorkspaceToken): boolean {
      return t.ws === current && t.gen === gen;
    },
  };
}
