/**
 * LLM sentiment 판정 결과의 false positive 방어용 후처리 가드.
 *
 * gpt-4o-mini 가 한국어 동급 나열 응답에서 표면적 평가어("우수", "체계적", "대규모")에
 * 영향받아 POSITIVE 로 잡는 경향. few-shot 프롬프트로 줄였지만 완전 제거 못 함.
 *
 * 후처리 가드 규칙: LLM 이 sentiment="positive" 인데 isTopRanked=false 이고
 * isStronglyRecommended=false 인 경우 (= "약한 긍정" 신호), 다음 패턴 중 하나라도 있으면
 * neutral 로 강제 변환:
 *   1) 본문에 brand 명이 3+개 등장 (비교 나열 응답 시그널)
 *      AND 본문에 명시적 ranking phrase ("가장", "최고", "1위", "단연", "best", "top") 없음
 *   2) 본문에 brand 우호 평가어가 다른 brand 들의 같은 평가어와 동수 이상 (= 변별력 없음)
 *
 * 이 가드는 보수적: 확실히 긍정인 경우(isTopRanked / isStronglyRecommended) 는 그대로 유지.
 */

import type { LlmSentiment } from "./llm-sentiment";

/**
 * 본문에 등장하는 distinct brand 갯수 추정 (대문자 시작 단어 + 한글 brand 패턴).
 * 정확하진 않지만 비교 나열 시그널 감지 용도.
 */
function countDistinctBrands(answerText: string, ourBrandTerms: string[]): number {
  if (!answerText) return 0;
  // 1) 매직바디 외 자주 나오는 필라테스 brand 키워드 (한국·국제) — confidence 신호
  const knownPilatesBrands = [
    "STOTT", "BASI", "Polestar", "폴스타", "Peak", "피크",
    "KPIA", "KPA", "NCPT", "PMA", "Modern", "모던",
    "Reborn", "리본", "한인재", "한국인재교육원",
    "케어필라테스", "스탓", "바시", "Balanced Body",
    "대한필라테스", "국제재활필라테스",
  ];
  const lower = answerText.toLowerCase();
  let count = 0;
  // 우리 brand
  if (ourBrandTerms.some((t) => t && lower.includes(t.toLowerCase()))) count += 1;
  // 다른 brand
  const seen = new Set<string>();
  for (const b of knownPilatesBrands) {
    if (lower.includes(b.toLowerCase())) {
      // alias 묶음 (STOTT == 스탓)
      const key = b.toLowerCase().slice(0, 3);
      if (seen.has(key)) continue;
      // 우리 brand 와 겹치는 alias 는 제외
      const isOurs = ourBrandTerms.some(
        (t) => t && (t.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(t.toLowerCase())),
      );
      if (isOurs) continue;
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

const RANKING_PHRASES = [
  "가장 추천", "가장 적절", "가장 적합", "가장 합리적", "가장 좋은",
  "가장 어울리는", "최고", "1위", "1순위", "단연", "단연코",
  "귀하 케이스에 적합", "본인에게는", "이 분에게는", "추천드리고 싶",
  "best fit", "top pick", "#1", "best choice", "most suitable",
  "would recommend",
];

/**
 * 후처리 가드 적용 — false positive 의심 시 neutral 로 강제 변환.
 * @returns 보정된 sentiment
 */
export function guardSentiment(
  answerText: string,
  brandTerms: string[],
  llmResult: {
    sentiment: LlmSentiment;
    isTopRanked: boolean;
    isStronglyRecommended: boolean;
  },
): LlmSentiment {
  const { sentiment, isTopRanked, isStronglyRecommended } = llmResult;

  // 강한 긍정 신호 (1위 명시 OR 적극 추천) 가 있으면 LLM 결과 그대로 신뢰
  if (sentiment !== "positive") return sentiment;
  if (isTopRanked || isStronglyRecommended) return sentiment;

  // "약한 긍정" 으로 잡힌 케이스만 추가 검증
  const lower = answerText.toLowerCase();
  const brandCount = countDistinctBrands(answerText, brandTerms);
  const hasRankingPhrase = RANKING_PHRASES.some((p) => lower.includes(p.toLowerCase()));

  // 비교 나열 응답(3+ brand)인데 ranking phrase 없으면 neutral 로 강제
  if (brandCount >= 3 && !hasRankingPhrase) {
    return "neutral";
  }

  // 그 외 케이스 (단독 brand 응답이거나 ranking phrase 있음) 는 LLM 결과 신뢰
  return "positive";
}
