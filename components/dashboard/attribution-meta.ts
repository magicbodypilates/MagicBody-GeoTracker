/**
 * attribution-meta.ts — 유입경로(어트리뷰션) 탭 공통 상수 (채널 라벨·색상·순서·필터).
 *
 * route(정규화)와 UI 가 동일 채널 어휘를 쓰도록 단일 출처로 둔다.
 * channel 값(google/meta/naver/direct/unknown)은 .NET SQL CASE·정규화와 일치해야 함.
 * 계획: ~/.claude/state/plans/magicbody-attribution-admin-view-v1.md
 */

/** 차트·표에 그릴 채널 순서(unknown 은 항상 마지막). */
export const CHANNEL_ORDER = ["google", "meta", "naver", "direct", "unknown"] as const;

export const CHANNEL_META: Record<string, { label: string; color: string }> = {
  google: { label: "구글", color: "#1a73e8" },
  meta: { label: "메타(페북·인스타)", color: "#0866ff" },
  naver: { label: "네이버", color: "#03c75a" },
  direct: { label: "직접 유입", color: "#6b7280" },
  unknown: { label: "미상", color: "#9ca3af" },
};

export function channelLabel(c: string): string {
  return CHANNEL_META[c]?.label ?? c;
}

export function channelColor(c: string): string {
  return CHANNEL_META[c]?.color ?? "#6b7280";
}

/** 상세 채널 필터 드롭다운 옵션 */
export const CHANNEL_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체 채널" },
  { value: "google", label: "구글" },
  { value: "meta", label: "메타(페북·인스타)" },
  { value: "naver", label: "네이버" },
  { value: "direct", label: "직접 유입" },
  { value: "unknown", label: "미상" },
];
