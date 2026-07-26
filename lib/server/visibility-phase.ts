/**
 * 가시성 점수 재산출 비율(factor) — KST 날짜키 → 적용 비율.
 *
 * 순수 함수·DB 무의존. 신규/수동 수집은 항상 완전 적용(LATEST_RAMP_FACTOR)이고,
 * 과거 재산출은 run 의 KST 생성일자로 factor 를 판정한다.
 */

/** 점수 레벨. 0 = 기준(현행) 출력, 4 = 완전 적용. */
export type PhaseLevel = 0 | 1 | 2 | 3 | 4;

/** 완전 적용 점수 계산에 쓰는 레벨. 신규·수동 수집이 항상 쓰는 값. */
export const LATEST_PHASE_LEVEL: PhaseLevel = 4;

/** 재산출 적용 비율. 0 = 미적용, 1 = 완전 적용. */
export type RampFactor = 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1;

/** 신규·수동 수집에 적용할 완전 적용 비율. */
export const LATEST_RAMP_FACTOR: RampFactor = 1;

/**
 * KST 날짜 경계별 적용 비율(단일 config).
 * 각 항목의 fromKey(포함) 이상이면 해당 factor. 첫 항목은 하한 sentinel(catch-all).
 * 사전식 비교가 성립하도록 fromKey 는 canonical "YYYY-MM-DD".
 */
export const RAMP_TABLE: readonly { factor: RampFactor; fromKey: string }[] = [
  { factor: 0, fromKey: "0000-00-00" },
  { factor: 0.2, fromKey: "2026-07-11" },
  { factor: 0.4, fromKey: "2026-07-13" },
  { factor: 0.6, fromKey: "2026-07-15" },
  { factor: 0.8, fromKey: "2026-07-17" },
  { factor: 1, fromKey: "2026-07-19" },
];

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * canonical KST 날짜키("YYYY-MM-DD") → RampFactor.
 * 형식이 canonical 이 아니면 사전식 경계 비교가 어긋나므로 명시적으로 예외를 던진다
 * (호출부는 anomaly 로 처리). 조용한 오판정을 만들지 않는다.
 */
export function visibilityRampFactor(kstDateKey: string): RampFactor {
  if (!DATE_KEY_RE.test(kstDateKey)) {
    throw new RangeError(
      `visibilityRampFactor: canonical YYYY-MM-DD 아님 (${JSON.stringify(kstDateKey)})`,
    );
  }
  for (let i = RAMP_TABLE.length - 1; i >= 0; i--) {
    if (kstDateKey >= RAMP_TABLE[i].fromKey) return RAMP_TABLE[i].factor;
  }
  return 0; // RAMP_TABLE[0] 이 catch-all 이라 실질적으로 도달 불가(방어적).
}
