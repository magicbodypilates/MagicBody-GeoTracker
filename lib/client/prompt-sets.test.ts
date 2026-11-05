/**
 * prompt-sets.test.ts — 질문 세트 화면 규칙 (계획 prompt-sets-plan-v2 §9-1).
 * ⚠️ PUBLIC 저장소 — 질문 문구는 가짜 값이다.
 */

import { describe, it, expect } from "vitest";
import type { PromptSet, TaggedPrompt } from "@/components/dashboard/types";
import {
  ALL_SETS,
  SCOPE_ALL,
  SCOPE_TRACKED,
  SCOPE_UNTRACKED,
  UNSORTED_KEY,
  addOptimisticPrompt,
  applyMove,
  applySavedPrompt,
  buildSetIdByPrompt,
  buildSyncPayloads,
  countSelected,
  createWorkspaceGuard,
  effectiveSetId,
  filterByScope,
  groupBySet,
  hasUnsyncedLocalIds,
  initiallyExpandedKeys,
  mergeServerPrompts,
  normalizeHubSetId,
  normalizeScope,
  promptsInView,
  resolveAddTargetSetId,
  runPromptSync,
  scopeForSet,
  syncRetryDecision,
  toggleGroupSelection,
} from "./prompt-sets";

const DEF: PromptSet = { id: "d", name: "기존 세트", isDefault: true, createdAt: "2026-11-06T00:00:00Z", activePromptCount: 0 };
const NEW: PromptSet = { id: "n", name: "새 세트", isDefault: false, createdAt: "2026-11-06T01:00:00Z", activePromptCount: 0 };
const EMPTY: PromptSet = { id: "e", name: "빈 세트", isDefault: false, createdAt: "2026-11-06T02:00:00Z", activePromptCount: 0 };
const SETS = [EMPTY, NEW, DEF]; // 순서를 섞어 둔다 — 정렬은 함수가 한다

const P = (text: string, setId?: string, id?: string): TaggedPrompt => ({ text, tags: [], ...(setId ? { setId } : {}), ...(id ? { id } : {}) });

describe("세트별 묶기", () => {
  it("기존 세트 먼저·만든 순서 · 빈 세트도 묶음으로 낸다", () => {
    const g = groupBySet([P("가", "d"), P("나", "n")], SETS);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([
      ["d", 1],
      ["n", 1],
      ["e", 0],
    ]);
  });

  it("세트 번호가 없거나 모르는 세트면 기존 세트 묶음", () => {
    const g = groupBySet([P("번호 없음"), P("모르는 세트", "zzz")], SETS);
    expect(g[0].key).toBe("d");
    expect(g[0].items.map((x) => x.text)).toEqual(["번호 없음", "모르는 세트"]);
    expect(g.find((x) => x.key === UNSORTED_KEY)).toBeUndefined();
  });

  it("기존 세트 객체도 없으면 「분류 전」 묶음을 맨 뒤에", () => {
    const g = groupBySet([P("번호 없음"), P("새", "n")], [NEW]);
    expect(g.map((x) => [x.key, x.label, x.items.length])).toEqual([
      ["n", "새 세트", 1],
      [UNSORTED_KEY, "분류 전", 1],
    ]);
  });

  it("effectiveSetId — 알려진 세트 / 기존 세트 / 분류 전", () => {
    expect(effectiveSetId("n", SETS)).toBe("n");
    expect(effectiveSetId(undefined, SETS)).toBe("d");
    expect(effectiveSetId("zzz", [NEW])).toBe(UNSORTED_KEY);
  });
});

describe("AI 응답 질문 범위", () => {
  const prompts = [P("기존 질문", "d"), P("옮긴 질문", "n"), P("번호 없는 질문")];
  const map = buildSetIdByPrompt(prompts, SETS);
  const runs = [
    { prompt: "기존 질문" },
    { prompt: "옮긴 질문" },
    { prompt: "번호 없는 질문" },
    { prompt: "목록에 없는 질문" },
  ];

  it("문장 → 세트 지도 — 번호 없는 질문은 기존 세트", () => {
    expect(Object.fromEntries(map)).toEqual({ "기존 질문": "d", "옮긴 질문": "n", "번호 없는 질문": "d" });
  });

  it("범위 5종", () => {
    const pick = (scope: string) => filterByScope(runs, scope, map).map((r) => r.prompt);
    expect(pick(SCOPE_ALL)).toHaveLength(4);
    expect(pick(SCOPE_TRACKED)).toEqual(["기존 질문", "옮긴 질문", "번호 없는 질문"]);
    expect(pick(SCOPE_UNTRACKED)).toEqual(["목록에 없는 질문"]);
    expect(pick(scopeForSet("d"))).toEqual(["기존 질문", "번호 없는 질문"]);
    expect(pick(scopeForSet("n"))).toEqual(["옮긴 질문"]);
    expect(pick(scopeForSet("e"))).toEqual([]);
  });

  it("질문을 옮기면 과거 응답도 지금 세트에서 보인다(이동 후 재계산)", () => {
    const moved = applyMove([P("기존 질문", "d", "id1"), P("옮긴 질문", "n", "id2")], ["id1"], "n");
    const map2 = buildSetIdByPrompt(moved, SETS);
    expect(filterByScope(runs, scopeForSet("n"), map2).map((r) => r.prompt)).toEqual(["기존 질문", "옮긴 질문"]);
    expect(filterByScope(runs, scopeForSet("d"), map2)).toEqual([]);
  });

  it("저장된 범위가 지워진 세트면 「모든 질문」", () => {
    expect(normalizeScope("set:n", ["d", "n"])).toBe("set:n");
    expect(normalizeScope("set:gone", ["d", "n"])).toBe(SCOPE_ALL);
    expect(normalizeScope("untracked", [])).toBe(SCOPE_UNTRACKED);
    expect(normalizeScope(null, [])).toBe(SCOPE_ALL);
  });
});

describe("허브", () => {
  it("보기 — 세트만 / 전체", () => {
    const list = [P("a", "d"), P("b", "n"), P("c")];
    expect(promptsInView(list, SETS, "n").map((p) => p.text)).toEqual(["b"]);
    expect(promptsInView(list, SETS, "d").map((p) => p.text)).toEqual(["a", "c"]);
    expect(promptsInView(list, SETS, ALL_SETS)).toHaveLength(3);
  });

  it("처음엔 기존 세트, 기억한 세트가 지워졌으면 기존 세트, 「전체」는 그대로", () => {
    expect(normalizeHubSetId(null, SETS)).toBe("d");
    expect(normalizeHubSetId("n", SETS)).toBe("n");
    expect(normalizeHubSetId("gone", SETS)).toBe("d");
    expect(normalizeHubSetId(ALL_SETS, SETS)).toBe(ALL_SETS);
    expect(normalizeHubSetId(null, [])).toBe(ALL_SETS);
  });

  it("넣을 세트 — 보고 있는 세트, 「전체」면 기존 세트", () => {
    expect(resolveAddTargetSetId("n", SETS)).toBe("n");
    expect(resolveAddTargetSetId(ALL_SETS, SETS)).toBe("d");
    expect(resolveAddTargetSetId("gone", SETS)).toBe("d");
    expect(resolveAddTargetSetId(ALL_SETS, [])).toBeUndefined();
  });
});

describe("낙관 추가와 자동화 재동기화 (D8)", () => {
  it("낙관 항목은 만들 때부터 고른 세트를 갖고, 번호는 응답으로 채운다", () => {
    const list = addOptimisticPrompt([P("있던 질문", "d", "id0")], "새 질문", "n");
    expect(list[0]).toEqual({ text: "새 질문", tags: [], setId: "n" });
    const saved = applySavedPrompt(list, { text: "새 질문", id: "id9", setId: "n" });
    expect(saved[0]).toEqual({ text: "새 질문", tags: [], setId: "n", id: "id9" });
  });

  it("같은 문장이 이미 있으면 목록을 바꾸지 않는다", () => {
    const base = [P("있던 질문", "d", "id0")];
    expect(addOptimisticPrompt(base, "있던 질문", "n")).toBe(base);
  });

  it("이미 다른 세트에 있던 문장이면 서버의 세트로 맞춘다", () => {
    const list = addOptimisticPrompt([], "겹친 질문", "n");
    expect(applySavedPrompt(list, { text: "겹친 질문", id: "x", setId: "d" })[0].setId).toBe("d");
  });

  it("허브 저장이 실패해 남은 항목을 자동화 동기화가 같은 세트로 다시 보낸다", () => {
    const list = addOptimisticPrompt([P("서버에 있음", "d", "id0")], "저장 실패한 질문", "n");
    expect(buildSyncPayloads(list, new Set(["서버에 있음"]))).toEqual([
      { text: "저장 실패한 질문", tags: [], setId: "n" },
    ]);
    // 세트를 모르는 항목(데모·옛 상태)은 세트 없이 → 서버가 기존 세트로
    expect(buildSyncPayloads([P("세트 모름")], new Set())).toEqual([{ text: "세트 모름", tags: [] }]);
  });
});

describe("자동화 세트별 고르기", () => {
  const items = [
    { id: "1", setId: "d" },
    { id: "2", setId: "d" },
    { id: "3", setId: "n" },
  ];
  const groups = groupBySet(items, SETS);

  it("세트별 선택 수", () => {
    const sel = new Set(["1", "3"]);
    expect(groups.map((g) => countSelected(g.items, sel))).toEqual([1, 1, 0]);
  });

  it("이 세트 전체 선택·해제는 다른 세트 선택을 건드리지 않는다", () => {
    const on = toggleGroupSelection(new Set(["3"]), groups[0].items, true);
    expect([...on].sort()).toEqual(["1", "2", "3"]);
    const off = toggleGroupSelection(on, groups[0].items, false);
    expect([...off]).toEqual(["3"]);
  });

  it("고른 질문이 있는 세트를 펼쳐 둔다 — 하나도 없으면 첫 세트", () => {
    expect([...initiallyExpandedKeys(groups, new Set(["3"]))]).toEqual(["n"]);
    expect([...initiallyExpandedKeys(groups, new Set())]).toEqual(["d"]);
  });
});

describe("검수 1회차 — P1 동기화 재시도", () => {
  it("잠금 대기(409 archive_lock_busy)는 같은 세트로 다시 — 세트를 빼지 않는다", () => {
    expect(syncRetryDecision(false, "archive_lock_busy", true)).toBe("same");
  });
  it("세트 문제일 때만 세트를 빼고 다시", () => {
    expect(syncRetryDecision(false, "invalid_set", true)).toBe("drop-set");
    expect(syncRetryDecision(false, "set_gone", true)).toBe("drop-set");
    expect(syncRetryDecision(false, "set_gone", false)).toBe("give-up");
  });
  it("그 밖의 실패는 다시 보내지 않는다", () => {
    expect(syncRetryDecision(false, "invalid_input", true)).toBe("give-up");
    expect(syncRetryDecision(false, undefined, true)).toBe("give-up");
    expect(syncRetryDecision(true, undefined, true)).toBe("done");
  });
});

describe("검수 1회차 — P2 서버 목록으로 맞추기", () => {
  it("자동화가 다시 저장한 낙관 항목은 서버 번호·세트를 받아 이동 체크박스가 풀린다", () => {
    const local = addOptimisticPrompt([P("있던", "d", "id0")], "복구된 질문", "n");
    const merged = mergeServerPrompts(local, [P("복구된 질문", "n", "id9"), P("있던", "d", "id0")]);
    expect(merged.find((p) => p.text === "복구된 질문")).toEqual(P("복구된 질문", "n", "id9"));
    expect(merged).toHaveLength(2);
  });
  it("아직 저장 안 된 낙관 항목은 남긴다", () => {
    const local = addOptimisticPrompt([], "미저장", "n");
    expect(mergeServerPrompts(local, [P("서버", "d", "x")]).map((p) => p.text)).toEqual(["미저장", "서버"]);
  });
});

describe("검수 1회차 — P3 늦게 온 이전 워크스페이스 응답", () => {
  it("A 에서 출발한 조회가 B 로 바꾼 뒤 도착하면 버린다", () => {
    const g = createWorkspaceGuard();
    g.setCurrent("A");
    const tA = g.capture("A");
    g.setCurrent("B");
    const tB = g.capture("B");
    expect(g.accept(tA)).toBe(false);
    expect(g.accept(tB)).toBe(true);
  });
  it("A→B→A 로 돌아와도 처음 A 때 출발한 응답은 버린다", () => {
    const g = createWorkspaceGuard();
    g.setCurrent("A");
    const old = g.capture("A");
    g.setCurrent("B");
    g.setCurrent("A");
    expect(g.accept(old)).toBe(false);
    expect(g.accept(g.capture("A"))).toBe(true);
  });
});

describe("검수 2회차 — P2-잔여 탭을 떠난 뒤 저장 성공", () => {
  it("복구 저장을 보낸 직후 탭을 떠나도, 저장이 성공하면 부모 콜백을 1회 부른다", async () => {
    let cancelled = false;
    let resolvePost!: (v: { ok: boolean }) => void;
    const post = () => new Promise<{ ok: boolean }>((r) => (resolvePost = r));
    let called = 0;
    const run = runPromptSync({
      payloads: [{ text: "복구 질문", tags: [], setId: "n" }, { text: "다음 질문", tags: [] }],
      post,
      isCancelled: () => cancelled,
      wait: async () => {},
      onSaved: () => (called += 1),
    });
    cancelled = true; // ① 복구 POST 를 보낸 직후 허브로 돌아감
    resolvePost({ ok: true }); // ② 그 뒤 저장 성공
    expect(await run).toBe(1); // 다음 질문은 보내지 않는다
    expect(called).toBe(1);
  });

  it("다시 들어왔을 때 서버엔 있는데 화면엔 번호가 없으면 맞춰야 한다고 판정", () => {
    const local = addOptimisticPrompt([], "복구 질문", "n");
    expect(hasUnsyncedLocalIds(local, new Set(["복구 질문"]))).toBe(true);
    expect(hasUnsyncedLocalIds(local, new Set())).toBe(false);
    expect(hasUnsyncedLocalIds([P("복구 질문", "n", "id1")], new Set(["복구 질문"]))).toBe(false);
  });

  it("저장이 하나도 성공하지 않으면 부르지 않는다", async () => {
    let called = 0;
    await runPromptSync({
      payloads: [{ text: "x", tags: [] }],
      post: async () => ({ ok: false, code: "invalid_input" }),
      isCancelled: () => false,
      wait: async () => {},
      onSaved: () => (called += 1),
    });
    expect(called).toBe(0);
  });
});

describe("검수 2회차 — N1 늦게 온 재조회가 그 사이 저장된 질문을 지우지 않는다", () => {
  it("재조회 출발 → 허브에서 새 질문 저장(번호 받음) → 옛 목록 도착: 새 질문이 남는다", () => {
    const atStart = [P("있던", "d", "id0")];
    const idsAtStart = new Set(atStart.flatMap((p) => (p.id ? [p.id] : [])));
    const nowLocal = [P("새 질문", "n", "id9"), ...atStart]; // 출발 뒤 추가·저장됨
    const staleServer = [P("있던", "d", "id0")]; // 출발 시점 서버 목록
    expect(mergeServerPrompts(nowLocal, staleServer, idsAtStart).map((p) => p.text)).toEqual(["새 질문", "있던"]);
  });

  it("출발 때부터 있던 번호가 서버에서 사라졌으면(다른 곳에서 삭제) 지운다", () => {
    const local = [P("지워진", "d", "id5"), P("있던", "d", "id0")];
    expect(mergeServerPrompts(local, [P("있던", "d", "id0")], new Set(["id5", "id0"])).map((p) => p.text)).toEqual(["있던"]);
  });
});
