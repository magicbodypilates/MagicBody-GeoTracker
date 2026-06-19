/**
 * ga4-marketing-aggregate.ts — "마케팅 성과" 탭 집계 순수함수 (계획 v2 §S1~S7).
 *
 * GA4 runReport 응답을 파싱해 만든 평탄한 행 배열을 입력으로 받아, 외부 의존(googleapis)
 * 없는 순수 계산으로 채널 ROI·전환 깔때기·랜딩 전환·매출 추이·상품·신규/재방문을 집계한다.
 * `ga4-aggregate.ts`(AI Referral)와 동일한 "fetch는 호출, 계산은 순수함수" 패턴.
 *
 * 정본 지표(계획 v2 §2 실측 확정):
 *   - 구매 횟수 = ecommercePurchases (= transactions = eventCount(purchase) = 74 실측)
 *   - 매출      = purchaseRevenue (= totalRevenue, 순수 web ecommerce, KRW)
 *   - 구매 전환율 = ecommercePurchases / sessions ("세션 대비")
 *
 * 공통 가드(LOW-3): 0분모 → 0, 빈 입력 안전, 음수 revenue 비클램프(보존), 빈 dimension 라벨 대체.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 공통 헬퍼
 * ──────────────────────────────────────────────────────────────────────────── */

/** 0분모 안전 나눗셈. 분모가 0 또는 비유한수면 0 반환 (NaN/Infinity 방지). */
export function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : 0;
}

/** 빈 디멘션 값을 사람이 읽을 라벨로 대체. GA4 "(not set)"·빈 문자열 처리. */
function labelOrFallback(raw: string, fallback: string): string {
  const v = (raw ?? "").trim();
  if (v === "" || v === "(not set)") return fallback;
  return v;
}

/* ────────────────────────────────────────────────────────────────────────────
 * S1. 채널별 ROI (R1)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 채널별 ROI 입력 행 (sessionDefaultChannelGroup × sessions·ecommercePurchases·purchaseRevenue) */
export interface ChannelRoiInputRow {
  channelGroup: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
}

export interface ChannelRoiRow {
  channelGroup: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  /** 구매 전환율 = ecommercePurchases / sessions (세션 대비) */
  convRate: number;
  /** 세션당 매출 = purchaseRevenue / sessions */
  revenuePerSession: number;
  /**
   * "0매출·고세션" 경고 — 세션은 임계치 이상인데 매출이 0인 채널(= 돈만 쓰는 채널 의심).
   * 실측 사례: Paid Other 3734세션 / 0매출.
   */
  zeroRevenueHighSessions: boolean;
}

/** "0매출·고세션" 플래그 발화 세션 임계치 (계획 v2 §S1) */
export const HIGH_SESSION_THRESHOLD = 1000;

/**
 * 채널별 ROI 집계. 채널 라벨이 빈 행은 "(미지정)"으로 합산, 매출 내림차순 정렬.
 * 순수함수: 입력 rows만으로 결정.
 */
export function aggregateChannelRoi(
  rows: ReadonlyArray<ChannelRoiInputRow>,
  threshold: number = HIGH_SESSION_THRESHOLD,
): ChannelRoiRow[] {
  const m = new Map<
    string,
    { sessions: number; ecommercePurchases: number; purchaseRevenue: number }
  >();
  for (const r of rows) {
    const key = labelOrFallback(r.channelGroup, "(미지정)");
    const prev = m.get(key) ?? {
      sessions: 0,
      ecommercePurchases: 0,
      purchaseRevenue: 0,
    };
    prev.sessions += r.sessions;
    prev.ecommercePurchases += r.ecommercePurchases;
    prev.purchaseRevenue += r.purchaseRevenue;
    m.set(key, prev);
  }

  return [...m.entries()]
    .map(([channelGroup, v]) => ({
      channelGroup,
      sessions: v.sessions,
      ecommercePurchases: v.ecommercePurchases,
      purchaseRevenue: v.purchaseRevenue,
      convRate: safeRate(v.ecommercePurchases, v.sessions),
      revenuePerSession: safeRate(v.purchaseRevenue, v.sessions),
      zeroRevenueHighSessions: v.purchaseRevenue === 0 && v.sessions >= threshold,
    }))
    .sort((a, b) => b.purchaseRevenue - a.purchaseRevenue);
}

/* ────────────────────────────────────────────────────────────────────────────
 * S2. 참고용 전환 깔때기 (R2)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 깔때기 입력 행 (eventName × eventCount) */
export interface FunnelInputRow {
  eventName: string;
  eventCount: number;
}

export interface FunnelStep {
  step: number;
  eventName: string;
  label: string;
  count: number;
  /** 이전 단계 대비 이탈률 = 1 - (현재/이전). 1단계는 0. (이벤트 수 기반 "대략" 비율) */
  dropoffFromPrev: number;
}

/** 고정 깔때기 단계 순서 + 한국어 라벨 (계획 v2 §S2) */
export const FUNNEL_STEPS: ReadonlyArray<{ eventName: string; label: string }> = [
  { eventName: "view_item", label: "상품 조회" },
  { eventName: "add_to_cart", label: "장바구니 담기" },
  { eventName: "begin_checkout", label: "결제 시작" },
  { eventName: "purchase", label: "구매 완료" },
];

/**
 * 참고용 전환 깔때기 집계. eventName→eventCount 입력에서 고정 4단계를 순서대로 뽑아
 * 단계별 이탈률을 계산한다. 누락 이벤트는 count 0.
 *
 * ⚠️ 이벤트 수 기반이라 동일 사용자·세션·순서를 보장하지 않는다("참고용"). 단계 역전
 * (다음 단계 count > 이전 단계 count)도 가능 — 이때 dropoff는 음수가 되며 클램프하지 않고
 * 그대로 노출한다(왜곡 방지). 순수함수.
 */
export function aggregateFunnel(
  rows: ReadonlyArray<FunnelInputRow>,
): FunnelStep[] {
  const countByEvent = new Map<string, number>();
  for (const r of rows) {
    countByEvent.set(r.eventName, (countByEvent.get(r.eventName) ?? 0) + r.eventCount);
  }

  let prevCount = 0;
  return FUNNEL_STEPS.map((s, i) => {
    const count = countByEvent.get(s.eventName) ?? 0;
    const dropoffFromPrev = i === 0 ? 0 : 1 - safeRate(count, prevCount);
    const stepObj: FunnelStep = {
      step: i + 1,
      eventName: s.eventName,
      label: s.label,
      count,
      dropoffFromPrev,
    };
    prevCount = count;
    return stepObj;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * S3. 랜딩페이지 전환 (R3)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 랜딩페이지 입력 행 (landingPage × sessions·ecommercePurchases·purchaseRevenue) */
export interface LandingInputRow {
  landingPage: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
}

export interface LandingRow {
  landingPage: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  convRate: number;
  /** 고세션·0구매 강조 — 트래픽은 많은데 구매로 이어지지 않는 랜딩 */
  highSessionsNoPurchase: boolean;
}

/**
 * 랜딩페이지 전환 집계. 같은 landingPage 합산, 매출 내림차순, 상위 limit개(기본 20).
 * 빈 경로는 "(미지정)" 라벨. 순수함수.
 */
export function aggregateLandingConversion(
  rows: ReadonlyArray<LandingInputRow>,
  limit = 20,
  threshold: number = HIGH_SESSION_THRESHOLD,
): LandingRow[] {
  const m = new Map<
    string,
    { sessions: number; ecommercePurchases: number; purchaseRevenue: number }
  >();
  for (const r of rows) {
    const key = labelOrFallback(r.landingPage, "(미지정)");
    const prev = m.get(key) ?? {
      sessions: 0,
      ecommercePurchases: 0,
      purchaseRevenue: 0,
    };
    prev.sessions += r.sessions;
    prev.ecommercePurchases += r.ecommercePurchases;
    prev.purchaseRevenue += r.purchaseRevenue;
    m.set(key, prev);
  }

  return [...m.entries()]
    .map(([landingPage, v]) => ({
      landingPage,
      sessions: v.sessions,
      ecommercePurchases: v.ecommercePurchases,
      purchaseRevenue: v.purchaseRevenue,
      convRate: safeRate(v.ecommercePurchases, v.sessions),
      highSessionsNoPurchase:
        v.ecommercePurchases === 0 && v.sessions >= threshold,
    }))
    .sort((a, b) => b.purchaseRevenue - a.purchaseRevenue)
    .slice(0, Math.max(0, limit));
}

/* ────────────────────────────────────────────────────────────────────────────
 * S4. 매출·구매 추이 (R4)
 * ──────────────────────────────────────────────────────────────────────────── */

export type TrendGranularity = "day" | "isoWeek";

/**
 * 추이 입력 행. bucket은 디멘션 값(7/30일=date YYYYMMDD 또는 YYYY-MM-DD,
 * 90일=isoYearIsoWeek 예: "202525"). 라우트가 granularity로 디멘션을 결정한다.
 */
export interface TrendInputRow {
  bucket: string;
  ecommercePurchases: number;
  purchaseRevenue: number;
}

export interface TrendPoint {
  /** 표시·정렬용 라벨. day는 "YYYY-MM-DD", isoWeek는 "YYYY-Www" */
  bucket: string;
  ecommercePurchases: number;
  purchaseRevenue: number;
}

/** GA4 isoYearIsoWeek "YYYYWW" (예: "202501") → "YYYY-Www" (예: "2025-W01") */
export function formatIsoWeekLabel(raw: string): string {
  const v = (raw ?? "").trim();
  // "YYYYWW" 6자리 형태만 변환, 그 외는 원본 보존(방어).
  if (/^\d{6}$/.test(v)) {
    return `${v.slice(0, 4)}-W${v.slice(4, 6)}`;
  }
  return v;
}

/** GA4 date 디멘션 "YYYYMMDD" 또는 이미 "YYYY-MM-DD" → "YYYY-MM-DD" */
function formatDayLabel(raw: string): string {
  const v = (raw ?? "").trim();
  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  return v;
}

/**
 * 매출·구매 추이 집계. granularity 에 따라 bucket 라벨을 정규화하고 오름차순 정렬한다.
 * GA4 디멘션을 직접 쓰므로(코드 timezone 버킷팅 X) 같은 bucket 중복 시 합산만 한다.
 * 순수함수.
 */
export function aggregateRevenueTrend(
  rows: ReadonlyArray<TrendInputRow>,
  opts: { granularity: TrendGranularity },
): TrendPoint[] {
  const m = new Map<
    string,
    { ecommercePurchases: number; purchaseRevenue: number }
  >();
  for (const r of rows) {
    const label =
      opts.granularity === "isoWeek"
        ? formatIsoWeekLabel(r.bucket)
        : formatDayLabel(r.bucket);
    const prev = m.get(label) ?? { ecommercePurchases: 0, purchaseRevenue: 0 };
    prev.ecommercePurchases += r.ecommercePurchases;
    prev.purchaseRevenue += r.purchaseRevenue;
    m.set(label, prev);
  }

  return [...m.entries()]
    .map(([bucket, v]) => ({
      bucket,
      ecommercePurchases: v.ecommercePurchases,
      purchaseRevenue: v.purchaseRevenue,
    }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

/* ────────────────────────────────────────────────────────────────────────────
 * S5. 상품(강의)별 조회·구매 (R5)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 상품 입력 행 (itemName × itemsViewed·itemsPurchased·itemRevenue) */
export interface ItemInputRow {
  itemName: string;
  itemsViewed: number;
  itemsPurchased: number;
  itemRevenue: number;
}

export interface ItemRow {
  itemName: string;
  /** 조회 수량 (수량 성격 — LOW-1 라벨 정확화) */
  itemsViewed: number;
  /** 구매 수량 */
  itemsPurchased: number;
  /** 상품 매출 */
  itemRevenue: number;
}

/**
 * 상품별 조회·구매 집계. 빈 itemName → "(미지정)", 상품 매출 내림차순, 상위 limit개(기본 20).
 * 순수함수.
 */
export function aggregateItems(
  rows: ReadonlyArray<ItemInputRow>,
  limit = 20,
): ItemRow[] {
  const m = new Map<
    string,
    { itemsViewed: number; itemsPurchased: number; itemRevenue: number }
  >();
  for (const r of rows) {
    const key = labelOrFallback(r.itemName, "(미지정)");
    const prev = m.get(key) ?? {
      itemsViewed: 0,
      itemsPurchased: 0,
      itemRevenue: 0,
    };
    prev.itemsViewed += r.itemsViewed;
    prev.itemsPurchased += r.itemsPurchased;
    prev.itemRevenue += r.itemRevenue;
    m.set(key, prev);
  }

  return [...m.entries()]
    .map(([itemName, v]) => ({
      itemName,
      itemsViewed: v.itemsViewed,
      itemsPurchased: v.itemsPurchased,
      itemRevenue: v.itemRevenue,
    }))
    .sort((a, b) => b.itemRevenue - a.itemRevenue)
    .slice(0, Math.max(0, limit));
}

/* ────────────────────────────────────────────────────────────────────────────
 * S6. 신규 vs 재방문 (R6)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 신규/재방문 입력 행 (newVsReturning × sessions·ecommercePurchases·purchaseRevenue) */
export interface NewReturningInputRow {
  userType: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
}

export interface NewReturningRow {
  /** "new" | "returning" | "(미지정)" */
  userType: string;
  /** 한국어 표시 라벨 */
  label: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  convRate: number;
}

/** newVsReturning 디멘션 값 → 한국어 라벨 */
function newReturningLabel(userType: string): string {
  switch (userType) {
    case "new":
      return "신규 방문";
    case "returning":
      return "재방문";
    default:
      return "(미지정)";
  }
}

/**
 * 신규 vs 재방문 집계. GA4 newVsReturning 값(new/returning/(not set)/빈값)을 정규화한다.
 * (not set)·빈값은 "(미지정)"으로 합산(LOW-3). 정렬: new → returning → (미지정).
 * 순수함수.
 */
export function aggregateNewReturning(
  rows: ReadonlyArray<NewReturningInputRow>,
): NewReturningRow[] {
  const m = new Map<
    string,
    { sessions: number; ecommercePurchases: number; purchaseRevenue: number }
  >();
  for (const r of rows) {
    const raw = (r.userType ?? "").trim();
    const key = raw === "new" || raw === "returning" ? raw : "(미지정)";
    const prev = m.get(key) ?? {
      sessions: 0,
      ecommercePurchases: 0,
      purchaseRevenue: 0,
    };
    prev.sessions += r.sessions;
    prev.ecommercePurchases += r.ecommercePurchases;
    prev.purchaseRevenue += r.purchaseRevenue;
    m.set(key, prev);
  }

  const order: Record<string, number> = { new: 0, returning: 1, "(미지정)": 2 };
  return [...m.entries()]
    .map(([userType, v]) => ({
      userType,
      label: newReturningLabel(userType),
      sessions: v.sessions,
      ecommercePurchases: v.ecommercePurchases,
      purchaseRevenue: v.purchaseRevenue,
      convRate: safeRate(v.ecommercePurchases, v.sessions),
    }))
    .sort((a, b) => (order[a.userType] ?? 99) - (order[b.userType] ?? 99));
}

/* ────────────────────────────────────────────────────────────────────────────
 * S7. 총계 + invariant (MED-1)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MarketingTotals {
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  /** 진단용 — eventCount(purchase). ecommercePurchases와 차이 모니터(현재 0 차이) */
  purchaseEventCount: number;
  /** 총 구매 전환율 = ecommercePurchases / sessions */
  convRate: number;
}

/**
 * 디멘션 없는 단일 총계 쿼리 결과를 정리. (단일 행이므로 합산은 방어적)
 * 순수함수.
 */
export function buildTotals(input: {
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  purchaseEventCount: number;
}): MarketingTotals {
  return {
    sessions: input.sessions,
    ecommercePurchases: input.ecommercePurchases,
    purchaseRevenue: input.purchaseRevenue,
    purchaseEventCount: input.purchaseEventCount,
    convRate: safeRate(input.ecommercePurchases, input.sessions),
  };
}

export interface OtherRowInvariant {
  /** 채널 합산 sessions vs 총계 sessions 의 상대 차이 (0~1) */
  sessionsDiffRatio: number;
  /** 채널 합산 매출 vs 총계 매출 의 상대 차이 (0~1) */
  revenueDiffRatio: number;
  /**
   * (other) row 등으로 디멘션 합이 총계보다 유의하게 작은지 여부.
   * 임계치(기본 1%) 초과 시 true → UI 데이터 품질 경고 동반(MED-1).
   */
  dataLossFromOtherRow: boolean;
}

/** dataLossFromOtherRow 발화 상대차 임계치 (1%) */
export const OTHER_ROW_DIFF_THRESHOLD = 0.01;

/**
 * S1(채널 디멘션) 합산과 S7(총계) 를 비교해 (other) row 손실을 감지(MED-1).
 * 고카디널리티 디멘션은 GA4가 상위 행만 주고 나머지를 (other)로 묶거나 누락할 수 있어,
 * 디멘션 합이 총계보다 작아진다. 상대차가 임계치를 넘으면 경고 플래그를 켠다.
 *
 * 총계가 0이면 비교 불가 → 차이 0·경고 off (빈 기간 안전). 순수함수.
 */
export function checkOtherRowInvariant(
  channelRows: ReadonlyArray<{ sessions: number; purchaseRevenue: number }>,
  totals: { sessions: number; purchaseRevenue: number },
  threshold: number = OTHER_ROW_DIFF_THRESHOLD,
): OtherRowInvariant {
  const sumSessions = channelRows.reduce((a, r) => a + r.sessions, 0);
  const sumRevenue = channelRows.reduce((a, r) => a + r.purchaseRevenue, 0);

  // 상대차 = |총계 - 디멘션합| / 총계. 총계 0이면 0 (비교 불가).
  const sessionsDiffRatio =
    totals.sessions > 0
      ? Math.abs(totals.sessions - sumSessions) / totals.sessions
      : 0;
  const revenueDiffRatio =
    totals.purchaseRevenue > 0
      ? Math.abs(totals.purchaseRevenue - sumRevenue) / totals.purchaseRevenue
      : 0;

  return {
    sessionsDiffRatio,
    revenueDiffRatio,
    dataLossFromOtherRow:
      sessionsDiffRatio > threshold || revenueDiffRatio > threshold,
  };
}
