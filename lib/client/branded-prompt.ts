/**
 * 클라이언트 측에서 prompt 가 brand 명 검색인지 판정.
 *
 * 서버 측 informationalCondition 과 동일한 의미로, prompt 텍스트에 brand 별칭 중
 * 하나라도 포함되면 branded 로 분류. 클라이언트의 state.runs 기반 통계 카드
 * (상단 KPI strip / AI 응답 탭 / 가시성 분석 탭) 에서 informational 만 집계할 때 사용.
 */

export function isBrandedPrompt(
  promptText: string | null | undefined,
  brandTerms: string[],
): boolean {
  if (!promptText) return false;
  const lower = promptText.toLowerCase();
  return brandTerms.some((t) => {
    const term = t?.trim().toLowerCase();
    return Boolean(term) && lower.includes(term);
  });
}
