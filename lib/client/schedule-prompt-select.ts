/**
 * schedule-prompt-select.ts — 스케줄 편집 패널에 넘길 promptIds 선택 상태를 정리하는 순수 규칙.
 *
 * 배경: 스케줄의 promptIds 에는 이미 삭제되었거나 비활성화된 프롬프트 ID 가 남아있을 수
 * 있다(서버는 PATCH 저장 시점에만 정리하므로, 그 이후 다른 경로로 삭제·비활성화된 ID 는
 * 그대로 남는다). 편집 패널의 체크리스트는 활성 프롬프트만 렌더링하고 "선택 N/M"의 분모도
 * 같은 기준(활성 프롬프트 수)을 쓰므로, 걸러내지 않으면 화면에 체크박스가 없는 ID 가
 * 선택 개수에만 잡혀 실제 체크 상태와 표시가 어긋난다(운영에서 "선택 3/5"인데 실제 체크는
 * 2개뿐인 사례로 재현됨).
 */

/** 선택 목록 필터링에 필요한 최소 프롬프트 shape. */
export type SelectablePrompt = { id: string; active: boolean };

/**
 * 스케줄에 저장된 promptIds 를 "현재 활성 프롬프트" 집합으로 걸러낸다.
 * 원본 promptIds 의 순서는 유지한다.
 */
export function filterToActivePromptIds(
  promptIds: string[],
  prompts: SelectablePrompt[],
): string[] {
  const activeIds = new Set(prompts.filter((p) => p.active).map((p) => p.id));
  return promptIds.filter((id) => activeIds.has(id));
}
