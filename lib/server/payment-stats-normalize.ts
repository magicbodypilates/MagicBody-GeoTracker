/**
 * payment-stats-normalize.ts — 결제 통계 정규화 순수함수 (서버 전용, 부수효과 없음)
 *
 * .NET PaymentController 의 신규 통계 응답(ReturnModels)을 GeoTracker 프론트가 쓰는
 * 안정적 JSON 형태로 변환한다. 모든 함수는 순수(I/O·시간·전역 의존 없음) — vitest 대상(H5).
 *
 * 매출 정의(확정 S1 + 2026-06-08 정정): 모든 금액 = 실매출(= 실결제 Amount, 쿠폰·포인트·추가할인 차감 후).
 *   타입별·강의별·건별 = 주문 실수령(pl.Amount) 안분 라인 net. 요약 netRevenue = SUM(pl.Amount).
 *   gmv = SUM(originalamount)는 참고용 정가(실매출 계산 미사용). totalDiscount = gmv − netRevenue.
 * 계획: ~/.claude/state/plans/geotracker-payment-stats-S1-v2.md
 *
 * 핵심 규칙:
 *  - byType: contType 시리즈 + "all" 시리즈(백엔드 직접계산, 프론트 재합산 금지) + zero-fill.
 *  - byContents: 강의별 1행, title null → "(삭제됨)", zero-fill 무의미(없는 강의는 행 없음).
 *  - byTransactions: 라인별 1행 목록 + truncated 플래그(상한 초과). buyerName 빈값 → "(비회원/미상)".
 *  - summary: 주문 레벨 KPI(실매출·총할인·정가·총건수).
 *  - bucket 포맷: day="YYYY-MM-DD" / week="YYYY-Www"(ISO, 목요일 기준 연도) / month="YYYY-MM".
 *    week ISO 계산은 .NET StatBucketExpr(week) 와 동일 정의(목요일 기준)로 복제.
 */

export type Granularity = "day" | "week" | "month";

/** .NET 응답 공통 봉투 */
export type DotNetEnvelope<T> = {
  success?: boolean;
  respCode?: string;
  respMessage?: string;
  datas?: T;
};

/** GetClassTypeStatistics 행 */
export type ClassTypeStatRaw = {
  bucket?: string;
  contType?: string;
  amount?: number;
  salesCount?: number;
};

/** GetContentsStatistics 행 */
export type ContentsStatRaw = {
  contentsid?: string;
  title?: string | null;
  contType?: string;
  amount?: number;
  salesCount?: number;
};

/** GetPaymentSummary 단일 행 */
export type PaymentSummaryRaw = {
  netRevenue?: number;
  gmv?: number;
  totalDiscount?: number;
  salesCount?: number;
};

/** GetPaymentTransactions 행 (라인 레벨, PII: 이름만) */
export type PaymentTransactionRaw = {
  orderdate?: string | null;
  title?: string | null;
  contType?: string;
  buyerName?: string | null;
  lineNet?: number;
  payMethod?: string | null;
  paymentid?: string;
};

/** GetPaymentTransactions 응답 봉투(datas) — Controller 가 truncated 와 함께 래핑. */
export type PaymentTransactionsRaw = {
  items?: PaymentTransactionRaw[];
  truncated?: boolean;
  limit?: number;
};

/** contType 표준 순서 — 'all' 은 별도(시리즈로 분리). unknown 은 항상 마지막. */
export const PAYMENT_CONTTYPES = ["online", "offline", "ebook", "package", "unknown"] as const;
export type PaymentContType = (typeof PAYMENT_CONTTYPES)[number];

export type MetricPoint = { amount: number; salesCount: number };

export type ByTypeNormalized = {
  view: "byType";
  granularity: Granularity;
  timezone: "Asia/Seoul";
  metricLabels: { amount: string; salesCount: string };
  buckets: string[];
  /** contType별 시리즈 + "all". 각 배열은 buckets 와 동일 길이·동일 순서. */
  series: Record<string, MetricPoint[]>;
};

export type ContentsRow = {
  contentsid: string;
  title: string;
  contType: string;
  amount: number;
  salesCount: number;
};

export type ByContentsNormalized = {
  view: "byContents";
  timezone: "Asia/Seoul";
  range: { start: string; end: string };
  contTypeFilter: string;
  rows: ContentsRow[];
};

export type SummaryNormalized = {
  view: "summary";
  timezone: "Asia/Seoul";
  range: { start: string; end: string };
  netRevenue: number;
  gmv: number;
  totalDiscount: number;
  salesCount: number;
};

export type TransactionRow = {
  orderdate: string;
  title: string;
  contType: string;
  buyerName: string;
  lineNet: number;
  payMethod: string;
  paymentid: string;
};

export type ByTransactionsNormalized = {
  view: "byTransactions";
  timezone: "Asia/Seoul";
  range: { start: string; end: string };
  contTypeFilter: string;
  /** 상한 초과로 일부 행이 잘렸는지 여부(.NET TOP(limit+1) 기반). */
  truncated: boolean;
  limit: number;
  rows: TransactionRow[];
};

const METRIC_LABELS = { amount: "실매출(쿠폰·포인트·할인 차감)", salesCount: "판매 건수" } as const;

function safeNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeInt(v: unknown): number {
  return Math.round(safeNum(v));
}

/* ── 날짜/버킷 헬퍼 (UTC 기반 계산 — 입력은 'YYYY-MM-DD' 날짜 문자열) ───────── */

/** 'YYYY-MM-DD' → UTC Date (시간대 영향 제거). 잘못된 입력은 null. */
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * ISO week 라벨 "YYYY-Www" 생성 — 목요일 기준 연도(ISO 8601).
 * .NET StatBucketExpr("week") 와 동일 정의: 해당 주의 목요일이 속한 연도 + ISO 주차.
 */
export function isoWeekLabel(d: Date): string {
  // UTC 기준 목요일로 이동 (ISO: 월=1..일=7)
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // 일=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // 그 주 목요일
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

/**
 * [start, end] (양끝 포함, 'YYYY-MM-DD') 범위의 모든 버킷 라벨을 오름차순으로 생성.
 * zero-fill 의 기준 축이 된다. 잘못된 범위는 빈 배열.
 *  - day:   매일
 *  - week:  매주(ISO 라벨, 중복 제거)
 *  - month: 매월 "YYYY-MM"
 */
export function buildBucketAxis(start: string, end: string, granularity: Granularity): string[] {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (!s || !e || e.getTime() < s.getTime()) return [];

  const out: string[] = [];

  if (granularity === "month") {
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth();
    const endY = e.getUTCFullYear();
    const endM = e.getUTCMonth();
    // 안전 상한(120개월=10년) — 무한루프 방지
    for (let guard = 0; guard < 600 && (y < endY || (y === endY && m <= endM)); guard++) {
      out.push(`${y}-${pad2(m + 1)}`);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return out;
  }

  if (granularity === "week") {
    const seen = new Set<string>();
    const cur = new Date(s.getTime());
    // 안전 상한(약 14년치 일자) — 무한루프 방지
    for (let guard = 0; guard < 5400 && cur.getTime() <= e.getTime(); guard++) {
      const label = isoWeekLabel(cur);
      if (!seen.has(label)) { seen.add(label); out.push(label); }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  // day
  const cur = new Date(s.getTime());
  for (let guard = 0; guard < 4000 && cur.getTime() <= e.getTime(); guard++) {
    out.push(ymd(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * byType 정규화 + zero-fill.
 * @param rows   .NET GetClassTypeStatistics 행 배열 (contType="all" 행 포함)
 * @param opts   granularity·기간(zero-fill 축 생성용)
 *
 * - contType 시리즈는 PAYMENT_CONTTYPES + 응답에 등장한 기타 contType(미래 확장) + "all".
 * - 모든 시리즈는 buckets 와 동일 길이·순서로 정렬, 빈 버킷은 {amount:0, salesCount:0}.
 * - "all" 행은 백엔드 직접계산값 — 절대 재합산하지 않고 그대로 매핑.
 */
export function normalizeByType(
  rows: ClassTypeStatRaw[],
  opts: { granularity: Granularity; start: string; end: string },
): ByTypeNormalized {
  const { granularity } = opts;
  const safeRows = Array.isArray(rows) ? rows : [];

  // 1) 응답에 실제 등장한 버킷 + zero-fill 축을 합쳐 정렬(누락·축초과 양쪽 안전).
  const axisFromRange = buildBucketAxis(opts.start, opts.end, granularity);
  const bucketSet = new Set<string>(axisFromRange);
  for (const r of safeRows) {
    if (typeof r.bucket === "string" && r.bucket) bucketSet.add(r.bucket);
  }
  const buckets = [...bucketSet].sort((a, b) => a.localeCompare(b));
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  // 2) 등장한 contType 시리즈 목록 — 표준 순서 우선, 미지의 타입은 뒤에, 'all' 은 맨 끝.
  const seenTypes = new Set<string>();
  for (const r of safeRows) {
    if (typeof r.contType === "string" && r.contType) seenTypes.add(r.contType);
  }
  const ordered: string[] = [];
  for (const t of PAYMENT_CONTTYPES) ordered.push(t); // 표준 5종은 항상 노출(없으면 0 라인)
  for (const t of seenTypes) {
    if (t !== "all" && !PAYMENT_CONTTYPES.includes(t as PaymentContType)) ordered.push(t);
  }
  ordered.push("all");

  // 3) 각 시리즈를 buckets 길이만큼 0 으로 초기화 후 응답값 주입.
  const series: Record<string, MetricPoint[]> = {};
  for (const t of ordered) {
    series[t] = buckets.map(() => ({ amount: 0, salesCount: 0 }));
  }
  for (const r of safeRows) {
    const t = r.contType;
    const b = r.bucket;
    if (typeof t !== "string" || typeof b !== "string") continue;
    if (!series[t]) series[t] = buckets.map(() => ({ amount: 0, salesCount: 0 }));
    const idx = bucketIndex.get(b);
    if (idx === undefined) continue; // 축 밖 버킷(이론상 없음) — 무시
    series[t][idx] = { amount: safeNum(r.amount), salesCount: safeInt(r.salesCount) };
  }

  return {
    view: "byType",
    granularity,
    timezone: "Asia/Seoul",
    metricLabels: { ...METRIC_LABELS },
    buckets,
    series,
  };
}

/**
 * byContents 정규화. title null/빈값 → "(삭제됨 #contentsid)". 실매출(amount) 내림차순 정렬.
 */
export function normalizeByContents(
  rows: ContentsStatRaw[],
  opts: { start: string; end: string; contTypeFilter: string },
): ByContentsNormalized {
  const safeRows = Array.isArray(rows) ? rows : [];
  const normalized: ContentsRow[] = safeRows.map((r) => {
    const cid = typeof r.contentsid === "string" ? r.contentsid : "";
    const rawTitle = typeof r.title === "string" ? r.title.trim() : "";
    const title = rawTitle.length > 0 ? rawTitle : `(삭제됨${cid ? ` #${cid.slice(0, 8)}` : ""})`;
    const contType =
      typeof r.contType === "string" && r.contType.length > 0 ? r.contType : "unknown";
    return {
      contentsid: cid,
      title,
      contType,
      amount: safeNum(r.amount),
      salesCount: safeInt(r.salesCount),
    };
  });
  // 기본 정렬 = 실매출(amount) desc (UI 가 지표 토글 시 클라이언트에서 재정렬).
  normalized.sort((a, b) => b.amount - a.amount);

  return {
    view: "byContents",
    timezone: "Asia/Seoul",
    range: { start: opts.start, end: opts.end },
    contTypeFilter: opts.contTypeFilter,
    rows: normalized,
  };
}

/** summary 정규화. 누락 필드는 0 으로 안전 처리. */
export function normalizeSummary(
  row: PaymentSummaryRaw | null | undefined,
  opts: { start: string; end: string },
): SummaryNormalized {
  const r = row ?? {};
  return {
    view: "summary",
    timezone: "Asia/Seoul",
    range: { start: opts.start, end: opts.end },
    netRevenue: safeNum(r.netRevenue),
    gmv: safeNum(r.gmv),
    totalDiscount: safeNum(r.totalDiscount),
    salesCount: safeInt(r.salesCount),
  };
}

/**
 * byTransactions 정규화 (라인별 건별 목록).
 *  - 입력 raw 봉투: { items, truncated, limit }. items 누락/비배열은 빈 배열.
 *  - buyerName 빈값/공백 → "(비회원/미상)". title 빈값 → "(삭제됨)". payMethod 빈값 → "".
 *  - lineNet 은 숫자 안전 처리(음수/NaN → 0). 정렬은 .NET 이 이미 적용(Orderdate DESC) — 보존.
 */
export function normalizeByTransactions(
  raw: PaymentTransactionsRaw | null | undefined,
  opts: { start: string; end: string; contTypeFilter: string },
): ByTransactionsNormalized {
  const env = raw ?? {};
  const items = Array.isArray(env.items) ? env.items : [];
  const rows: TransactionRow[] = items.map((r) => {
    const orderdate = typeof r.orderdate === "string" ? r.orderdate : "";
    const rawTitle = typeof r.title === "string" ? r.title.trim() : "";
    const rawBuyer = typeof r.buyerName === "string" ? r.buyerName.trim() : "";
    const net = safeNum(r.lineNet);
    return {
      orderdate,
      title: rawTitle.length > 0 ? rawTitle : "(삭제됨)",
      contType:
        typeof r.contType === "string" && r.contType.length > 0 ? r.contType : "unknown",
      buyerName: rawBuyer.length > 0 ? rawBuyer : "(비회원/미상)",
      lineNet: net < 0 ? 0 : net,
      payMethod: typeof r.payMethod === "string" ? r.payMethod : "",
      paymentid: typeof r.paymentid === "string" ? r.paymentid : "",
    };
  });

  return {
    view: "byTransactions",
    timezone: "Asia/Seoul",
    range: { start: opts.start, end: opts.end },
    contTypeFilter: opts.contTypeFilter,
    truncated: env.truncated === true,
    limit: safeInt(env.limit) || rows.length,
    rows,
  };
}
