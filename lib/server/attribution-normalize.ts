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

/**
 * 채널 표준 순서 — unknown 은 항상 마지막. .NET AttributionChannelCase() 산출 어휘와 1:1 일치(SoT).
 * 순서: 구글 → 구글 자연검색 → 유튜브 → 인스타/메타 → 네이버 → 네이버 블로그 → 네이버 카페 → 카카오 → 직접 → 미상.
 * google_organic = utm·gclid 없는 구글 자연검색 referrer(광고 'google' 버킷과 분리).
 * 미지정(화이트리스트 외) 채널 값은 safeChannel 이 unknown 으로 폴백한다.
 */
export const ATTRIBUTION_CHANNELS = [
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

/** GetAttributionByMonth 행 (raw, .NET) — 원시 식별자 없음. rowType 으로 total/series 구분(dim='all' 센티넬 폐기). */
export type AttributionMonthRaw = {
  bucket?: string | null;
  dim?: string | null;
  rowType?: string | null;
  salesCount?: number;
  revenue?: number;
  rawRevenue?: number;
};

/** GetAttributionByMonth 응답 봉투(datas). */
export type AttributionMonthsRaw = {
  items?: AttributionMonthRaw[];
  valueConverted?: boolean;
  groupBy?: string;
};

/** 분해 차원 — channel(채널별) | class(상품별). route·UI 와 동일 어휘. */
export const ATTRIBUTION_GROUP_BYS = ["channel", "class"] as const;
export type AttributionGroupBy = (typeof ATTRIBUTION_GROUP_BYS)[number];

export type MonthRow = {
  /** 월 버킷 "YYYY-MM". */
  bucket: string;
  /** 차원값. channel 이면 채널 어휘, class 이면 ProductName(빈값이면 ""). total 행이면 "". */
  dim: string;
  /** "total"(그 달 전체 합계) | "series"(월 × 차원). */
  rowType: "total" | "series";
  salesCount: number;
  revenue: number;
  rawRevenue: number;
};

export type ByMonthNormalized = {
  view: "byMonth";
  timezone: "Asia/Seoul";
  range: { start: string; end: string };
  groupBy: AttributionGroupBy;
  valueConverted: boolean;
  rows: MonthRow[];
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

/** "YYYY-MM" 월 버킷 형식 가드 — 형식 불량 행은 정규화에서 제외(차트 축 오염 방지). */
const MONTH_BUCKET = /^\d{4}-\d{2}$/;

/** groupBy 화이트리스트 정규화 — 알 수 없는 값은 "channel" 폴백. .NET·route 와 동일 어휘. */
function safeGroupBy(v: unknown): AttributionGroupBy {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (ATTRIBUTION_GROUP_BYS as readonly string[]).includes(s)
    ? (s as AttributionGroupBy)
    : "channel";
}

/**
 * byMonth 정규화 (월별 추이).
 *  - 입력 raw 배열: 각 행은 (bucket, dim, rowType, salesCount, revenue, rawRevenue). 비배열은 빈 배열.
 *  - **명시 필드만 픽**(스프레드 금지). 원시 식별자는 .NET DTO 에도 없지만 여기서도 화이트리스트만 매핑(이중 차단).
 *  - bucket 형식("YYYY-MM") 불량 행은 제외(축 오염 방지). rowType 은 "total" 외 모두 "series" 로 정규화.
 *  - channel 차원은 화이트리스트(safeChannel), class 차원은 ProductName 원문 보존(라벨링은 UI — "(상품명 없음)").
 *  - total 행 식별은 **rowType==="total"** (dim==='all' 판정 폐기 — 상품명·미래 채널 'all' 충돌 방어).
 *  - 정렬: bucket ASC. (동일 bucket 내 순서는 .NET ORDER BY 보존 — total 먼저, 그 뒤 series.)
 */
export function normalizeByMonth(
  rows: AttributionMonthRaw[] | null | undefined,
  opts: { start: string; end: string; groupBy: string; valueConverted: boolean },
): ByMonthNormalized {
  const groupBy = safeGroupBy(opts.groupBy);
  const safeRows = Array.isArray(rows) ? rows : [];
  const normalized: MonthRow[] = [];

  for (const r of safeRows) {
    const bucket = typeof r.bucket === "string" ? r.bucket.trim() : "";
    if (!MONTH_BUCKET.test(bucket)) continue; // 형식 불량 행 제외

    const isTotal = typeof r.rowType === "string" && r.rowType.trim().toLowerCase() === "total";
    // class 차원은 ProductName 원문(trim) 보존, channel 차원은 화이트리스트 정규화. total 행은 dim="".
    const rawDim = typeof r.dim === "string" ? r.dim.trim() : "";
    const dim = isTotal ? "" : groupBy === "channel" ? safeChannel(rawDim) : rawDim;

    const revenue = safeNum(r.revenue);
    const rawRevenue = safeNum(r.rawRevenue);
    normalized.push({
      bucket,
      dim,
      rowType: isTotal ? "total" : "series",
      salesCount: safeInt(r.salesCount),
      revenue: revenue < 0 ? 0 : revenue,
      rawRevenue: rawRevenue < 0 ? 0 : rawRevenue,
    });
  }

  // bucket 오름차순(안정 정렬). 동일 bucket 내부 순서는 .NET ORDER BY(total DESC, dim) 보존.
  normalized.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  return {
    view: "byMonth",
    timezone: "Asia/Seoul",
    range: { start: opts.start, end: opts.end },
    groupBy,
    valueConverted: opts.valueConverted === true,
    rows: normalized,
  };
}
