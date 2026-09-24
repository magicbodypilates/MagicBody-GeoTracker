/**
 * collector-schedule.ts — 자동 수집 시간 계산 (순수 함수 · DB 무의존).
 * 계획 geotracker-collect-speed-260924 §7-2.
 *
 * automation-runner.ts(예전 엔진)와 collector-engine.ts(새 엔진)가 함께 쓴다. 두 엔진 사이의
 * 순환 import 를 피하려고 시간 계산만 따로 둔다 — 이 파일은 다른 서버 모듈을 import 하지 않는다.
 */

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
