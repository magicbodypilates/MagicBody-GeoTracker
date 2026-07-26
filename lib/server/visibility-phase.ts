/**
 * 가시성 점수 단계(phase) 판정 — KST 날짜키 → 레벨.
 *
 * 순수 함수·DB 무의존. 신규/수동 수집은 항상 LATEST_PHASE_LEVEL 을 쓰고,
 * 재산출은 run 의 KST 생성일자로 레벨을 판정한다.
 */

/** 점수 단계 레벨. 0 = 기준(현행) 출력. */
export type PhaseLevel = 0 | 1 | 2 | 3 | 4;

/** 신규·수동 수집에 적용할 최신 레벨. */
export const LATEST_PHASE_LEVEL: PhaseLevel = 4;

/**
 * KST 날짜 경계별 레벨(단일 config).
 * 각 항목의 fromKey(포함) 이상이면 해당 레벨. 레벨 0 은 하한 sentinel 로 catch-all.
 * 사전식 비교가 성립하도록 fromKey 는 canonical "YYYY-MM-DD".
 */
export const PHASE_TABLE: readonly { level: PhaseLevel; fromKey: string }[] = [
  { level: 0, fromKey: "0000-00-00" },
  { level: 1, fromKey: "2026-07-14" },
  { level: 2, fromKey: "2026-07-16" },
  { level: 3, fromKey: "2026-07-18" },
  { level: 4, fromKey: "2026-07-20" },
];

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * canonical KST 날짜키("YYYY-MM-DD") → PhaseLevel.
 * 형식이 canonical 이 아니면 사전식 경계 비교가 어긋나므로 명시적으로 예외를 던진다
 * (호출부는 anomaly 로 처리). 조용한 오판정을 만들지 않는다.
 */
export function visibilityPhaseLevel(kstDateKey: string): PhaseLevel {
  if (!DATE_KEY_RE.test(kstDateKey)) {
    throw new RangeError(
      `visibilityPhaseLevel: canonical YYYY-MM-DD 아님 (${JSON.stringify(kstDateKey)})`,
    );
  }
  for (let i = PHASE_TABLE.length - 1; i >= 0; i--) {
    if (kstDateKey >= PHASE_TABLE[i].fromKey) return PHASE_TABLE[i].level;
  }
  return 0; // PHASE_TABLE[0] 이 catch-all 이라 실질적으로 도달 불가(방어적).
}
