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
 * 권장 순서: 구글 → 구글 자연검색 → 유튜브 → 인스타/메타 → 네이버 → 네이버 블로그 → 네이버 카페 → 카카오 → 직접 → 미상.
 */
export const CHANNEL_ORDER = [
  "google",
  "google_organic",
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
  google_organic: { label: "구글 자연검색", color: "#34a853" },
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

/* ───────────────────────────────────────────────────────────────────
 * 월별 추이 — 클래스(상품)별 누적 막대용 색·라벨
 *
 * 채널과 달리 클래스(ProductName)는 동적·다수라 고정 메타를 둘 수 없다.
 * "기간을 6→12→24 로 바꿔도 같은 상품 = 같은 색"(C9)을 위해 seriesKey(상품명) 기반
 *   결정적(deterministic) 색 매핑을 쓴다. 표시 순서(top-N)와 무관하게 색이 흔들리지 않는다.
 * ─────────────────────────────────────────────────────────────────── */

/** 클래스(상품)별 막대 팔레트 8색 — 채널 색과 시각적으로 구분되는 톤. 9번째부터 순환. */
export const CLASS_PALETTE = [
  "#2563eb", // blue
  "#db2777", // pink
  "#16a34a", // green
  "#d97706", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#dc2626", // red
  "#65a30d", // lime
] as const;

/** "기타"(top-N 외 나머지 합산) 색·라벨. 채널 unknown 과 동일 회색 톤. */
export const OTHER_COLOR = "#9ca3af";
export const OTHER_LABEL = "기타";

/** 상품명 빈값 라벨 — .NET·normalize 는 빈 문자열("")로 두고, 표시만 이 라벨로(SQL 한국어 리터럴 0, C8). */
export const NO_NAME_LABEL = "(상품명 없음)";

/**
 * seriesKey(상품명) → CLASS_PALETTE 인덱스 안정 매핑(결정적 해시).
 *   같은 상품명은 항상 같은 색. 충돌(같은 색 다른 상품)은 시각적 약점일 뿐 데이터 오류 아님.
 *   "기타"·빈 키는 호출부에서 OTHER_COLOR 로 분기(여기서 처리하지 않음).
 */
export function classColor(seriesKey: string): string {
  let h = 0;
  for (let i = 0; i < seriesKey.length; i++) {
    // 간단·결정적 문자열 해시(djb2 변형). 부호 제거 후 팔레트 길이로 모듈로.
    h = (h * 31 + seriesKey.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % CLASS_PALETTE.length;
  return CLASS_PALETTE[idx];
}

/**
 * 클래스 차원 라벨 — 빈 키는 "(상품명 없음)".
 * 결제 상품명은 주문 제목이라 끝에 "외 N건"이 붙는다(N=다른 라인 수). 단일 상품 주문의 "외 0건"은
 * 노이즈라 라벨에서만 제거하고, 실제 묶음 주문("외 N건", N≥1)은 정보라 유지한다.
 * 색·집계는 원문 seriesKey 로 하므로(여기선 표시 라벨만 다듬음) 색 안정성·합계 정합에 영향 없음.
 */
export function classLabel(seriesKey: string): string {
  if (seriesKey.length === 0) return NO_NAME_LABEL;
  return seriesKey
    .replace(/\s*외\s*0\s*건\s*$/, "") // "외 0건"(단일 상품) 꼬리표만 제거
    .replace(/\s{2,}/g, " ")
    .trim();
}
