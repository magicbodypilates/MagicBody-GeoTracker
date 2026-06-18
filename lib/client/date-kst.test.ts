import { describe, it, expect } from "vitest";
import {
  toKstDateKey,
  kstRecentDateKeys,
  kstWindowStartUtcIso,
} from "./date-kst";

describe("toKstDateKey", () => {
  it("UTC 00:00 은 같은 날 KST 09:00 → 같은 일자", () => {
    // 2026-06-17T00:00:00Z = 2026-06-17 09:00 KST
    expect(toKstDateKey("2026-06-17T00:00:00Z")).toBe("2026-06-17");
  });

  it("회귀 구간 — UTC 15:00 은 KST 다음날 00:00 → 다음 일자", () => {
    // 2026-06-17T15:00:00Z = 2026-06-18 00:00 KST  (이전 slice(0,10) 버그: "2026-06-17")
    expect(toKstDateKey("2026-06-17T15:00:00Z")).toBe("2026-06-18");
  });

  it("회귀 구간 — UTC 23:59 은 KST 다음날 08:59 → 다음 일자", () => {
    // 2026-06-17T23:59:00Z = 2026-06-18 08:59 KST
    expect(toKstDateKey("2026-06-17T23:59:00Z")).toBe("2026-06-18");
  });

  it("회귀 구간 경계 — UTC 14:59 은 아직 같은 날 KST 23:59 → 같은 일자", () => {
    // 2026-06-17T14:59:00Z = 2026-06-17 23:59 KST
    expect(toKstDateKey("2026-06-17T14:59:00Z")).toBe("2026-06-17");
  });

  it("월말 경계 — UTC 2026-06-30T15:00Z 는 KST 2026-07-01", () => {
    expect(toKstDateKey("2026-06-30T15:00:00Z")).toBe("2026-07-01");
  });

  it("연말 경계 — UTC 2026-12-31T15:00Z 는 KST 2027-01-01", () => {
    expect(toKstDateKey("2026-12-31T15:00:00Z")).toBe("2027-01-01");
  });

  it("Date 객체도 받는다", () => {
    expect(toKstDateKey(new Date("2026-06-17T15:00:00Z"))).toBe("2026-06-18");
  });

  it("파싱 불가 입력은 빈 문자열", () => {
    expect(toKstDateKey("not-a-date")).toBe("");
    expect(toKstDateKey("")).toBe("");
  });
});

describe("kstRecentDateKeys", () => {
  it("요청한 일수만큼, 오래된→최신 순서, 마지막은 KST 오늘", () => {
    const keys = kstRecentDateKeys(7);
    expect(keys).toHaveLength(7);
    expect(keys[keys.length - 1]).toBe(toKstDateKey(new Date()));
    // 오름차순(오래된→최신)
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("1일 요청 시 KST 오늘 하나만", () => {
    const keys = kstRecentDateKeys(1);
    expect(keys).toEqual([toKstDateKey(new Date())]);
  });

  it("연속 일자 — 인접 키가 정확히 하루 차이", () => {
    const keys = kstRecentDateKeys(5);
    for (let i = 1; i < keys.length; i++) {
      const prev = new Date(keys[i - 1] + "T00:00:00Z").getTime();
      const cur = new Date(keys[i] + "T00:00:00Z").getTime();
      expect(cur - prev).toBe(24 * 60 * 60 * 1000);
    }
  });
});

describe("kstWindowStartUtcIso", () => {
  it("결과는 항상 KST 자정 = UTC 15:00 시각", () => {
    const iso = kstWindowStartUtcIso(30);
    const d = new Date(iso);
    expect(d.getUTCHours()).toBe(15);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it("days=1 이면 KST 오늘 자정 — 그 시각의 KST 일자가 오늘", () => {
    const iso = kstWindowStartUtcIso(1);
    // 윈도우 시작 시각을 KST 일자로 환산하면 오늘이어야 함
    expect(toKstDateKey(iso)).toBe(toKstDateKey(new Date()));
  });

  it("days=30 이면 시작 시각은 오늘 자정보다 29일 이전", () => {
    const start1 = new Date(kstWindowStartUtcIso(1)).getTime();
    const start30 = new Date(kstWindowStartUtcIso(30)).getTime();
    expect(start1 - start30).toBe(29 * 24 * 60 * 60 * 1000);
  });

  it("days=30 윈도우는 KST 오늘 포함 정확히 30개 일자를 커버", () => {
    const startKey = toKstDateKey(kstWindowStartUtcIso(30));
    const keys = kstRecentDateKeys(30);
    expect(keys[0]).toBe(startKey);
    expect(keys).toHaveLength(30);
  });
});
