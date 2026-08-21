/**
 * stats-range.test.ts — 조회 구간 파싱 계약 테스트.
 *
 * 핵심 계약 3가지:
 *   1. from/to 없으면 기존 days 동작 **그대로** (호환)
 *   2. from/to 는 KST 일자 양끝 포함 → from=그 날 00:00 KST, to=다음 날 00:00 KST(미만)
 *   3. 형식 오류·역전·상한 초과는 error
 */

import { describe, it, expect } from "vitest";
import {
  parseStatsRange,
  isStatsRangeError,
  kstDateKeyToUtc,
  inclusiveDaySpan,
  parseRunMode,
  utcToKstDateKey,
  STATS_RANGE_MAX_DAYS,
} from "./stats-range";

const NOW = new Date("2026-08-21T03:00:00.000Z");
const sp = (q: string) => new URLSearchParams(q);

describe("parseStatsRange — days 모드 (기존 호환)", () => {
  it("파라미터 없으면 기본 30일 롤링 윈도우", () => {
    const r = parseStatsRange(sp(""), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.mode).toBe("days");
    expect(r.days).toBe(30);
    expect(r.to.toISOString()).toBe(NOW.toISOString());
    expect(r.from.toISOString()).toBe("2026-07-22T03:00:00.000Z");
  });

  it("days=7 이면 7일 롤링", () => {
    const r = parseStatsRange(sp("days=7"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.days).toBe(7);
    expect(r.from.toISOString()).toBe("2026-08-14T03:00:00.000Z");
  });

  it("days 가 숫자가 아니거나 0 이하면 기본값", () => {
    for (const q of ["days=abc", "days=0", "days=-5"]) {
      const r = parseStatsRange(sp(q), { now: NOW });
      if (isStatsRangeError(r)) throw new Error(r.error);
      expect(r.days).toBe(30);
    }
  });

  it("days 는 상한 365 로 clamp", () => {
    const r = parseStatsRange(sp("days=9999"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.days).toBe(365);
  });
});

describe("parseStatsRange — from/to 모드", () => {
  it("양끝 포함 — from 은 그 날 00:00 KST, to 는 다음 날 00:00 KST", () => {
    const r = parseStatsRange(sp("from=2026-08-01&to=2026-08-11"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.mode).toBe("range");
    expect(r.days).toBe(11);
    // 2026-08-01 00:00 KST = 2026-07-31T15:00:00Z
    expect(r.from.toISOString()).toBe("2026-07-31T15:00:00.000Z");
    // 2026-08-12 00:00 KST = 2026-08-11T15:00:00Z (종료일 포함)
    expect(r.to.toISOString()).toBe("2026-08-11T15:00:00.000Z");
  });

  it("같은 날이면 하루(1일) 구간", () => {
    const r = parseStatsRange(sp("from=2026-08-05&to=2026-08-05"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.days).toBe(1);
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("days 와 함께 오면 from/to 가 우선", () => {
    const r = parseStatsRange(sp("days=7&from=2026-08-01&to=2026-08-03"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.mode).toBe("range");
    expect(r.days).toBe(3);
  });

  it("하나만 오면 error", () => {
    expect(isStatsRangeError(parseStatsRange(sp("from=2026-08-01"), { now: NOW }))).toBe(true);
    expect(isStatsRangeError(parseStatsRange(sp("to=2026-08-01"), { now: NOW }))).toBe(true);
  });

  it("형식 불일치는 error", () => {
    for (const q of [
      "from=2026-8-1&to=2026-08-03",
      "from=20260801&to=20260803",
      "from=abc&to=2026-08-03",
      "from=2026-02-30&to=2026-03-01",
      "from=2026-13-01&to=2026-13-05",
    ]) {
      expect(isStatsRangeError(parseStatsRange(sp(q), { now: NOW }))).toBe(true);
    }
  });

  it("역전(from>to)은 error", () => {
    const r = parseStatsRange(sp("from=2026-08-10&to=2026-08-01"), { now: NOW });
    expect(isStatsRangeError(r)).toBe(true);
  });

  it(`상한(${STATS_RANGE_MAX_DAYS}일) 초과는 error, 정확히 상한이면 통과`, () => {
    // 2024-01-01 ~ 2025-12-30 = 730일 (2024 윤년 366 + 364)
    const ok = parseStatsRange(sp("from=2024-01-01&to=2025-12-30"), { now: NOW });
    if (isStatsRangeError(ok)) throw new Error(ok.error);
    expect(ok.days).toBe(730);

    const over = parseStatsRange(sp("from=2024-01-01&to=2025-12-31"), { now: NOW });
    expect(isStatsRangeError(over)).toBe(true);
  });
});

describe("kstDateKeyToUtc / inclusiveDaySpan", () => {
  it("KST 자정 = UTC 전날 15:00", () => {
    expect(kstDateKeyToUtc("2026-08-01")?.toISOString()).toBe("2026-07-31T15:00:00.000Z");
    expect(kstDateKeyToUtc("2026-08-01", 1)?.toISOString()).toBe("2026-08-01T15:00:00.000Z");
  });

  it("존재하지 않는 일자는 null", () => {
    expect(kstDateKeyToUtc("2026-02-30")).toBeNull();
    expect(kstDateKeyToUtc("2026-00-10")).toBeNull();
  });

  it("양끝 포함 일수", () => {
    expect(inclusiveDaySpan("2026-08-01", "2026-08-01")).toBe(1);
    expect(inclusiveDaySpan("2026-08-01", "2026-08-11")).toBe(11);
    // 월 경계·윤년
    expect(inclusiveDaySpan("2024-02-28", "2024-03-01")).toBe(3);
  });
});

describe("parseRunMode", () => {
  it("auto|manual|all 만 인식, 그 외는 null", () => {
    expect(parseRunMode(sp("runMode=auto"))).toBe("auto");
    expect(parseRunMode(sp("runMode=manual"))).toBe("manual");
    expect(parseRunMode(sp("runMode=all"))).toBe("all");
    expect(parseRunMode(sp("runMode=nope"))).toBeNull();
    expect(parseRunMode(sp(""))).toBeNull();
  });
});

/**
 * 경계 케이스 (m5) — 코드는 이미 맞게 동작하지만 고정돼 있지 않아 추가한다.
 * NOW = 2026-08-21T03:00:00Z = KST 2026-08-21 12:00.
 */
describe("경계 케이스", () => {
  it("종료 경계는 배타 — to 는 다음 날 00:00 KST 이고 그 1초 전까지가 구간 안", () => {
    const r = parseStatsRange(sp("from=2026-08-10&to=2026-08-11"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    // 2026-08-12 00:00 KST = 2026-08-11T15:00:00Z (배타 상한)
    expect(r.to.toISOString()).toBe("2026-08-11T15:00:00.000Z");
    const lastIncluded = new Date(r.to.getTime() - 1000); // 23:59:59 KST
    const firstExcluded = r.to; // 다음 날 00:00:00 KST
    expect(lastIncluded.getTime() < r.to.getTime()).toBe(true);
    expect(firstExcluded.getTime() < r.to.getTime()).toBe(false);
    // 시작 경계는 포함 — 2026-08-10 00:00 KST = 2026-08-09T15:00:00Z
    expect(r.from.toISOString()).toBe("2026-08-09T15:00:00.000Z");
  });

  it("연말 경계 — 12-31 → 01-01", () => {
    const r = parseStatsRange(sp("from=2025-12-31&to=2025-12-31"), {
      now: new Date("2026-01-05T03:00:00.000Z"),
    });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.days).toBe(1);
    expect(r.from.toISOString()).toBe("2025-12-30T15:00:00.000Z");
    // 배타 상한이 해를 넘겨 2026-01-01 00:00 KST = 2025-12-31T15:00:00Z
    expect(r.to.toISOString()).toBe("2025-12-31T15:00:00.000Z");
    expect(inclusiveDaySpan("2025-12-31", "2026-01-01")).toBe(2);
  });

  it("윤년 — 2024-02-29 는 유효, 2026-02-29 는 무효", () => {
    expect(kstDateKeyToUtc("2024-02-29")).not.toBeNull();
    expect(kstDateKeyToUtc("2026-02-29")).toBeNull();
    const ok = parseStatsRange(sp("from=2024-02-28&to=2024-02-29"), {
      now: new Date("2024-03-05T03:00:00.000Z"),
    });
    if (isStatsRangeError(ok)) throw new Error(ok.error);
    expect(ok.days).toBe(2);
    const bad = parseStatsRange(sp("from=2026-02-01&to=2026-02-29"), { now: NOW });
    expect(isStatsRangeError(bad)).toBe(true);
  });
});

/** 미래 종료일 방어 (m3) */
describe("미래 구간 방어", () => {
  it("종료일이 오늘(KST) 이후면 오늘로 잘라낸다", () => {
    const r = parseStatsRange(sp("from=2026-08-19&to=2099-12-31"), { now: NOW });
    if (isStatsRangeError(r)) throw new Error(r.error);
    expect(r.toDateKey).toBe("2026-08-21");
    expect(r.days).toBe(3); // 8/19·8/20·8/21
    expect(r.to.toISOString()).toBe("2026-08-21T15:00:00.000Z");
  });

  it("시작일이 미래면 400", () => {
    const r = parseStatsRange(sp("from=2026-08-22&to=2026-08-23"), { now: NOW });
    expect(isStatsRangeError(r)).toBe(true);
  });

  it("잘라내기 전에 형식 검증 — 잘못된 일자는 조용히 오늘로 바뀌지 않는다", () => {
    const r = parseStatsRange(sp("from=2026-08-01&to=2099-13-40"), { now: NOW });
    expect(isStatsRangeError(r)).toBe(true);
  });

  it("utcToKstDateKey 는 KST 일자를 준다 (UTC 15:00 이후는 다음 날)", () => {
    expect(utcToKstDateKey(new Date("2026-08-21T03:00:00.000Z"))).toBe("2026-08-21");
    expect(utcToKstDateKey(new Date("2026-08-21T15:00:00.000Z"))).toBe("2026-08-22");
    expect(utcToKstDateKey(new Date("2026-08-21T14:59:59.000Z"))).toBe("2026-08-21");
  });
});
