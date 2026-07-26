/**
 * 재산출용 랭킹 플래그 역산 — 순수 함수(DB·LLM 무의존).
 *
 * 배경: 저장된 run 에는 최종 점수만 있고 계산에 쓰인 (isTopRanked,
 * isStronglyRecommended) 플래그가 없다. LLM 재분류 대신, 나머지 입력
 * (브랜치·URL·sentiment)을 고정한 채 이 두 플래그의 4개 조합을 열거해
 * 기준 레벨(0) 점수가 저장값과 일치하는 조합만 남긴 뒤, 그 후보들이 만드는
 * 목표 레벨 점수가 유일한지로 결정한다.
 *
 * scoreOf(flags, level) 는 나머지 입력이 이미 바인딩된 순수 계산 함수 —
 * 호출부(route)가 run 별로 만들어 주입한다(테스트 용이·LLM 폴백 격리).
 */

import type { PhaseLevel } from "@/lib/server/visibility-phase";

export type RankingFlags = {
  isTopRanked: boolean;
  isStronglyRecommended: boolean;
};

/** 미지 플래그의 전체 조합(4개). */
export const RANKING_COMBOS: readonly RankingFlags[] = [
  { isTopRanked: false, isStronglyRecommended: false },
  { isTopRanked: true, isStronglyRecommended: false },
  { isTopRanked: false, isStronglyRecommended: true },
  { isTopRanked: true, isStronglyRecommended: true },
];

export type BackfillResolution =
  | { status: "ok"; targetScore: number; candidateCount: number }
  | {
      status: "anomaly";
      reason: "no-candidate" | "ambiguous-target";
      candidateCount: number;
      targetScores: number[];
    };

/**
 * 조합 열거 → 목표 고유성 결정의 일반형(순수·DI).
 *
 * reproducedOf(flags) 가 저장 점수를 재현하는 조합만 후보로 남기고, 그 후보들이
 * 만드는 targetOf(flags) 가 유일하면 채택한다. 재현 산식·목표 산식을 호출부가
 * 자유롭게 바인딩할 수 있어, "저장값 = 레벨0" 뿐 아니라 "저장값 = 램프된 값" 같은
 * 다른 재현 규칙에도 그대로 쓸 수 있다.
 *
 * @param storedScore  run 에 저장된 점수
 * @param reproducedOf (flags) → 그 조합이 만들었을 저장 점수(재현값)
 * @param targetOf     (flags) → 적용할 목표 점수
 */
export function resolveByReproduction(
  storedScore: number,
  reproducedOf: (flags: RankingFlags) => number,
  targetOf: (flags: RankingFlags) => number,
): BackfillResolution {
  const candidates = RANKING_COMBOS.filter((f) => reproducedOf(f) === storedScore);

  if (candidates.length === 0) {
    return {
      status: "anomaly",
      reason: "no-candidate",
      candidateCount: 0,
      targetScores: [],
    };
  }

  const targetScores = [...new Set(candidates.map((f) => targetOf(f)))];
  if (targetScores.length !== 1) {
    return {
      status: "anomaly",
      reason: "ambiguous-target",
      candidateCount: candidates.length,
      targetScores,
    };
  }

  return {
    status: "ok",
    targetScore: targetScores[0],
    candidateCount: candidates.length,
  };
}

/**
 * 저장 점수(기준 레벨)를 재현하는 조합을 열거해 목표 레벨 점수를 결정.
 * resolveByReproduction 의 특수형 — 재현=레벨0, 목표=targetLevel.
 *
 * @param storedScore  run 에 저장된(기준 레벨) 점수
 * @param targetLevel  적용할 목표 레벨
 * @param scoreOf      (flags, level) → 점수. 나머지 입력은 바인딩된 순수 함수
 */
export function resolveBackfillScore(
  storedScore: number,
  targetLevel: PhaseLevel,
  scoreOf: (flags: RankingFlags, level: PhaseLevel) => number,
): BackfillResolution {
  return resolveByReproduction(
    storedScore,
    (f) => scoreOf(f, 0),
    (f) => scoreOf(f, targetLevel),
  );
}

/**
 * 재산출 점수 램프 적용 — 순수 함수.
 *
 * oldScore(기준)와 fullNewScore(완전 적용) 사이를 factor 비율로 선형 보간해 반올림.
 * factor∈[0,1] 이고 fullNewScore>=oldScore 이면 결과는 oldScore 이상(단조 비감소).
 *
 * @param oldScore      run 에 저장된(기준 레벨) 점수
 * @param fullNewScore  완전 적용(최신 레벨) 점수
 * @param factor        적용 비율(0~1)
 */
export function applyRampScore(
  oldScore: number,
  fullNewScore: number,
  factor: number,
): number {
  return Math.round(oldScore + (fullNewScore - oldScore) * factor);
}
