/**
 * collector-schedule.test.ts — 자동 수집 회차 시각 계산 단위 테스트 (계획 geotracker-collect-speed-260924 v1 §11).
 * 순수 · DB 무의존. 시간대는 "UTC" 로 고정한다(운영 컨테이너와 같음).
 */

import { describe, it, expect } from "vitest";
import { computeRoundTiming, formatIntervalSlot, kstDateString, nextCronAfter } from "./collector-schedule";

const SIX_HOURLY = "0 */6 * * *";
const T = (iso: string) => new Date(iso);

function ok(r: ReturnType<typeof computeRoundTiming>) {
  if (!r.ok) throw new Error(`ok 여야 한다: ${r.error}`);
  return r;
}

describe("computeRoundTiming", () => {
  it("새 스케줄(next_run_at 없음) → first_run · 지금 시각 · 다음 시각은 지금 이후 첫 cron", () => {
    const now = T("2030-01-01T13:05:00Z");
    const r = ok(computeRoundTiming(SIX_HOURLY, null, now, "UTC"));
    expect(r.trigger).toBe("first_run");
    expect(r.scheduledFor.toISOString()).toBe(now.toISOString());
    expect(r.nextRunAt.toISOString()).toBe("2030-01-01T18:00:00.000Z");
    expect(r.coalesced).toBe(false);
  });

  it("정상 도래 — 예정 12:00, 지금 12:00:30 → 회차 12:00 · 다음 18:00", () => {
    const r = ok(computeRoundTiming(SIX_HOURLY, T("2030-01-01T12:00:00Z"), T("2030-01-01T12:00:30Z"), "UTC"));
    expect(r.trigger).toBe("cron");
    expect(r.scheduledFor.toISOString()).toBe("2030-01-01T12:00:00.000Z");
    expect(r.nextRunAt.toISOString()).toBe("2030-01-01T18:00:00.000Z");
    expect(r.coalesced).toBe(false);
  });

  it("정각 그 순간(지금 = 12:00:00.000)에도 그 시각을 회차로 잡는다", () => {
    const r = ok(computeRoundTiming(SIX_HOURLY, T("2030-01-01T12:00:00Z"), T("2030-01-01T12:00:00Z"), "UTC"));
    expect(r.scheduledFor.toISOString()).toBe("2030-01-01T12:00:00.000Z");
    expect(r.nextRunAt.toISOString()).toBe("2030-01-01T18:00:00.000Z");
  });

  it("여러 번 놓친 회차는 가장 최근 1회로 합친다 — 예정 06:00, 지금 13:05 → 회차 12:00 · coalesced", () => {
    const r = ok(computeRoundTiming(SIX_HOURLY, T("2030-01-01T06:00:00Z"), T("2030-01-01T13:05:00Z"), "UTC"));
    expect(r.scheduledFor.toISOString()).toBe("2030-01-01T12:00:00.000Z");
    expect(r.coalesced).toBe(true);
    expect(r.nextRunAt.toISOString()).toBe("2030-01-01T18:00:00.000Z");
  });

  it("화면에서 재개(next_run_at = 지금−60초) → 그 시각을 회차로 · 합치지 않음", () => {
    const now = T("2030-01-01T13:05:00Z");
    const resumed = new Date(now.getTime() - 60_000);
    const r = ok(computeRoundTiming(SIX_HOURLY, resumed, now, "UTC"));
    expect(r.scheduledFor.toISOString()).toBe(resumed.toISOString());
    expect(r.coalesced).toBe(false);
    expect(r.nextRunAt.toISOString()).toBe("2030-01-01T18:00:00.000Z");
  });

  it("다음 시각은 항상 지금 이후", () => {
    const base = T("2030-01-01T00:00:00Z").getTime();
    for (let m = 0; m < 24 * 60; m += 37) {
      const now = new Date(base + m * 60_000);
      const r = ok(computeRoundTiming(SIX_HOURLY, new Date(now.getTime() - 3600_000), now, "UTC"));
      expect(r.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
      expect(r.scheduledFor.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it("6시간 주기 — 회차가 길어도 다음 시각은 회차를 만든 때 정해져 밀리지 않는다", () => {
    // 12:00 회차를 12:00:40 에 만들면 다음은 18:00. 회차가 5시간 걸려도 이 값은 바뀌지 않는다.
    const r = ok(computeRoundTiming(SIX_HOURLY, T("2030-01-01T12:00:00Z"), T("2030-01-01T12:00:40Z"), "UTC"));
    expect(r.nextRunAt.toISOString()).toBe("2030-01-01T18:00:00.000Z");
  });

  it("cron 해석 실패 → ok:false (호출부가 24시간 뒤로 미룬다)", () => {
    const r = computeRoundTiming("not a cron", T("2030-01-01T12:00:00Z"), T("2030-01-01T12:00:30Z"), "UTC");
    expect(r.ok).toBe(false);
    const r2 = computeRoundTiming("0 0 30 2 *", null, T("2030-01-01T12:00:30Z"), "UTC");
    expect(r2.ok).toBe(false);
  });
});

describe("formatIntervalSlot · nextCronAfter · kstDateString", () => {
  it("슬롯 형식은 UTC 시 단위 YYYY-MM-DDTHH (runs 중복 방지 키 — 바꾸면 안 된다)", () => {
    expect(formatIntervalSlot(T("2030-01-02T03:59:59.999Z"))).toBe("2030-01-02T03");
    expect(formatIntervalSlot(T("2030-12-31T23:00:00Z"))).toBe("2030-12-31T23");
    // KST 로 날짜가 바뀌어도 UTC 기준이다
    expect(formatIntervalSlot(T("2030-01-01T16:30:00+09:00"))).toBe("2030-01-01T07");
  });

  it("nextCronAfter — 지금 이후 첫 cron, 해석 실패면 null", () => {
    expect(nextCronAfter(SIX_HOURLY, T("2030-01-01T13:05:00Z"), "UTC")?.toISOString()).toBe("2030-01-01T18:00:00.000Z");
    expect(nextCronAfter("bad", T("2030-01-01T13:05:00Z"), "UTC")).toBeNull();
  });

  it("kstDateString — KST 날짜", () => {
    expect(kstDateString(T("2030-01-01T14:59:59Z"))).toBe("2030-01-01");
    expect(kstDateString(T("2030-01-01T15:00:00Z"))).toBe("2030-01-02");
  });
});
