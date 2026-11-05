/**
 * citation-first-seen.test.ts — 전체 기간 최초 인용 시점 캐시 (2026-11-05).
 * 지문이 같으면 재사용 · 새 행만 붙었으면 증분 · 그 밖의 변화는 전체 재계산 · 동시 요청은 한 번만 계산 ·
 * 메모리 상한 · 최대 보관 시간을 DB 없이 확인한다.
 */

import { describe, it, expect, vi } from "vitest";

// DB 연결 모듈은 이 테스트에서 쓰지 않는다(지문·로더를 주입) — import 시 연결을 만들지 않게 막아 둔다.
vi.mock("@/lib/server/db", () => ({ runStatsQuery: vi.fn(), schema: {} }));

import {
  createFirstSeenCache,
  emptyFirstSeenIndex,
  lookupFirstSeen,
  mergeFirstSeenRows,
  type RunsFingerprint,
  type FirstSeenRow,
} from "./citation-first-seen";

describe("mergeFirstSeenRows · lookupFirstSeen", () => {
  it("key·모델별 최솟값을 담고, 모델 미지정이면 모든 모델 중 최솟값", () => {
    const idx = mergeFirstSeenRows(emptyFirstSeenIndex(), [
      { key: "a.com/x", provider: "chatgpt", ms: 300 },
      { key: "a.com/x", provider: "chatgpt", ms: 100 },
      { key: "a.com/x", provider: "gemini", ms: 200 },
      { key: null, provider: "chatgpt", ms: 1 }, // 판정 탈락 — 버림
    ]);
    expect(lookupFirstSeen(idx, "a.com/x", "chatgpt")).toBe(100);
    expect(lookupFirstSeen(idx, "a.com/x", "gemini")).toBe(200);
    expect(lookupFirstSeen(idx, "a.com/x", null)).toBe(100);
    expect(lookupFirstSeen(idx, "a.com/x", "perplexity")).toBeNull();
    expect(lookupFirstSeen(idx, "b.com", null)).toBeNull();
    expect(idx.size).toBe(1);
  });

  it("같은 행을 두 번 합쳐도 결과가 같다 (증분 겹침 안전)", () => {
    const rows: FirstSeenRow[] = [{ key: "k", provider: "p", ms: 5 }];
    const idx = mergeFirstSeenRows(mergeFirstSeenRows(emptyFirstSeenIndex(), rows), rows);
    expect(lookupFirstSeen(idx, "k", "p")).toBe(5);
  });
});

function makeCache(fpRef: { fp: RunsFingerprint }, countRef: { n: number }, nowRef = { t: 0 }) {
  const fingerprint = vi.fn(async () => fpRef.fp);
  const countSince = vi.fn(async () => countRef.n);
  const cache = createFirstSeenCache({
    fingerprint,
    countSince,
    now: () => nowRef.t,
    fingerprintTtlMs: 0, // 매 요청 지문 조회 (테스트 단순화)
    maxEntries: 2,
    maxAgeMs: 1000,
  });
  return { cache, fingerprint, countSince };
}

describe("createFirstSeenCache", () => {
  it("지문이 같으면 다시 계산하지 않는다 (hit)", async () => {
    const fpRef = { fp: { total: 10, maxMs: 100, maxText: "t100" } };
    const { cache } = makeCache(fpRef, { n: 0 });
    const load = vi.fn(async () => [{ key: "k", provider: "p", ms: 1 }]);
    const a = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    const b = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(a.action).toBe("full");
    expect(b.action).toBe("hit");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("새 행만 붙었으면(건수 증가 = 이전 최댓값 이후 행 수) 그 뒤만 읽어 합친다 (topup)", async () => {
    const fpRef = { fp: { total: 10, maxMs: 100, maxText: "t100" } };
    const countRef = { n: 0 };
    const { cache, countSince } = makeCache(fpRef, countRef);
    const load = vi.fn(async (since: string | null) =>
      since === null ? [{ key: "old", provider: "p", ms: 50 }] : [{ key: "new", provider: "p", ms: 150 }],
    );
    await cache.get({ cacheKey: "c", workspaceId: "w", load });
    fpRef.fp = { total: 13, maxMs: 200, maxText: "t200" };
    countRef.n = 3;
    const r = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(r.action).toBe("topup");
    expect(countSince).toHaveBeenCalledWith("w", "t100");
    expect(load).toHaveBeenLastCalledWith("t100");
    expect(lookupFirstSeen(r.index, "old", null)).toBe(50);
    expect(lookupFirstSeen(r.index, "new", null)).toBe(150);
  });

  it("건수가 맞지 않으면(삭제·보관이 섞임) 전체 재계산", async () => {
    const fpRef = { fp: { total: 10, maxMs: 100, maxText: "t100" } };
    const countRef = { n: 5 };
    const { cache } = makeCache(fpRef, countRef);
    const load = vi.fn(async () => [] as FirstSeenRow[]);
    await cache.get({ cacheKey: "c", workspaceId: "w", load });
    fpRef.fp = { total: 12, maxMs: 200, maxText: "t200" }; // +5 행이 붙었는데 건수는 +2 → 3건 사라짐
    const r = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(r.action).toBe("full");
    expect(load).toHaveBeenLastCalledWith(null);
  });

  it("건수만 줄었으면(보관·삭제) 전체 재계산", async () => {
    const fpRef = { fp: { total: 10, maxMs: 100, maxText: "t100" } };
    const { cache, countSince } = makeCache(fpRef, { n: 0 });
    const load = vi.fn(async () => [] as FirstSeenRow[]);
    await cache.get({ cacheKey: "c", workspaceId: "w", load });
    fpRef.fp = { total: 8, maxMs: 100, maxText: "t100" };
    const r = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(r.action).toBe("full");
    expect(countSince).not.toHaveBeenCalled();
  });

  it("최대 보관 시간이 지나면 이번 요청은 기존 값으로 답하고 뒤에서 새로 만든다 (재채점 등 제자리 수정 반영)", async () => {
    const fpRef = { fp: { total: 10, maxMs: 100, maxText: "t100" } };
    const nowRef = { t: 0 };
    const { cache } = makeCache(fpRef, { n: 0 }, nowRef);
    let version = 1;
    const load = vi.fn(async () => [{ key: "k", provider: "p", ms: version }] as FirstSeenRow[]);
    const first = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(lookupFirstSeen(first.index, "k", null)).toBe(1);
    nowRef.t = 2000;
    version = 0; // 제자리 수정으로 최초 시각이 바뀐 상황
    const stale = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(stale.action).toBe("stale");
    expect(stale.index).toBe(first.index); // 기다리지 않고 기존 값
    expect(load).toHaveBeenCalledTimes(2); // 뒤에서 새로 만들기 시작
    await new Promise((r) => setTimeout(r, 0));
    const fresh = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(fresh.action).toBe("hit");
    expect(lookupFirstSeen(fresh.index, "k", null)).toBe(0);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("같은 항목 동시 요청은 한 번만 계산한다 (single-flight)", async () => {
    const fpRef = { fp: { total: 1, maxMs: 1, maxText: "t1" } };
    const { cache } = makeCache(fpRef, { n: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = vi.fn(async () => {
      await gate;
      return [{ key: "k", provider: "p", ms: 1 }];
    });
    const p1 = cache.get({ cacheKey: "c", workspaceId: "w", load });
    const p2 = cache.get({ cacheKey: "c", workspaceId: "w", load });
    await Promise.resolve();
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a.index).toBe(b.index);
  });

  it("항목 수 상한을 넘으면 가장 오래 안 쓴 항목부터 버린다", async () => {
    const fpRef = { fp: { total: 1, maxMs: 1, maxText: "t1" } };
    const nowRef = { t: 0 };
    const { cache } = makeCache(fpRef, { n: 0 }, nowRef);
    const load = vi.fn(async () => [] as FirstSeenRow[]);
    nowRef.t = 1;
    await cache.get({ cacheKey: "a", workspaceId: "w", load });
    nowRef.t = 2;
    await cache.get({ cacheKey: "b", workspaceId: "w", load });
    nowRef.t = 3;
    await cache.get({ cacheKey: "a", workspaceId: "w", load }); // a 사용 → b 가 가장 오래됨
    nowRef.t = 4;
    await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(cache.size()).toBe(2);
    nowRef.t = 5;
    const again = await cache.get({ cacheKey: "a", workspaceId: "w", load });
    expect(again.action).toBe("hit");
    const evicted = await cache.get({ cacheKey: "b", workspaceId: "w", load });
    expect(evicted.action).toBe("full");
  });

  it("계산이 실패하면 오류를 그대로 올리고, 다음 요청은 다시 계산한다", async () => {
    const fpRef = { fp: { total: 1, maxMs: 1, maxText: "t1" } };
    const { cache } = makeCache(fpRef, { n: 0 });
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error("timeout");
      return [] as FirstSeenRow[];
    });
    await expect(cache.get({ cacheKey: "c", workspaceId: "w", load })).rejects.toThrow("timeout");
    fail = false;
    const r = await cache.get({ cacheKey: "c", workspaceId: "w", load });
    expect(r.action).toBe("full");
  });
});

describe("C7 — 만료 + 건수 감소가 겹쳐도 전체 계산은 한 번만", () => {
  it("뒤에서 갱신과 앞단 전체 계산이 같은 계산을 함께 기다린다", async () => {
    const fpRef = { fp: { total: 10, maxMs: 100, maxText: "t100" } };
    const nowRef = { t: 0 };
    const { cache } = makeCache(fpRef, { n: 0 }, nowRef);
    let release!: () => void;
    let gated = false;
    const load = vi.fn(async (since: string | null) => {
      if (since === null && gated) await new Promise<void>((r) => (release = r));
      return [{ key: "k", provider: "p", ms: 1 }] as FirstSeenRow[];
    });
    await cache.get({ cacheKey: "c", workspaceId: "w", load }); // 첫 전체 계산 (1회)
    nowRef.t = 2000; // 만료
    fpRef.fp = { total: 7, maxMs: 100, maxText: "t100" }; // 보관·삭제로 건수 감소
    gated = true;
    const p = cache.get({ cacheKey: "c", workspaceId: "w", load });
    await new Promise((r) => setTimeout(r, 0));
    expect(load.mock.calls.filter((c) => c[0] === null)).toHaveLength(2); // 첫 계산 + 이번 1회뿐
    release();
    const r = await p;
    expect(r.action).toBe("full");
    expect(load.mock.calls.filter((c) => c[0] === null)).toHaveLength(2);
  });
});
