/**
 * 가시성 점수 룰 세트 — 상수 세트(데이터)와 계산기(함수) 분리.
 *
 * 배경: 그동안 점수 상수는 계산 함수 안에 상수 리터럴로 박혀 있었고, 룰이 바뀔 때마다
 * 함수가 하나씩 늘었다(옛 phaseLevel 계열 · FULL_SCORE 계열). 분기 구조(브랜드 /
 * 무언급 / 언급)는 어느 룰에서나 동일하므로, 세트만 데이터로 분리하면 계산기는 하나면 된다.
 * 계산기가 1벌이면 "과거 저장 점수를 재현한다"는 성질이 구조적으로 보장된다.
 *
 * 순수 함수 · DB/네트워크 무의존.
 *
 * ⚠️ 세트 값을 바꾸면 그 세트로 저장된 과거 점수의 재현이 깨진다. 값은 추가만 하고
 *    기존 세트는 수정하지 않는다.
 */

export type ScoreSetId = "legacy8" | "full10" | "low60" | "v12b";

export type Sentiment = "positive" | "neutral" | "negative" | "not-mentioned";

/** 한 룰 세트의 배점 상수 전량. 분기 구조는 세트와 무관하게 고정. */
export type ScoreSet = {
  /** 브랜드 질의 · 긍정 어조 */
  brandPositive: number;
  /** 브랜드 질의 · 적극 추천 */
  brandStrong: number;
  /** 브랜드 질의 · 본문 URL 노출 */
  brandBodyUrl: number;
  /** 브랜드 질의 · 참고자료에만 URL */
  brandCitation: number;
  /** 일반 질의 · 언급 0 · 본문 URL 노출 */
  genNoMentionBodyUrl: number;
  /** 일반 질의 · 언급 0 · 참고자료에만 URL */
  genNoMentionCitation: number;
  /** 일반 질의 · 언급 1회 이상 기본점 */
  genBase: number;
  /** 일반 질의 · 첫 언급 위치 < 200 */
  genFirstPos: number;
  /** 일반 질의 · 200 <= 첫 언급 위치 < 500 */
  genMidPos: number;
  /** 일반 질의 · 언급 3회 이상 */
  genMentions3: number;
  /** 일반 질의 · 언급 2회 */
  genMentions2: number;
  /** 일반 질의 · 긍정 어조 */
  genPositive: number;
  /** 일반 질의 · 중립 어조 */
  genNeutral: number;
  /** 일반 질의 · 1순위 언급 */
  genTopRanked: number;
};

/**
 * 룰 세트 레지스트리.
 *
 *   legacy8 — score_version 8 로 저장된 행을 만든 세트.
 *   full10  — score_version 10 으로 저장된 행을 만든 세트.
 *   low60   — legacy8 의 각 상수에 같은 계수(0.6)를 적용한 세트. 계수가 균일하므로
 *             응답 사이의 상대 순서가 그대로 보존된다.
 *   v12b    — 현행 수집이 쓰는 세트. 브랜드 분기 상수는 full10 과 동일.
 *
 * 어떤 세트에서도 분기별 합계가 100 미만이라 cap 이 정보를 잘라 역산 불변식을 깨지 않는다
 * (테스트가 이 성질을 고정한다).
 */
export const SCORE_SETS: Record<ScoreSetId, ScoreSet> = {
  legacy8: {
    brandPositive: 20,
    brandStrong: 30,
    brandBodyUrl: 5,
    brandCitation: 2,
    genNoMentionBodyUrl: 15,
    genNoMentionCitation: 2,
    genBase: 30,
    genFirstPos: 20,
    genMidPos: 0,
    genMentions3: 15,
    genMentions2: 8,
    genPositive: 15,
    genNeutral: 5,
    genTopRanked: 15,
  },
  full10: {
    brandPositive: 34,
    brandStrong: 48,
    brandBodyUrl: 15,
    brandCitation: 8,
    genNoMentionBodyUrl: 25,
    genNoMentionCitation: 10,
    genBase: 30,
    genFirstPos: 20,
    genMidPos: 14,
    genMentions3: 15,
    genMentions2: 8,
    genPositive: 18,
    genNeutral: 12,
    genTopRanked: 16,
  },
  low60: {
    brandPositive: 12,
    brandStrong: 18,
    brandBodyUrl: 3,
    brandCitation: 1,
    genNoMentionBodyUrl: 9,
    genNoMentionCitation: 1,
    genBase: 18,
    genFirstPos: 12,
    genMidPos: 0,
    genMentions3: 9,
    genMentions2: 5,
    genPositive: 9,
    genNeutral: 3,
    genTopRanked: 9,
  },
  v12b: {
    brandPositive: 34,
    brandStrong: 48,
    brandBodyUrl: 15,
    brandCitation: 8,
    genNoMentionBodyUrl: 36,
    genNoMentionCitation: 24,
    genBase: 50,
    genFirstPos: 14,
    genMidPos: 11,
    genMentions3: 10,
    genMentions2: 5,
    genPositive: 14,
    genNeutral: 13,
    genTopRanked: 11,
  },
};

export const SCORE_SET_IDS = Object.keys(SCORE_SETS) as ScoreSetId[];

export function isScoreSetId(value: unknown): value is ScoreSetId {
  return typeof value === "string" && value in SCORE_SETS;
}

/**
 * 계산기 입력 — 텍스트가 아니라 이미 도출된 신호.
 *
 * `mentions` 는 근접 병합 후의 언급 수이고 0 이면 미언급 분기로 간다.
 * `firstPos` 는 `mentions > 0` 일 때만 의미가 있다(미언급이면 값은 무시된다).
 */
export type VisibilityInputs = {
  mentions: number;
  firstPos: number;
  hasBodyUrl: boolean;
  hasCitationOnly: boolean;
  sentiment: Sentiment;
  isTopRanked: boolean;
  isStronglyRecommended: boolean;
  isBrandedQuery: boolean;
};

/**
 * 단일 계산기 — 도출된 신호 + 룰 세트 → 0..100 점수.
 *
 * 분기 구조는 어느 세트에서나 동일하고 상수만 세트에서 온다.
 */
export function calcVisibilityWithSet(inputs: VisibilityInputs, set: ScoreSet): number {
  const {
    mentions,
    firstPos,
    hasBodyUrl,
    hasCitationOnly,
    sentiment,
    isTopRanked,
    isStronglyRecommended,
    isBrandedQuery,
  } = inputs;

  // 브랜드 명 검색 — 평가 어조 + URL 노출만 점수. 언급/위치/반복은 의미 없음.
  if (isBrandedQuery) {
    if (mentions === 0) return 0;
    let score = 0;
    if (sentiment === "positive") score += set.brandPositive;
    if (isStronglyRecommended) score += set.brandStrong;
    if (hasBodyUrl) score += set.brandBodyUrl;
    else if (hasCitationOnly) score += set.brandCitation;
    return Math.min(score, 100);
  }

  // 일반 검색 · 언급 0 — URL 노출만 약한 신호.
  if (mentions === 0) {
    if (hasBodyUrl) return set.genNoMentionBodyUrl;
    if (hasCitationOnly) return set.genNoMentionCitation;
    return 0;
  }

  // 일반 검색 · 언급 1회 이상 — 다차원.
  let score = set.genBase;
  if (firstPos < 200) score += set.genFirstPos;
  else if (firstPos < 500) score += set.genMidPos;
  if (mentions >= 3) score += set.genMentions3;
  else if (mentions >= 2) score += set.genMentions2;

  // URL 신호는 언급 0 분기에서만 반영된다(위 분기에서 처리).
  void hasBodyUrl;
  void hasCitationOnly;

  if (sentiment === "positive") score += set.genPositive;
  else if (sentiment === "neutral") score += set.genNeutral;

  if (isTopRanked) score += set.genTopRanked;
  void isStronglyRecommended; // 브랜드 분기 전용

  return Math.min(score, 100);
}

/** 브랜드 용어(본명 + 별칭)의 전체 출현 위치 수집 — 순수. */
export function collectBrandPositions(lower: string, brandTerms: string[]): number[] {
  const positions: number[] = [];
  for (const t of brandTerms) {
    const term = t.toLowerCase();
    if (!term) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(term, from);
      if (idx < 0) break;
      positions.push(idx);
      from = idx + term.length;
    }
  }
  return positions;
}

/**
 * 근접한 위치(50자 이내)는 1회로 merge 후 mentions 수·첫 위치 반환 — 별칭
 * 풀어쓰기 중복 카운트 방지. positions 는 비어있지 않아야 한다(호출부가 보장).
 */
export function mergeMentionPositions(positions: number[]): {
  mentions: number;
  firstPos: number;
} {
  const sorted = [...positions].sort((a, b) => a - b);
  const MERGE_WINDOW = 50;
  const merged: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - merged[merged.length - 1] > MERGE_WINDOW) {
      merged.push(sorted[i]);
    }
  }
  return { mentions: merged.length, firstPos: merged[0] };
}

/**
 * 응답 텍스트 → (mentions, firstPos) 도출. 언급이 없으면 mentions 0 · firstPos -1.
 * 재산출 경로와 수집 경로가 같은 함수를 쓰도록 공개한다.
 */
export function deriveMentionInputs(
  text: string,
  brandTerms: string[],
): { mentions: number; firstPos: number } {
  const positions = collectBrandPositions(text.toLowerCase(), brandTerms);
  if (positions.length === 0) return { mentions: 0, firstPos: -1 };
  return mergeMentionPositions(positions);
}

/**
 * 텍스트 기반 진입점 — 응답 텍스트에서 언급 신호를 도출한 뒤 세트 계산기에 위임.
 * 빈 텍스트는 어떤 신호도 신뢰할 수 없으므로 0 (기존 계산기 계약 유지).
 */
export function calcVisibilityFromText(
  text: string,
  brandTerms: string[],
  hasBodyUrl: boolean,
  hasCitationOnly: boolean,
  sentiment: Sentiment,
  isTopRanked: boolean,
  isStronglyRecommended: boolean,
  isBrandedQuery: boolean,
  set: ScoreSet,
): number {
  if (!text) return 0;
  const { mentions, firstPos } = deriveMentionInputs(text, brandTerms);
  return calcVisibilityWithSet(
    {
      mentions,
      firstPos,
      hasBodyUrl,
      hasCitationOnly,
      sentiment,
      isTopRanked,
      isStronglyRecommended,
      isBrandedQuery,
    },
    set,
  );
}
