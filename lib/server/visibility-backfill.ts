/**
 * 재산출용 랭킹 플래그 역산 — 순수 함수(DB·LLM 무의존).
 *
 * 배경: 저장된 run 에는 최종 점수만 있고 계산에 쓰인 (isTopRanked,
 * isStronglyRecommended) 플래그가 없다. LLM 재분류 대신, 나머지 입력
 * (분기·URL·sentiment·언급 신호)을 고정한 채 이 두 플래그의 4개 조합을 열거해
 * 저장 점수를 재현하는 조합만 남긴 뒤, 그 후보들이 만드는 목표 세트 점수가
 * 유일한지로 결정한다.
 */

import {
  SCORE_SETS,
  calcVisibilityWithSet,
  type ScoreSet,
  type ScoreSetId,
  type VisibilityInputs,
} from "@/lib/server/visibility-score-sets";

/** 세트 레지스트리 — 기본값은 정본 SCORE_SETS. 테스트가 분기 도달을 위해 주입한다. */
export type ScoreSetRegistry = Record<ScoreSetId, ScoreSet>;

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
 * 자유롭게 바인딩할 수 있다.
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

/** 플래그를 뺀 나머지 입력 — 저장 행에서 결정론적으로 복원되는 부분. */
export type BaseVisibilityInputs = Omit<
  VisibilityInputs,
  "isTopRanked" | "isStronglyRecommended"
>;

export type DiagnosticStatus =
  | "resolved"
  | "no-candidate"
  | "ambiguous-target"
  | "cross-set-ambiguous";

export type DiagnosticResolution = {
  status: DiagnosticStatus;
  /** status === "resolved" 일 때만 값이 있다. */
  targetScore: number | null;
  /** 선언 세트에서 저장 점수를 재현한 조합 수. */
  candidateCount: number;
  /** 선언 세트 후보들이 만든 목표 점수(고유해야 resolved). */
  targetScores: number[];
  /** 저장 점수를 재현한 모든 세트 id(선언 세트 포함, 사전순). */
  matchedSets: ScoreSetId[];
  /** 다른 세트가 만들어낸, 선언 세트와 다른 목표 점수(진단용). */
  crossTargetScores: number[];
};

function withFlags(base: BaseVisibilityInputs, flags: RankingFlags): VisibilityInputs {
  return {
    ...base,
    isTopRanked: flags.isTopRanked,
    isStronglyRecommended: flags.isStronglyRecommended,
  };
}

/**
 * 특정 세트에서 저장 점수를 재현하는 조합의 목표 점수 집합(재현 조합이 없으면 null).
 *
 * ⛔ D0 수정(계획 v2 §3-3) — 후보를 거르는 입력(reproBase)과 목표를 계산하는 입력
 * (targetBase)을 분리해서 받는다. 이전에는 이 함수가 `base` 하나만 받아 재현·목표 계산에
 * 똑같이 썼는데, 판정 자체가 바뀌는 변경(예: 유튜브 소유 인용 반영)에서는 "그때 저장된
 * 점수를 만든 입력"과 "지금 적용하고 싶은 새 입력"이 서로 달라야 한다. 하나로 뭉치면
 * 새 입력으로 재현을 걸어 후보가 통째로 사라지고(no-candidate), 잡은 "성공"으로 끝나면서
 * 의도한 변경만 조용히 빠진다(§3-1).
 *
 * reproBase === targetBase(같은 객체)로 호출하면 이전과 동작이 완전히 같다 — 기존 잡
 * (v11~v14)은 이 동일성으로 회귀가 없음을 보장받는다.
 */
function targetsForSet(
  reproBase: BaseVisibilityInputs,
  targetBase: BaseVisibilityInputs,
  storedScore: number,
  reproSetId: ScoreSetId,
  targetSetId: ScoreSetId,
  sets: ScoreSetRegistry,
): { candidateCount: number; targetScores: number[] } {
  const reproSet = sets[reproSetId];
  const targetSet = sets[targetSetId];
  const candidates = RANKING_COMBOS.filter(
    (f) => calcVisibilityWithSet(withFlags(reproBase, f), reproSet) === storedScore,
  );
  return {
    candidateCount: candidates.length,
    targetScores: [
      ...new Set(
        candidates.map((f) => calcVisibilityWithSet(withFlags(targetBase, f), targetSet)),
      ),
    ],
  };
}

/**
 * 선언 세트 재현 + 교차 재현 진단.
 *
 * 1) 선언 세트(행의 score_version 이 가리키는 세트)로, **reproBase** 를 써서 저장 점수를
 *    재현하는 조합을 열거한다. 후보가 없으면 `no-candidate`, 그 후보들이 **targetBase** 로
 *    만드는 목표 점수가 갈리면 `ambiguous-target`.
 * 2) 진단 세트(다른 소스 세트)로도 **reproBase** 로 같은 열거를 수행한다(교차 진단은 "그때
 *    무엇이 이 점수를 만들었나"를 묻는 질문이라 재현 쪽 입력을 쓴다 — §3-3). 다른 세트도
 *    저장 점수를 재현하는데 그 목표 점수가 1)의 결과와 다르면 `cross-set-ambiguous` —
 *    행의 선언 버전만으로는 어느 룰이 그 점수를 만들었는지 단정할 수 없다는 신호다.
 *
 * reproBase 와 targetBase 가 같은 객체면 이 함수는 D0 수정 이전과 동작이 완전히 같다.
 * 조합 4개 × 세트 수(현재 2)뿐이라 비용은 무시할 수준이다.
 */
export function resolveWithDiagnostics(args: {
  /** "그때 저장된 점수를 실제로 만든" 입력 — 후보 거르기(선언·진단 세트 공통)에 쓴다. */
  reproBase: BaseVisibilityInputs;
  /** "지금 목표 세트로 계산하고 싶은" 입력 — 후보들의 목표 점수 계산에만 쓴다. */
  targetBase: BaseVisibilityInputs;
  storedScore: number;
  declaredSetId: ScoreSetId;
  diagnosticSetIds: readonly ScoreSetId[];
  targetSetId: ScoreSetId;
  /** 기본 SCORE_SETS. 테스트가 특정 분기에 도달하기 위해서만 주입한다. */
  sets?: ScoreSetRegistry;
}): DiagnosticResolution {
  const { reproBase, targetBase, storedScore, declaredSetId, diagnosticSetIds, targetSetId } =
    args;
  const sets = args.sets ?? SCORE_SETS;

  const declared = targetsForSet(
    reproBase,
    targetBase,
    storedScore,
    declaredSetId,
    targetSetId,
    sets,
  );
  const matched = new Set<ScoreSetId>();
  if (declared.candidateCount > 0) matched.add(declaredSetId);

  // 교차 진단은 선언 세트 결과와 무관하게 수집한다(anomaly 원인 파악에 필요).
  const crossTargets = new Set<number>();
  for (const setId of diagnosticSetIds) {
    if (setId === declaredSetId) continue;
    const cross = targetsForSet(reproBase, targetBase, storedScore, setId, targetSetId, sets);
    if (cross.candidateCount === 0) continue;
    matched.add(setId);
    for (const t of cross.targetScores) crossTargets.add(t);
  }

  const matchedSets = [...matched].sort();

  if (declared.candidateCount === 0) {
    return {
      status: "no-candidate",
      targetScore: null,
      candidateCount: 0,
      targetScores: [],
      matchedSets,
      crossTargetScores: [...crossTargets].sort((a, b) => a - b),
    };
  }

  if (declared.targetScores.length !== 1) {
    return {
      status: "ambiguous-target",
      targetScore: null,
      candidateCount: declared.candidateCount,
      targetScores: declared.targetScores,
      matchedSets,
      crossTargetScores: [...crossTargets].sort((a, b) => a - b),
    };
  }

  const resolvedTarget = declared.targetScores[0];
  const divergent = [...crossTargets].filter((t) => t !== resolvedTarget).sort((a, b) => a - b);

  if (divergent.length > 0) {
    return {
      status: "cross-set-ambiguous",
      targetScore: null,
      candidateCount: declared.candidateCount,
      targetScores: declared.targetScores,
      matchedSets,
      crossTargetScores: divergent,
    };
  }

  return {
    status: "resolved",
    targetScore: resolvedTarget,
    candidateCount: declared.candidateCount,
    targetScores: declared.targetScores,
    matchedSets,
    crossTargetScores: [],
  };
}
