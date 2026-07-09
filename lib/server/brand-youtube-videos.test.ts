/**
 * brand-youtube-videos.test.ts — 소유 영상 집합 로더의 TTL 캐시·안전 동작 테스트.
 *
 * 계획 geotracker-youtube-video-match-v2 §6 단계 9d (M1).
 *   - 캐시 히트: TTL 내 재호출은 DB 재조회 없이 같은 Set 반환
 *   - TTL 만료 후 재조회 · _clearOwnedVideoCache 후 재조회
 *   - DB 실패 시 빈 Set (조회 안전) · 실패는 캐시하지 않음
 * db 는 모킹, 순수 캐시 로직만 검증.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── db 모킹 — select().from().where() 가 whereResult() 를 호출해 rows 반환 ──
const whereResult = vi.fn<() => Promise<Array<{ videoId: string }>>>();
vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/drizzle/schema")>("@/drizzle/schema");
  const chain = {
    from: () => chain,
    where: () => whereResult(),
  };
  return {
    schema: actual,
    db: { select: () => chain },
  };
});

import {
  getOwnedYoutubeVideoIds,
  _clearOwnedVideoCache,
} from "./brand-youtube-videos";

const WS = "ws-1";

beforeEach(() => {
  whereResult.mockReset();
  _clearOwnedVideoCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getOwnedYoutubeVideoIds — TTL 캐시(M1)", () => {
  it("TTL 내 재호출은 DB 재조회 없이 캐시 반환", async () => {
    whereResult.mockResolvedValue([{ videoId: "dQw4w9WgXcQ" }, { videoId: "aBcD_eF-123" }]);

    const a = await getOwnedYoutubeVideoIds(WS);
    const b = await getOwnedYoutubeVideoIds(WS);

    expect(a.has("dQw4w9WgXcQ")).toBe(true);
    expect(a.size).toBe(2);
    expect(b).toBe(a); // 동일 Set 인스턴스(캐시 히트)
    expect(whereResult).toHaveBeenCalledTimes(1); // DB 는 1회만
  });

  it("TTL 만료 후에는 재조회", async () => {
    whereResult.mockResolvedValue([{ videoId: "dQw4w9WgXcQ" }]);

    await getOwnedYoutubeVideoIds(WS);
    // 기본 TTL(60s)보다 충분히 진행
    vi.advanceTimersByTime(61_000);
    await getOwnedYoutubeVideoIds(WS);

    expect(whereResult).toHaveBeenCalledTimes(2);
  });

  it("_clearOwnedVideoCache 후에는 재조회", async () => {
    whereResult.mockResolvedValue([{ videoId: "dQw4w9WgXcQ" }]);

    await getOwnedYoutubeVideoIds(WS);
    _clearOwnedVideoCache();
    await getOwnedYoutubeVideoIds(WS);

    expect(whereResult).toHaveBeenCalledTimes(2);
  });

  it("DB 실패 시 빈 Set(조회 안전) · 실패는 캐시 안 함 → 다음 호출 재시도", async () => {
    whereResult.mockRejectedValueOnce(new Error("db down"));
    const empty = await getOwnedYoutubeVideoIds(WS);
    expect(empty.size).toBe(0);

    // 다음 호출은 캐시된 게 없으므로 다시 시도 (성공 데이터 반환)
    whereResult.mockResolvedValueOnce([{ videoId: "dQw4w9WgXcQ" }]);
    const ok = await getOwnedYoutubeVideoIds(WS);
    expect(ok.size).toBe(1);
    expect(whereResult).toHaveBeenCalledTimes(2);
  });
});
