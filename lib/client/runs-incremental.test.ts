/**
 * runs-incremental.test.ts — 응답 목록 증분 재조회 규칙 (2026-11-05).
 */

import { describe, it, expect } from "vitest";
import {
  INCREMENTAL_OVERLAP_MS,
  attachServerId,
  compareRunsDesc,
  incrementalSinceIso,
  latestCreatedAtMs,
  mapWithConcurrency,
  mergeRunsIncremental,
} from "./runs-incremental";

type R = { id: string; createdAt: string; v?: number };
const r = (id: string, createdAt: string, v = 0): R => ({ id, createdAt, v });

describe("incrementalSinceIso", () => {
  const windowStart = "2026-10-06T15:00:00.000Z";
  it("가장 늦은 행 - 10분", () => {
    const runs = [r("a", "2026-11-05T12:00:00.000Z"), r("b", "2026-11-05T11:00:00.000Z")];
    expect(latestCreatedAtMs(runs)).toBe(Date.parse("2026-11-05T12:00:00.000Z"));
    expect(incrementalSinceIso(runs, windowStart)).toBe(
      new Date(Date.parse("2026-11-05T12:00:00.000Z") - INCREMENTAL_OVERLAP_MS).toISOString(),
    );
  });
  it("비었으면 창 시작(=전체), 창 시작보다 이르면 창 시작", () => {
    expect(incrementalSinceIso([], windowStart)).toBe(windowStart);
    expect(incrementalSinceIso([r("a", "2026-10-06T15:05:00.000Z")], windowStart)).toBe(windowStart);
  });
});

describe("mergeRunsIncremental", () => {
  const windowStartMs = Date.parse("2026-11-01T00:00:00.000Z");
  const prev = [r("c", "2026-11-05T10:00:00.000Z"), r("b", "2026-11-04T10:00:00.000Z"), r("a", "2026-11-02T10:00:00.000Z")];

  it("새 행을 앞에 넣고 같은 id 는 새 값으로 바꾼다 — 서버와 같은 순서", () => {
    const fresh = [r("d", "2026-11-05T11:00:00.000Z"), r("c", "2026-11-05T10:00:00.000Z", 9)];
    const out = mergeRunsIncremental(prev, fresh, windowStartMs);
    expect(out.map((x) => x.id)).toEqual(["d", "c", "b", "a"]);
    expect(out.find((x) => x.id === "c")?.v).toBe(9);
  });

  it("겹침 구간에서 내용이 같은 행만 다시 왔으면 이전 배열을 그대로 돌려준다(다시 그리기 없음)", () => {
    const fresh = [{ ...prev[0] }];
    expect(mergeRunsIncremental(prev, fresh, windowStartMs)).toBe(prev);
    expect(mergeRunsIncremental(prev, [], windowStartMs)).toBe(prev);
  });

  it("창 시작보다 이른 행은 버린다(자정이 지나 창이 밀림)", () => {
    const out = mergeRunsIncremental(prev, [], Date.parse("2026-11-03T00:00:00.000Z"));
    expect(out.map((x) => x.id)).toEqual(["c", "b"]);
  });

  it("같은 시각이면 id 내림차순 (서버 정렬 createdAt desc, id desc)", () => {
    const t = "2026-11-05T09:00:00.000Z";
    const sorted = [r("x1", t), r("x3", t), r("x2", t)].sort(compareRunsDesc);
    expect(sorted.map((x) => x.id)).toEqual(["x3", "x2", "x1"]);
  });
});

describe("mapWithConcurrency", () => {
  it("입력 순서대로 결과를 돌려주고 동시 실행 수를 지킨다", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it("빈 입력", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe("C1 — 수동 실행 응답이 증분 뒤 두 줄로 남지 않는다", () => {
  const T = "2026-11-05T09:00:00.000Z";
  type Row = { id?: string; createdAt: string; prompt: string; provider: string };
  const local: Row = { createdAt: T, prompt: "필라테스 자격증", provider: "chatgpt" };
  const older: Row = { id: "o1", createdAt: "2026-11-05T08:00:00.000Z", prompt: "x", provider: "gemini" };

  it("id 없는 화면 행 + 같은 응답이 id 와 함께 증분으로 오면 한 줄만 남는다", () => {
    const out = mergeRunsIncremental([local, older], [{ ...local, id: "srv-1" }], 0);
    expect(out.map((r) => r.id)).toEqual(["srv-1", "o1"]);
  });

  it("다른 질문·모델의 id 없는 행은 지우지 않는다", () => {
    const other: Row = { createdAt: T, prompt: "다른 질문", provider: "chatgpt" };
    const out = mergeRunsIncremental([local, other], [{ ...local, id: "srv-1" }], 0);
    expect(out).toHaveLength(2);
  });

  it("저장이 끝나면 화면 행에 서버 id 를 붙이고, 이미 같은 id 행이 있으면 화면 행을 지운다", () => {
    const a = attachServerId([local, older], local, "srv-1");
    expect(a.map((r) => r.id)).toEqual(["srv-1", "o1"]);
    const b = attachServerId([{ ...local, id: "srv-1" }, local, older], local, "srv-1");
    expect(b.map((r) => r.id)).toEqual(["srv-1", "o1"]);
    const same: Row[] = [older];
    expect(attachServerId(same, local, "srv-1")).toBe(same);
  });
});
