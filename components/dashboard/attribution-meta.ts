/**
 * attribution-meta.ts — 유입경로(어트리뷰션) 탭 공통 상수 (채널 라벨·색상·순서·필터).
 *
 * route(정규화)와 UI 가 동일 채널 어휘를 쓰도록 단일 출처로 둔다.
 * channel 값(google/youtube/meta/naver/naver_blog/naver_cafe/kakao/direct/unknown)은
 * .NET SQL CASE(AttributionChannelCase) · 정규화(attribution-normalize)와 일치해야 함.
 * 채널 분류는 SQL CASE 가 SoT — 여기서는 라벨·순서·색만 정의(재분류 금지).
 * 계획: ~/.claude/state/plans/magicbody-attribution-admin-view-v1.md
 */

/**
 * 차트·표에 그릴 채널 순서(unknown 은 항상 마지막).
 * 권장 순서: 구글 → 유튜브 → 인스타/메타 → 네이버 → 네이버 블로그 → 네이버 카페 → 카카오 → 직접 → 미상.
 */
export const CHANNEL_ORDER = [
  "google",
  "youtube",
  "meta",
  "naver",
  "naver_blog",
  "naver_cafe",
  "kakao",
  "direct",
  "unknown",
] as const;

export const CHANNEL_META: Record<string, { label: string; color: string }> = {
  google: { label: "구글", color: "#1a73e8" },
  youtube: { label: "유튜브", color: "#ff0000" },
  meta: { label: "인스타/메타", color: "#0866ff" },
  naver: { label: "네이버", color: "#03c75a" },
  naver_blog: { label: "네이버 블로그", color: "#2db400" },
  naver_cafe: { label: "네이버 카페", color: "#1ea672" },
  kakao: { label: "카카오", color: "#fee500" },
  direct: { label: "직접", color: "#6b7280" },
  unknown: { label: "미상", color: "#9ca3af" },
};

export function channelLabel(c: string): string {
  return CHANNEL_META[c]?.label ?? c;
}

export function channelColor(c: string): string {
  return CHANNEL_META[c]?.color ?? "#6b7280";
}

/** 상세 채널 필터 드롭다운 옵션 (CHANNEL_ORDER 순서 + 전체). value 는 .NET CASE 어휘와 일치. */
export const CHANNEL_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체 채널" },
  ...CHANNEL_ORDER.map((c) => ({ value: c, label: CHANNEL_META[c].label })),
];
