/**
 * AI 답변 분석용 공유 유틸.
 *
 * 배경: Google AI Overview / Gemini 응답은 "메인 AI 본문" 뒤에
 * "관련 동영상 / 추천 콘텐츠" 카드 영역이 자동 첨부된 상태로
 * Bright Data `answer_text`에 합쳐져 반환된다. 브랜드가 자체
 * YouTube 채널 등을 운영하면 그 영역에 채널명이 노출되어
 * findMentions가 AI 추천으로 오분류. 이를 구조적으로 분리해
 * 스코어링(메인 본문)과 보조 노출(부가 섹션)을 구분해 집계한다.
 */

export type SplitAnswer = {
  /** 메인 AI 답변 본문 — 스코어/감성/언급 판정에 사용 */
  main: string;
  /** 부가 콘텐츠 섹션 — 관련 동영상/추천 링크 카드 영역 (없으면 빈 문자열) */
  attached: string;
};

/**
 * 감지 전략 — 가장 먼저 등장하는 경계 마커 위치에서 절단:
 *   1) "영상[...]확인해 보세요:" 도입 문구 (한글 AI 공통)
 *   2) "\n 7 min" 같은 동영상 duration
 *   3) "\n 03:33" 같은 MM:SS duration
 * 메인 답변 본문에 위 패턴이 우연히 등장할 확률은 매우 낮음.
 */
export function splitAnswerSections(answer: string): SplitAnswer {
  const boundaryPatterns: RegExp[] = [
    /영상[^\n.]{0,30}확인해\s*보세요?\s*:/,
    /\n\s*\d+\s*min\b/i,
    /\n\s*\d{1,2}:\d{2}\b/,
  ];
  let cutAt = answer.length;
  for (const pat of boundaryPatterns) {
    const m = answer.match(pat);
    if (m?.index !== undefined && m.index < cutAt) cutAt = m.index;
  }
  return {
    main: answer.slice(0, cutAt).trim(),
    attached: answer.slice(cutAt).trim(),
  };
}
