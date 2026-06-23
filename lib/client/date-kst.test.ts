import { describe, it, expect } from "vitest";
import {
  toKstDateKey,
  kstRecentDateKeys,
  kstWindowStartUtcIso,
  enumerateDateRange,
  resolveGa4DateToken,
  kstMonthRange,
  enumerateMonthRange,
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

describe("enumerateDateRange (임의 구간 연속 일자)", () => {
  it("start~end 양끝 포함, 오래된→최신", () => {
    expect(enumerateDateRange("2026-06-01", "2026-06-04")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
    ]);
  });

  it("같은 날이면 그 하루만", () => {
    expect(enumerateDateRange("2026-06-01", "2026-06-01")).toEqual([
      "2026-06-01",
    ]);
  });

  it("월말 경계를 넘는다", () => {
    expect(enumerateDateRange("2026-06-29", "2026-07-02")).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);
  });

  it("인접 키는 정확히 하루 차이 (구간 길어도 끊김 없음)", () => {
    const keys = enumerateDateRange("2026-05-19", "2026-06-17");
    expect(keys).toHaveLength(30);
    for (let i = 1; i < keys.length; i++) {
      const prev = Date.parse(keys[i - 1] + "T00:00:00Z");
      const cur = Date.parse(keys[i] + "T00:00:00Z");
      expect(cur - prev).toBe(24 * 60 * 60 * 1000);
    }
  });

  it("start>end 또는 형식 오류는 빈 배열", () => {
    expect(enumerateDateRange("2026-06-04", "2026-06-01")).toEqual([]);
    expect(enumerateDateRange("not-a-date", "2026-06-01")).toEqual([]);
    expect(enumerateDateRange("2026-06-01", "")).toEqual([]);
  });
});

describe("resolveGa4DateToken (GA4 상대 토큰 → KST 절대 일자)", () => {
  // 기준 시각: 2026-06-18T03:00:00Z = 2026-06-18 12:00 KST (낮 시간대 — 날짜 경계 영향 없음)
  const now = new Date("2026-06-18T03:00:00Z");

  it("이미 절대 일자면 그대로 반환", () => {
    expect(resolveGa4DateToken("2026-06-01", now)).toBe("2026-06-01");
  });

  it('"today" → KST 오늘', () => {
    expect(resolveGa4DateToken("today", now)).toBe("2026-06-18");
  });

  it('"yesterday" → KST 어제', () => {
    expect(resolveGa4DateToken("yesterday", now)).toBe("2026-06-17");
  });

  it('"0daysAgo" → KST 오늘 (오늘 포함)', () => {
    expect(resolveGa4DateToken("0daysAgo", now)).toBe("2026-06-18");
  });

  it('"28daysAgo" (route 기본값) → 28일 전 KST 일자', () => {
    // 2026-06-18 - 28일 = 2026-05-21
    expect(resolveGa4DateToken("28daysAgo", now)).toBe("2026-05-21");
  });

  it("대소문자·공백 무시", () => {
    expect(resolveGa4DateToken("  TODAY  ", now)).toBe("2026-06-18");
    expect(resolveGa4DateToken("28DaysAgo", now)).toBe("2026-05-21");
  });

  it("KST 날짜 경계 — UTC 16:00은 이미 KST 다음날 01:00이라 today가 다음 일자", () => {
    // 2026-06-18T16:00:00Z = 2026-06-19 01:00 KST
    const lateNow = new Date("2026-06-18T16:00:00Z");
    expect(resolveGa4DateToken("today", lateNow)).toBe("2026-06-19");
    expect(resolveGa4DateToken("yesterday", lateNow)).toBe("2026-06-18");
  });

  it("월 경계를 넘는 NdaysAgo", () => {
    // 2026-06-18 - 30일 = 2026-05-19
    expect(resolveGa4DateToken("30daysAgo", now)).toBe("2026-05-19");
  });

  it("인식 불가 토큰은 빈 문자열", () => {
    expect(resolveGa4DateToken("lastWeek", now)).toBe("");
    expect(resolveGa4DateToken("", now)).toBe("");
    expect(resolveGa4DateToken("daysago", now)).toBe("");
  });

  it("MED-2 통합 — route 기본값을 enumerateDateRange에 넣으면 연속 일자가 채워진다", () => {
    // 정규화 전: enumerateDateRange("28daysAgo","today") = [] (0 채움 무력화)
    // 정규화 후: 29일 연속 일자 (28일 전 ~ 오늘, 양끝 포함)
    const start = resolveGa4DateToken("28daysAgo", now);
    const end = resolveGa4DateToken("today", now);
    const days = enumerateDateRange(start, end);
    expect(days).toHaveLength(29);
    expect(days[0]).toBe("2026-05-21");
    expect(days[days.length - 1]).toBe("2026-06-18");
  });
});

describe("kstMonthRange (최근 N개월 → start/end YMD)", () => {
  it("start 는 시작 달 1일, end 는 KST 오늘", () => {
    const todayKey = toKstDateKey(new Date());
    const r = kstMonthRange(12);
    expect(r.end).toBe(todayKey);
    expect(r.start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("months=1 이면 이번 달 1일 ~ 오늘(부분월)", () => {
    const todayKey = toKstDateKey(new Date());
    const thisMonth = todayKey.slice(0, 7);
    const r = kstMonthRange(1);
    expect(r.start).toBe(`${thisMonth}-01`);
    expect(r.end).toBe(todayKey);
  });

  it("start~end 가 정확히 N개 월 버킷을 커버", () => {
    const r = kstMonthRange(12);
    expect(enumerateMonthRange(r.start, r.end)).toHaveLength(12);
    const r6 = kstMonthRange(6);
    expect(enumerateMonthRange(r6.start, r6.end)).toHaveLength(6);
    const r24 = kstMonthRange(24);
    expect(enumerateMonthRange(r24.start, r24.end)).toHaveLength(24);
  });

  it("months<1 은 1 로 보정", () => {
    const r0 = kstMonthRange(0);
    const r1 = kstMonthRange(1);
    expect(r0).toEqual(r1);
  });
});

describe("enumerateMonthRange (연속 월 버킷)", () => {
  it("양끝 포함, 오래된→최신", () => {
    expect(enumerateMonthRange("2026-01-01", "2026-04-15")).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
  });

  it("'YYYY-MM' 입력도 받는다", () => {
    expect(enumerateMonthRange("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("같은 달이면 그 한 달만", () => {
    expect(enumerateMonthRange("2026-06-01", "2026-06-30")).toEqual(["2026-06"]);
  });

  it("연말 경계를 넘는다", () => {
    expect(enumerateMonthRange("2025-12", "2026-01")).toEqual(["2025-12", "2026-01"]);
  });

  it("start>end 또는 형식 오류는 빈 배열", () => {
    expect(enumerateMonthRange("2026-05", "2026-01")).toEqual([]);
    expect(enumerateMonthRange("bad", "2026-01")).toEqual([]);
    expect(enumerateMonthRange("", "2026-01")).toEqual([]);
  });
});
