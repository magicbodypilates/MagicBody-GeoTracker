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

export type ScoreSetId =
  | "legacy8"
  | "full10"
  | "low60"
  | "v12b"
  | "full83"
  | "v14a"
  | "v15a"
  | "v16a";

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
  /**
   * 일반 질의 · 언급 0 · 언론(배포 매체) 인용만.
   * 계획 v2 §4-1(D4′) — 이번 판은 전 세트 0(미지정 = 0, calcVisibilityWithSet 이
   * `?? 0` 으로 기본값을 채운다). **선택 필드로 둔다** — jobHash 가 ScoreSet 객체 전체를
   * 해시하므로, 기존 세트 리터럴에 이 필드를 채워 넣으면 그 세트를 참조하는 모든 잡(이미
   * 운영에 적용된 v11·v13 포함)의 jobHash 가 흔들려 과거 manifest 가 rollback·reconcile 에서
   * 거부된다. 값을 켤 때만(예: v16a) 새 세트에 명시적 숫자를 채운다.
   */
  genNoMentionPress?: number;
  /**
   * 브랜드 질의 · 언론(배포 매체) 인용. 위 genNoMentionPress 와 같은 이유로 선택 필드.
   * 계획 v2 §4-1(D4′) — v14a·v15a 는 0(미지정). v16a 부터 실제 값(35)이 들어간다
   * (2026-09-23 제3자 인용 판정 재설계 — 사장님 배점 확정).
   */
  brandPress?: number;
  /**
   * 일반 질의 · 언급 0 · 블로그·소셜 추천만. genNoMentionPress 와 판정 조건은 같고 호스트가
   * 소셜 플랫폼일 때만 여기로 온다(press-domain-match.ts 의 분류). v14a·v15a 에는 이 필드
   * 자체가 없다(선택 필드 — 이유는 genNoMentionPress 와 동일: 기존 세트를 건드리면
   * jobHash 가 흔들린다). v16a 부터 실제 값(35)이 들어간다.
   */
  genNoMentionSocial?: number;
  /** 브랜드 질의 · 블로그·소셜 추천. 위 genNoMentionSocial 과 같은 이유로 선택 필드. */
  brandSocial?: number;
};

/**
 * 룰 세트 레지스트리.
 *
 *   legacy8 — score_version 8 로 저장된 행을 만든 세트.
 *   full10  — score_version 10 으로 저장된 행을 만든 세트.
 *   low60   — legacy8 의 각 상수에 같은 계수(0.6)를 적용한 세트. 계수가 균일하므로
 *             응답 사이의 상대 순서가 그대로 보존된다.
 *   v12b    — score_version 12 로 저장된 행을 만든 세트. 브랜드 분기 상수는 full10 과 동일.
 *   full83  — full10 의 일반(gen) 분기 상수에 같은 계수(0.83)를 적용해 반올림한 세트.
 *             계수가 균일하므로 일반 질의 응답 사이의 상대 순서가 보존된다. 브랜드 분기
 *             상수는 full10 과 동일(이 세트를 쓰는 잡이 브랜드 질의를 대상에서 제외한다).
 *   v14a    — 현행 수집이 쓰는 세트. v12b 대비 일반(gen) 분기만 조정했고 브랜드 분기
 *             상수는 v12b(= full10)와 동일하다. 언급 기본점과 URL 노출 배점을 올리고
 *             가산 항목을 낮춰, 일반 분기 최대(99)와 언급 0 분기(55/45/0)의 상대 위치는
 *             유지하면서 "언급됐다 / URL 만 노출됐다" 두 상태의 하한을 끌어올린다.
 *   v15a    — 계획 geotracker-youtube-press-scoring-260923 §4-3. 값만 보면 v14a 와
 *             완전히 동일한 14개 필드를 그대로 복제한 세트다. 점수를 바꾸는 것은 세트가
 *             아니라 판정(유튜브 소유 인용이 "인용됨" 칸에 합류하는 것)이다 — 계산기
 *             입력이 같으면 v14a 와 한 점도 다르지 않다(테스트가 고정).
 *   v16a    — 2026-09-23 제3자 인용 판정 재설계(사장님 배점 확정). 기본 14개 필드는
 *             v15a 를 그대로 복제하고(우리 채널 인용 45점은 손대지 않는다), 언론·블로그·
 *             소셜 4개 필드에 전부 35 를 채운 유일한 세트다. v15a·버전 15 로 이미 저장된
 *             과거 구간은 그대로 두고, 재산출 잡 v16(소스 버전 15 → 목표 16)이 이 값으로
 *             다시 계산한다 — v15a 는 건드리지 않는다.
 *
 * 분기별 합계는 v16a 를 제외한 모든 세트에서 100 미만이라 cap 이 정보를 잘라 역산
 * 불변식을 깨지 않는다(아래 "어느 세트도 cap 에 걸리지 않는다" 테스트가 v16a 를 제외한
 * 나머지에서 이 성질을 고정한다). ⚠️ v16a 는 예외다(2026-09-24 결함 수정으로 명시) —
 * 브랜드 분기는 sentiment·추천이 URL/인용/언론/소셜 신호와 더해지는 구조라(else-if 가
 * 아니다) 긍정(34)+적극추천(48)+언론 또는 소셜(35)을 함께 만족하면 117 로 cap(100)에
 * 걸린다(visibility-score-sets.test.ts 의 "브랜드 질의 — 긍정+적극추천+언론(또는 소셜)은
 * 100 을 넘어 cap 에 걸린다" 테스트가 이 조합을 고정한다). 지금은 안전하다 — v16a 는
 * targetSet 으로만 쓰이고 REPRO_SET_BY_VERSION(visibility-rescore-jobs.ts)에 소스
 * (declaredSetId)로 등록된 적이 없어 역산이 이 세트를 재현 대상으로 삼지 않는다. v16a 가
 * 앞으로 어떤 잡의 재현 대상(소스 세트)이 되는 순간 이 예외는 실제 문제가 된다.
 *
 * genNoMentionPress·brandPress 는 어떤 세트에도 명시하지
 * 않는다 — calcVisibilityWithSet 이 `?? 0` 으로 기본값을 채우므로 "이번 판은 전 세트 0"과
 * 결과가 완전히 같으면서도, 기존 세트 리터럴을 건드리지 않아 jobHash(ScoreSet 객체 전체를
 * 해시)가 흔들리지 않는다(이미 운영에 적용된 v11·v13 의 manifest 호환성 보존). 배점을 켤
 * 때(예: v16a)만 새 세트에 명시적 숫자를 채운다.
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
  full83: {
    brandPositive: 34,
    brandStrong: 48,
    brandBodyUrl: 15,
    brandCitation: 8,
    genNoMentionBodyUrl: 21,
    genNoMentionCitation: 8,
    genBase: 25,
    genFirstPos: 17,
    genMidPos: 12,
    genMentions3: 12,
    genMentions2: 7,
    genPositive: 15,
    genNeutral: 10,
    genTopRanked: 13,
  },
  v14a: {
    brandPositive: 34,
    brandStrong: 48,
    brandBodyUrl: 15,
    brandCitation: 8,
    genNoMentionBodyUrl: 55,
    genNoMentionCitation: 45,
    genBase: 66,
    genFirstPos: 9,
    genMidPos: 7,
    genMentions3: 7,
    genMentions2: 3,
    genPositive: 9,
    genNeutral: 8,
    genTopRanked: 8,
  },
  v15a: {
    brandPositive: 34,
    brandStrong: 48,
    brandBodyUrl: 15,
    brandCitation: 8,
    genNoMentionBodyUrl: 55,
    genNoMentionCitation: 45,
    genBase: 66,
    genFirstPos: 9,
    genMidPos: 7,
    genMentions3: 7,
    genMentions2: 3,
    genPositive: 9,
    genNeutral: 8,
    genTopRanked: 8,
  },
  v16a: {
    // 14개 기본 필드는 v15a(= v14a)와 완전히 동일 — "우리 채널 인용" 배점은 건드리지 않는다.
    brandPositive: 34,
    brandStrong: 48,
    brandBodyUrl: 15,
    brandCitation: 8,
    genNoMentionBodyUrl: 55,
    genNoMentionCitation: 45,
    genBase: 66,
    genFirstPos: 9,
    genMidPos: 7,
    genMentions3: 7,
    genMentions2: 3,
    genPositive: 9,
    genNeutral: 8,
    genTopRanked: 8,
    // 언론·블로그·소셜 배점 확정(2026-09-23 사장님 결정) — 둘 다 35. 최근 언론 게재 건수가
    // 급증 중이라 블로그(누적 기간이 다름)와 공정 비교가 안 돼 같은 값으로 시작하고, 자료가
    // 쌓이면 재조정한다.
    genNoMentionPress: 35,
    brandPress: 35,
    genNoMentionSocial: 35,
    brandSocial: 35,
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
  /**
   * 언론(제3자 매체) 게재 인용 — 제목·설명에 브랜드 용어가 있고 우리 소유가 아니며 호스트가
   * 소셜 플랫폼이 아닌 인용이 있었는지(press-domain-match.ts 의 classifyThirdPartyCitation
   * "press" 분류 — 2026-09-23 3차 개정으로 제목/설명 구분은 없앴다). 필수 필드로 둬 호출부가
   * 값을 빠뜨리지 않고 매번 명시하게 한다.
   */
  hasPressCitation: boolean;
  /**
   * 블로그·소셜 추천 인용 — 위와 판정 조건은 같고 호스트가 소셜 플랫폼일 때만("social" 분류).
   * **선택 필드**로 둔다(hasPressCitation 과 달리 필수로 하지 않음) — 이 필드는 v16a
   * 도입(2026-09-23)과 함께 나중에 추가됐고, VisibilityInputs 를 직접 만드는 기존 호출부·
   * 테스트가 전부 값을 명시하게 강제하면 그 전부를 고쳐야 한다. 생략하면 false 와 동일하게
   * 취급한다(calcVisibilityWithSet 이 `?? false` 로 기본값을 채운다).
   */
  hasSocialCitation?: boolean;
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
    hasPressCitation,
    hasSocialCitation = false,
  } = inputs;

  // 브랜드 명 검색 — 평가 어조 + URL 노출만 점수. 언급/위치/반복은 의미 없음.
  if (isBrandedQuery) {
    if (mentions === 0) return 0;
    let score = 0;
    if (sentiment === "positive") score += set.brandPositive;
    if (isStronglyRecommended) score += set.brandStrong;
    if (hasBodyUrl) score += set.brandBodyUrl;
    else if (hasCitationOnly) score += set.brandCitation;
    else if (hasPressCitation) score += set.brandPress ?? 0;
    else if (hasSocialCitation) score += set.brandSocial ?? 0;
    return Math.min(score, 100);
  }

  // 일반 검색 · 언급 0 — URL 노출만 약한 신호.
  if (mentions === 0) {
    if (hasBodyUrl) return set.genNoMentionBodyUrl;
    if (hasCitationOnly) return set.genNoMentionCitation;
    if (hasPressCitation) return set.genNoMentionPress ?? 0;
    if (hasSocialCitation) return set.genNoMentionSocial ?? 0;
    return 0;
  }

  // 일반 검색 · 언급 1회 이상 — 다차원.
  let score = set.genBase;
  if (firstPos < 200) score += set.genFirstPos;
  else if (firstPos < 500) score += set.genMidPos;
  if (mentions >= 3) score += set.genMentions3;
  else if (mentions >= 2) score += set.genMentions2;

  // URL·언론·소셜 신호는 언급 0 분기에서만 반영된다(위 분기에서 처리) — 계획 v2 D5.
  void hasBodyUrl;
  void hasCitationOnly;
  void hasPressCitation;
  void hasSocialCitation;

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
 *
 * `hasPressCitation`·`hasSocialCitation` 은 맨 끝에 **선택 인자**(기본 false)로 둔다 —
 * 기존 호출부가 고정 인자 개수로 이미 굳어 있어, 중간에 끼워 넣으면 위치 인자가 전부
 * 밀려 동작 변화가 생긴다. 끝에 추가 + 기본값 false 로 두면 기존 호출부는 인자를 몰라도
 * 그대로 컴파일·동작한다(hasSocialCitation 은 2026-09-23 v16a 도입과 함께 추가).
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
  hasPressCitation: boolean = false,
  hasSocialCitation: boolean = false,
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
      hasPressCitation,
      hasSocialCitation,
    },
    set,
  );
}
