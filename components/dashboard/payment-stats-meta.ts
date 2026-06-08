/**
 * payment-stats-meta.ts — 결제 통계 탭 공통 상수 (contType 라벨·색상·순서).
 *
 * route(정규화)와 UI 가 동일 정의를 쓰도록 단일 출처로 둔다(L2).
 * contType 값(online/offline/ebook/package/unknown/all)은 .NET·정규화와 일치해야 함.
 */

export type MetricKey = "amount" | "salesCount";

/** 지표 토글 라벨. amount 는 실매출(쿠폰·포인트·추가할인 차감 후, = 실결제 Amount) 임을 UI 에서 명시. */
export const METRIC_META: Record<MetricKey, { label: string; unit: string }> = {
  amount: { label: "실매출(쿠폰·포인트·할인 차감)", unit: "원" },
  salesCount: { label: "판매 건수", unit: "건" },
};

/** 시계열 차트에 그릴 contType 시리즈 순서(all 은 별도 강조선으로 맨 위). */
export const CONTTYPE_SERIES_ORDER = [
  "all",
  "offline",
  "online",
  "ebook",
  "package",
  "unknown",
] as const;

export const CONTTYPE_META: Record<
  string,
  { label: string; color: string }
> = {
  all: { label: "전체", color: "#111827" },
  offline: { label: "오프라인", color: "#ea4335" },
  online: { label: "온라인", color: "#1a73e8" },
  ebook: { label: "전자책", color: "#10a37f" },
  package: { label: "패키지", color: "#a855f7" },
  unknown: { label: "기타/삭제", color: "#9ca3af" },
};

export function contTypeLabel(t: string): string {
  return CONTTYPE_META[t]?.label ?? t;
}

export function contTypeColor(t: string): string {
  return CONTTYPE_META[t]?.color ?? "#6b7280";
}

/** 강의별 타입 필터 드롭다운 옵션 */
export const CONTTYPE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체 타입" },
  { value: "offline", label: "오프라인" },
  { value: "online", label: "온라인" },
  { value: "ebook", label: "전자책" },
  { value: "package", label: "패키지" },
  { value: "unknown", label: "기타/삭제" },
];

/** 금액 → 만원 단위 축약(축 라벨용). 예: 12,340,000 → "1,234만" */
export function formatManwon(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const man = v / 10_000;
  // 1만 미만은 그대로 원 단위로
  if (Math.abs(v) < 10_000) return `${Math.round(v).toLocaleString("ko-KR")}`;
  // 소수점 없이 만 단위
  return `${Math.round(man).toLocaleString("ko-KR")}만`;
}

/** 금액 → 원화 풀 표기(tooltip 용). 예: 12,340,000 → "12,340,000원" */
export function formatWon(v: number): string {
  if (!Number.isFinite(v)) return "0원";
  return `${Math.round(v).toLocaleString("ko-KR")}원`;
}

/** 건수 → "1,234건" */
export function formatCount(v: number): string {
  if (!Number.isFinite(v)) return "0건";
  return `${Math.round(v).toLocaleString("ko-KR")}건`;
}

/** 지표값 포맷(축약: 축용 / 풀: tooltip용) */
export function formatMetric(metric: MetricKey, v: number, full: boolean): string {
  if (metric === "amount") return full ? formatWon(v) : formatManwon(v);
  return full ? formatCount(v) : Math.round(v).toLocaleString("ko-KR");
}

/**
 * 결제수단 코드 → 한글 라벨(알 수 없으면 원문). 미지정은 "-".
 * SoT: MagicBody-API PaymentModel.cs pay_method_tostring (코드 집합·한글 표기 동기화).
 */
const PAY_METHOD_LABELS: Record<string, string> = {
  trans: "계좌이체",
  card: "신용카드",
  kakaopay: "카카오페이",
  naverpay: "네이버페이",
  bank: "실시간계좌이체",
  vacct: "무통장입금",
  admin: "관리자",
};

export function payMethodLabel(m: string): string {
  if (!m) return "-";
  return PAY_METHOD_LABELS[m.toLowerCase()] ?? m;
}

/** ISO datetime/날짜 문자열 → "YYYY-MM-DD" (시간 절삭). 파싱 실패 시 원문. */
export function formatDateOnly(s: string): string {
  if (!s) return "-";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s;
}
