/**
 * attribution-normalize.ts — 유입경로(어트리뷰션) 정규화 순수함수 (서버 전용, 부수효과 없음)
 *
 * .NET PaymentController 의 어트리뷰션 응답(ReturnModels.datas)을 GeoTracker 프론트가 쓰는
 * 안정적 JSON 형태로 변환한다. 모든 함수는 순수(I/O·시간·전역 의존 없음) — vitest 대상.
 *
 * ⚠️ 원시 식별자 비노출(보안 핵심, plan §5 L3 레이어):
 *   raw → 표시용 변환 시 **명시 필드만 픽**(스프레드 `...row` 금지). attr_fbp·attr_fbc·attr_client_ip·
 *   attr_gclid(원문)·attr_fbclid(원문)·email·tel·hash 같은 식별자는 애초에 .NET DTO 에 없지만,
 *   여기서도 화이트리스트 필드만 매핑해 미래에 .NET 이 컬럼을 추가해도 새지 않도록 이중 차단한다.
 *   클릭ID 는 boolean(hasGoogleClickId/hasMetaClickId)로만 — 원문 문자열은 어디에도 없음.
 *
 * 채널 분류는 .NET SQL CASE 단일 SoT — 여기서는 재분류하지 않고 받은 channel 을 라벨로만 표시.
 * 계획: ~/.claude/state/plans/magicbody-attribution-admin-view-v1.md
 */

/** 채널 표준 순서 — unknown 은 항상 마지막. */
export const ATTRIBUTION_CHANNELS = ["google", "meta", "naver", "direct", "unknown"] as const;
export type AttributionChannel = (typeof ATTRIBUTION_CHANNELS)[number];

/** GetAttributionByChannel 행 (raw, .NET) */
export type AttributionChannelRaw = {
  channel?: string;
  salesCount?: number;
  revenue?: number;
  rawRevenue?: number;
};

/** GetAttributionTransactions 행 (raw, .NET) — 클릭ID 는 존재여부 bool 만, 원시 식별자 없음. */
export type AttributionTxRaw = {
  orderdate?: string | null;
  productName?: string | null;
  amount?: number;
  rawAmount?: number;
  channel?: string;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  hasGoogleClickId?: boolean;
  hasMetaClickId?: boolean;
};

/** GetAttributionTransactions 응답 봉투(datas) — Controller 가 truncated·valueConverted 와 함께 래핑. */
export type AttributionTxsRaw = {
  items?: AttributionTxRaw[];
  truncated?: boolean;
  limit?: number;
  /** 정규과정 ×10 환산 적용 여부(.NET 명시 boolean). 봉투에 없으면 route 가 false 폴백. */
  valueConverted?: boolean;
};

export type ChannelRow = {
  channel: string;
  salesCount: number;
  revenue: number;
  rawRevenue: number;
};

export type ByChannelNormalized = {
  view: "byChannel";
  timezone: "Asia/Seoul";
  range: { start: string; end: string };
  /** 정규과정 ×10 환산 적용 여부(.NET 응답 메시지 또는 명시 플래그 기반). */
  valueConverted: boolean;
  rows: ChannelRow[];
};

export type TxRow = {
  orderdate: string;
  productName: string;
  amount: number;
  rawAmount: number;
  channel: string;
  source: string;
  medium: string;
  campaign: string;
  /** 클릭ID 존재 여부만 — 원시 값 없음. */
  hasGoogleClickId: boolean;
  hasMetaClickId: boolean;
};

export type ByTransactionsNormalized = {
  view: "byTransactions";
  timezone: "Asia/Seoul";
  range: { start: string; end: string };
  channelFilter: string;
  valueConverted: boolean;
  /** 상한 초과로 일부 행이 잘렸는지 여부(.NET TOP(limit+1) 기반). */
  truncated: boolean;
  limit: number;
  rows: TxRow[];
};

function safeNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeInt(v: unknown): number {
  return Math.round(safeNum(v));
}

/** 채널 화이트리스트 정규화 — 알 수 없는 값은 'unknown'. .NET CASE 와 동일 어휘. */
function safeChannel(v: unknown): AttributionChannel {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (ATTRIBUTION_CHANNELS as readonly string[]).includes(s)
    ? (s as AttributionChannel)
    : "unknown";
}

/** 텍스트 필드(source/medium/campaign) 안전화 — 식별자 아님, 공백/널 → "". */
function safeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 채널 표준 순서 인덱스(정렬 tie-breaker). */
function channelOrder(c: string): number {
  const i = (ATTRIBUTION_CHANNELS as readonly string[]).indexOf(c);
  return i < 0 ? ATTRIBUTION_CHANNELS.length : i;
}

/**
 * byChannel 정규화. 채널 화이트리스트 픽 + 매출(환산) 내림차순 정렬.
 * @param rows  .NET GetAttributionByChannel 행 배열
 * @param opts  기간 + 환산 적용 여부
 */
export function normalizeByChannel(
  rows: AttributionChannelRaw[] | null | undefined,
  opts: { start: string; end: string; valueConverted: boolean },
): ByChannelNormalized {
  const safeRows = Array.isArray(rows) ? rows : [];
  const normalized: ChannelRow[] = safeRows.map((r) => ({
    channel: safeChannel(r.channel),
    salesCount: safeInt(r.salesCount),
    revenue: safeNum(r.revenue),
    rawRevenue: safeNum(r.rawRevenue),
  }));
  // 매출(revenue) 내림차순, 동률은 채널 표준 순서.
  normalized.sort((a, b) => b.revenue - a.revenue || channelOrder(a.channel) - channelOrder(b.channel));

  return {
    view: "byChannel",
    timezone: "Asia/Seoul",
    range: { start: opts.start, end: opts.end },
    valueConverted: opts.valueConverted === true,
    rows: normalized,
  };
}

/**
 * byTransactions 정규화 (주문별 상세).
 *  - 입력 raw 봉투: { items, truncated, limit }. items 누락/비배열은 빈 배열.
 *  - **명시 필드만 픽**(스프레드 금지). 클릭ID 는 boolean 으로만, 원시 식별자는 매핑하지 않음.
 *  - productName 빈값 → "(상품명 없음)". 금액 음수/NaN → 0. 정렬은 .NET 이 적용(Orderdate DESC) — 보존.
 */
export function normalizeByTransactions(
  raw: AttributionTxsRaw | null | undefined,
  opts: { start: string; end: string; channelFilter: string; valueConverted: boolean },
): ByTransactionsNormalized {
  const env = raw ?? {};
  const items = Array.isArray(env.items) ? env.items : [];
  const rows: TxRow[] = items.map((r) => {
    const rawTitle = safeText(r.productName);
    const amount = safeNum(r.amount);
    const rawAmount = safeNum(r.rawAmount);
    return {
      orderdate: typeof r.orderdate === "string" ? r.orderdate : "",
      productName: rawTitle.length > 0 ? rawTitle : "(상품명 없음)",
      amount: amount < 0 ? 0 : amount,
      rawAmount: rawAmount < 0 ? 0 : rawAmount,
      channel: safeChannel(r.channel),
      source: safeText(r.source),
      medium: safeText(r.medium),
      campaign: safeText(r.campaign),
      hasGoogleClickId: r.hasGoogleClickId === true,
      hasMetaClickId: r.hasMetaClickId === true,
    };
  });

  return {
    view: "byTransactions",
    timezone: "Asia/Seoul",
    range: { start: opts.start, end: opts.end },
    channelFilter: opts.channelFilter,
    valueConverted: opts.valueConverted === true,
    truncated: env.truncated === true,
    limit: safeInt(env.limit) || rows.length,
    rows,
  };
}
