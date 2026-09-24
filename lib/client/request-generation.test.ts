/**
 * request-generation.test.ts — 재조회 세대 번호 (계획 geotracker-response-archive-260924 §6-1).
 *
 * 보관 같은 변경 동작과 60초·탭 전환 재조회가 겹치는 세 순서를 고정한다.
 *   ① 변경 **전**에 출발한 조회 → 버린다(옛 목록)
 *   ② 변경 **중**에 출발한 조회 → 버린다(아직 옛 상태를 읽었을 수 있다) — 끝 무효화가 이걸 막는다
 *   ③ 변경 **후**에 출발한 조회 → 반영한다
 */

import { describe, it, expect } from "vitest";
import { createRequestGeneration } from "./request-generation";

/** 변경 동작의 공통 흐름 — 시작 무효화 → (작업) → 끝 무효화(성공·실패 모두). */
async function mutate(gen: ReturnType<typeof createRequestGeneration>, during?: () => void, fail = false) {
  gen.invalidate();
  try {
    during?.();
    if (fail) throw new Error("실패");
  } finally {
    gen.invalidate();
  }
}

describe("createRequestGeneration", () => {
  it("변경 전에 출발한 조회는 버린다", async () => {
    const gen = createRequestGeneration();
    const g = gen.capture();
    await mutate(gen);
    expect(gen.isCurrent(g)).toBe(false);
  });

  it("변경 중에 출발한 조회도 버린다(끝에서 한 번 더 무효화)", async () => {
    const gen = createRequestGeneration();
    let during = -1;
    await mutate(gen, () => {
      during = gen.capture();
    });
    expect(gen.isCurrent(during)).toBe(false);
  });

  it("변경 후에 출발한 조회는 반영한다", async () => {
    const gen = createRequestGeneration();
    await mutate(gen);
    const after = gen.capture();
    expect(gen.isCurrent(after)).toBe(true);
  });

  it("변경이 실패해도 끝 무효화는 일어난다", async () => {
    const gen = createRequestGeneration();
    let during = -1;
    await mutate(gen, () => {
      during = gen.capture();
    }, true).catch(() => {});
    expect(gen.isCurrent(during)).toBe(false);
    const after = gen.capture();
    expect(gen.isCurrent(after)).toBe(true);
  });

  it("변경이 없으면 조회는 그대로 반영된다", () => {
    const gen = createRequestGeneration();
    const g = gen.capture();
    expect(gen.isCurrent(g)).toBe(true);
  });
});
