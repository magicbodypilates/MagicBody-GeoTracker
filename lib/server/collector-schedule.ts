/**
 * collector-schedule.ts — 자동 수집 시간 계산 (순수 함수 · DB 무의존).
 * 계획 geotracker-collect-speed-260924 §7-2.
 *
 * automation-runner.ts(예전 엔진)와 collector-engine.ts(새 엔진)가 함께 쓴다. 두 엔진 사이의
 * 순환 import 를 피하려고 시간 계산만 따로 둔다 — 이 파일은 다른 서버 모듈을 import 하지 않는다.
 */

import { CronExpressionParser } from "cron-parser";

/**
 * interval_slot 포맷 — 같은 스케줄의 같은 시간대 실행을 식별 ("2026-04-22T00", UTC 시 단위).
 * runs 의 중복 방지 키(uq_runs_auto_slot)에 들어가므로 형식을 바꾸면 안 된다.
 */
export function formatIntervalSlot(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}`;
}

export type RoundTiming =
  | { ok: true; scheduledFor: Date; nextRunAt: Date; trigger: "cron" | "first_run"; coalesced: boolean }
  | { ok: false; error: string };

function cronOptions(currentDate: Date, tz?: string) {
  return tz ? { currentDate, tz } : { currentDate };
}

/**
 * 때가 된 스케줄 1개의 이번 회차 시각과 다음 실행 시각.
 *
 *   - storedNextRunAt null → 새 스케줄 → scheduledFor = now, trigger first_run
 *   - 그 밖 → latest = now 이하 가장 최근 cron 시각
 *            scheduledFor = max(min(storedNextRunAt, now), latest)
 *            coalesced = latest > storedNextRunAt (여러 번 놓친 회차를 가장 최근 1회로 합쳤다)
 *   - nextRunAt = now 이후 첫 cron 시각 (회차 길이와 무관 — 회차를 만들 때 정한다)
 *
 * tz 미지정 = 프로세스 시간대(운영 컨테이너 UTC — 예전 엔진·1단계 PATCH 와 같음). 테스트는 "UTC" 고정.
 * cron 을 해석하지 못하면 ok:false (호출부가 24시간 뒤로 미룬다 — 매 틱 다시 도는 것을 막는다).
 */
export function computeRoundTiming(
  cronExpression: string,
  storedNextRunAt: Date | null,
  now: Date,
  tz?: string,
): RoundTiming {
  let nextRunAt: Date;
  try {
    nextRunAt = CronExpressionParser.parse(cronExpression, cronOptions(now, tz)).next().toDate();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (storedNextRunAt === null) {
    return { ok: true, scheduledFor: new Date(now.getTime()), nextRunAt, trigger: "first_run", coalesced: false };
  }

  // now 이하 가장 최근 cron 시각 — prev() 는 currentDate "미만"을 주므로 1ms 뒤에서 찾는다.
  let latest: Date | null = null;
  try {
    latest = CronExpressionParser.parse(cronExpression, cronOptions(new Date(now.getTime() + 1), tz))
      .prev()
      .toDate();
  } catch {
    latest = null;
  }

  const base = storedNextRunAt.getTime() < now.getTime() ? storedNextRunAt.getTime() : now.getTime();
  const scheduledMs = latest && latest.getTime() > base ? latest.getTime() : base;
  return {
    ok: true,
    scheduledFor: new Date(scheduledMs),
    nextRunAt,
    trigger: "cron",
    coalesced: latest !== null && latest.getTime() > storedNextRunAt.getTime(),
  };
}

/** now 이후 첫 cron 시각. 해석 실패면 null. (즉시 실행으로 꺼진 스케줄을 켤 때 다음 시각 계산용) */
export function nextCronAfter(cronExpression: string, now: Date, tz?: string): Date | null {
  try {
    return CronExpressionParser.parse(cronExpression, cronOptions(now, tz)).next().toDate();
  } catch {
    return null;
  }
}

/** now 의 KST 날짜 문자열 "YYYY-MM-DD" — 하루 집계를 날짜가 바뀐 뒤 1회만 돌리는 기준. */
export function kstDateString(now: Date): string {
  const k = new Date(now.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}-${String(k.getUTCDate()).padStart(2, "0")}`;
}
