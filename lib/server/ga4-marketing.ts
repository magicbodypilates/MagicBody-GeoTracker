/**
 * ga4-marketing.ts — "마케팅 성과" 탭 GA4 fetch (계획 geotracker-marketing-performance-tab-v2).
 *
 * GA4 Data API(analyticsdata v1beta)에서 7개 리포트를 조회해 `Ga4MarketingSnapshot`으로 정리한다.
 * 계산은 ga4-marketing-aggregate.ts 순수함수에 위임하고, 여기서는 쿼리 발사·파싱·warnings 수집만.
 *
 * 정본 지표(§2 실측 확정):
 *   - 구매 횟수 = ecommercePurchases (purchases 지표는 GA4가 INVALID로 거부 — 절대 사용 금지)
 *   - 매출      = purchaseRevenue (KRW, 순수 web ecommerce)
 *
 * 동시 호출 제한(D4·MED-6): 7개 쿼리를 runWithConcurrency(.., 4)로 제한. concurrent 한도 10 실측.
 * 핵심 쿼리(채널·추이·총계)는 폴백 금지(거짓 0 방지), 보조(상품·신규재방문 등)만 catch→null.
 */

import { google } from "googleapis";
import type { analyticsdata_v1beta } from "googleapis";
import { getAuthedClient } from "./gsc-client";
import { rowValue, rowMetric, runWithConcurrency } from "./ga4-report-utils";
import {
  aggregateChannelRoi,
  aggregateFunnel,
  aggregateLandingConversion,
  aggregateRevenueTrend,
  aggregateItems,
  aggregateNewReturning,
  buildTotals,
  checkOtherRowInvariant,
  FUNNEL_STEPS,
  type TrendGranularity,
  type ChannelRoiRow,
  type FunnelStep,
  type LandingRow,
  type TrendPoint,
  type ItemRow,
  type NewReturningRow,
  type MarketingTotals,
  type OtherRowInvariant,
} from "./ga4-marketing-aggregate";

type RunReportResponse = analyticsdata_v1beta.Schema$RunReportResponse;
type RunReportRequestBody = analyticsdata_v1beta.Schema$RunReportRequest;

/** 응답 메타데이터 + quota 관측 스냅샷 (UI 데이터 품질 경고용 — MED-1) */
export interface Ga4MarketingWarnings {
  /** (other) row 손실 감지 결과 — S1 합산 vs S7 총계 invariant */
  otherRow: OtherRowInvariant;
  /** 샘플링 적용 여부 (샘플링되면 추정값) */
  sampled: boolean;
  /** thresholding(개인정보 보호 임계) 적용 여부 — 일부 행이 가려졌을 수 있음 */
  subjectToThresholding: boolean;
  /** 통화 코드 (실측 KRW) */
  currencyCode: string;
  /** 속성 타임존 (실측 Asia/Seoul) */
  timeZone: string;
  /** 잔여 GA4 quota (concurrent / tokens). returnPropertyQuota 관측 */
  propertyQuota: {
    concurrentRequestsRemaining: number | null;
    tokensPerHourRemaining: number | null;
  } | null;
}

export interface Ga4MarketingSnapshot {
  propertyId: string;
  startDate: string;
  endDate: string;
  /** 추이 단위 — 라우트가 기간으로 결정 (7/30일=day, 90일=isoWeek) */
  granularity: TrendGranularity;
  totals: MarketingTotals;
  channelRoi: ChannelRoiRow[];
  funnel: FunnelStep[];
  landing: LandingRow[];
  trend: TrendPoint[];
  items: ItemRow[];
  newReturning: NewReturningRow[];
  warnings: Ga4MarketingWarnings;
  fetchedAt: string;
}

/** GA4 메트릭 정본 이름 — purchases(INVALID) 대신 ecommercePurchases 사용 */
const M_SESSIONS = "sessions";
const M_PURCHASES = "ecommercePurchases";
const M_REVENUE = "purchaseRevenue";

/**
 * 응답 메타에서 샘플링·thresholding·통화·타임존을 추출.
 * 단일 응답(보통 총계 쿼리)에서 뽑는다. metadata 필드는 응답마다 동일하므로 1개면 충분.
 */
function extractMeta(resp: RunReportResponse | null): {
  sampled: boolean;
  subjectToThresholding: boolean;
  currencyCode: string;
  timeZone: string;
} {
  const meta = resp?.metadata;
  const samplingMetadatas = meta?.samplingMetadatas ?? [];
  const sampled = samplingMetadatas.length > 0;
  const subjectToThresholding = Boolean(meta?.subjectToThresholding);
  return {
    sampled,
    subjectToThresholding,
    currencyCode: meta?.currencyCode ?? "KRW",
    timeZone: meta?.timeZone ?? "Asia/Seoul",
  };
}

/** 응답의 propertyQuota에서 잔여 concurrent/token을 추출 (returnPropertyQuota 관측) */
function extractQuota(
  resp: RunReportResponse | null,
): Ga4MarketingWarnings["propertyQuota"] {
  const q = resp?.propertyQuota;
  if (!q) return null;
  return {
    concurrentRequestsRemaining: q.concurrentRequests?.remaining ?? null,
    tokensPerHourRemaining: q.tokensPerHour?.remaining ?? null,
  };
}

/**
 * "마케팅 성과" 리포트 조회.
 *
 * @param granularity 추이 단위. 라우트가 기간으로 결정(7/30일=day, 90일=isoWeek). 기본 day.
 */
export async function fetchMarketingReport(params: {
  propertyId: string;
  startDate: string;
  endDate: string;
  granularity?: TrendGranularity;
}): Promise<Ga4MarketingSnapshot> {
  const auth = await getAuthedClient();
  const analytics = google.analyticsdata({ version: "v1beta", auth });

  const property = `properties/${params.propertyId}`;
  const dateRange = { startDate: params.startDate, endDate: params.endDate };
  const granularity: TrendGranularity = params.granularity ?? "day";

  /** 공통 runReport 래퍼 — returnPropertyQuota 항상 켬 */
  const run = (requestBody: RunReportRequestBody): Promise<RunReportResponse> =>
    analytics.properties
      .runReport({
        property,
        requestBody: { ...requestBody, returnPropertyQuota: true },
      })
      .then((r) => r.data);

  // 추이(S4) 디멘션 — 90일은 isoYearIsoWeek(ISO 월요일 시작), 그 외 date.
  const trendDimension =
    granularity === "isoWeek" ? "isoYearIsoWeek" : "date";

  // ── 쿼리 정의 (S1~S7) ─────────────────────────────────────────────────────
  // 핵심(채널·추이·총계)은 폴백 없이 던진다 — 실패는 거짓 0 대신 에러 전파.
  // 보조(깔때기·랜딩·상품·신규재방문)는 catch→null 로 부분 실패 허용.

  // S1. 채널별 ROI
  const qChannel = (): Promise<RunReportResponse> =>
    run({
      dateRanges: [dateRange],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: M_SESSIONS }, { name: M_PURCHASES }, { name: M_REVENUE }],
      orderBys: [{ metric: { metricName: M_REVENUE }, desc: true }],
      limit: "100",
    });

  // S2. 참고용 전환 깔때기 (eventCount × eventName inList)
  const qFunnel = (): Promise<RunReportResponse | null> =>
    run({
      dateRanges: [dateRange],
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: {
        filter: {
          fieldName: "eventName",
          inListFilter: {
            values: FUNNEL_STEPS.map((s) => s.eventName),
            caseSensitive: true,
          },
        },
      },
      limit: "10",
    }).catch(() => null);

  // S3. 랜딩페이지 전환 (landingPage — 쿼리스트링 제거, Top 20)
  const qLanding = (): Promise<RunReportResponse | null> =>
    run({
      dateRanges: [dateRange],
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: M_SESSIONS }, { name: M_PURCHASES }, { name: M_REVENUE }],
      orderBys: [{ metric: { metricName: M_REVENUE }, desc: true }],
      limit: "50",
    }).catch(() => null);

  // S4. 매출·구매 추이 (date 또는 isoYearIsoWeek)
  const qTrend = (): Promise<RunReportResponse> =>
    run({
      dateRanges: [dateRange],
      dimensions: [{ name: trendDimension }],
      metrics: [{ name: M_PURCHASES }, { name: M_REVENUE }],
      orderBys: [{ dimension: { dimensionName: trendDimension }, desc: false }],
      limit: "200",
    });

  // S5. 상품(강의)별 조회·구매
  const qItems = (): Promise<RunReportResponse | null> =>
    run({
      dateRanges: [dateRange],
      dimensions: [{ name: "itemName" }],
      metrics: [
        { name: "itemsViewed" },
        { name: "itemsPurchased" },
        { name: "itemRevenue" },
      ],
      orderBys: [{ metric: { metricName: "itemRevenue" }, desc: true }],
      limit: "50",
    }).catch(() => null);

  // S6. 신규 vs 재방문
  const qNewReturning = (): Promise<RunReportResponse | null> =>
    run({
      dateRanges: [dateRange],
      dimensions: [{ name: "newVsReturning" }],
      metrics: [{ name: M_SESSIONS }, { name: M_PURCHASES }, { name: M_REVENUE }],
      limit: "10",
    }).catch(() => null);

  // S7. 총계 (디멘션 없음) + 진단 eventCount(purchase)
  const qTotals = (): Promise<RunReportResponse> =>
    run({
      dateRanges: [dateRange],
      metrics: [{ name: M_SESSIONS }, { name: M_PURCHASES }, { name: M_REVENUE }],
      limit: "1",
    });
  const qPurchaseEvent = (): Promise<RunReportResponse | null> =>
    run({
      dateRanges: [dateRange],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: {
        filter: {
          fieldName: "eventName",
          stringFilter: { matchType: "EXACT", value: "purchase", caseSensitive: true },
        },
      },
      limit: "1",
    }).catch(() => null);

  // ── 동시성 4 제한 실행 (입력 순서 = 결과 순서 보존) ──────────────────────────
  const [
    channelResp,
    funnelResp,
    landingResp,
    trendResp,
    itemsResp,
    newReturningResp,
    totalsResp,
    purchaseEventResp,
  ] = (await runWithConcurrency(
    [
      qChannel,
      qFunnel,
      qLanding,
      qTrend,
      qItems,
      qNewReturning,
      qTotals,
      qPurchaseEvent,
    ],
    4,
  )) as [
    RunReportResponse,
    RunReportResponse | null,
    RunReportResponse | null,
    RunReportResponse,
    RunReportResponse | null,
    RunReportResponse | null,
    RunReportResponse,
    RunReportResponse | null,
  ];

  // ── 파싱 → 순수함수 집계 ─────────────────────────────────────────────────────
  const channelRoi = aggregateChannelRoi(
    (channelResp.rows ?? []).map((r) => ({
      channelGroup: rowValue(r, 0),
      sessions: rowMetric(r, 0),
      ecommercePurchases: rowMetric(r, 1),
      purchaseRevenue: rowMetric(r, 2),
    })),
  );

  const funnel = aggregateFunnel(
    (funnelResp?.rows ?? []).map((r) => ({
      eventName: rowValue(r, 0),
      eventCount: rowMetric(r, 0),
    })),
  );

  const landing = aggregateLandingConversion(
    (landingResp?.rows ?? []).map((r) => ({
      landingPage: rowValue(r, 0),
      sessions: rowMetric(r, 0),
      ecommercePurchases: rowMetric(r, 1),
      purchaseRevenue: rowMetric(r, 2),
    })),
    20,
  );

  const trend = aggregateRevenueTrend(
    (trendResp.rows ?? []).map((r) => ({
      bucket: rowValue(r, 0),
      ecommercePurchases: rowMetric(r, 0),
      purchaseRevenue: rowMetric(r, 1),
    })),
    { granularity },
  );

  const items = aggregateItems(
    (itemsResp?.rows ?? []).map((r) => ({
      itemName: rowValue(r, 0),
      itemsViewed: rowMetric(r, 0),
      itemsPurchased: rowMetric(r, 1),
      itemRevenue: rowMetric(r, 2),
    })),
    20,
  );

  const newReturning = aggregateNewReturning(
    (newReturningResp?.rows ?? []).map((r) => ({
      userType: rowValue(r, 0),
      sessions: rowMetric(r, 0),
      ecommercePurchases: rowMetric(r, 1),
      purchaseRevenue: rowMetric(r, 2),
    })),
  );

  // 총계 (단일 행)
  const totalsRow = (totalsResp.rows ?? [])[0] ?? {};
  const purchaseEventCount = rowMetric(
    (purchaseEventResp?.rows ?? [])[0] ?? {},
    0,
  );
  const totals = buildTotals({
    sessions: rowMetric(totalsRow, 0),
    ecommercePurchases: rowMetric(totalsRow, 1),
    purchaseRevenue: rowMetric(totalsRow, 2),
    purchaseEventCount,
  });

  // ── warnings (MED-1) ────────────────────────────────────────────────────────
  const otherRow = checkOtherRowInvariant(
    channelRoi.map((c) => ({
      sessions: c.sessions,
      purchaseRevenue: c.purchaseRevenue,
    })),
    { sessions: totals.sessions, purchaseRevenue: totals.purchaseRevenue },
  );
  const meta = extractMeta(totalsResp);
  const warnings: Ga4MarketingWarnings = {
    otherRow,
    sampled: meta.sampled,
    subjectToThresholding: meta.subjectToThresholding,
    currencyCode: meta.currencyCode,
    timeZone: meta.timeZone,
    propertyQuota: extractQuota(totalsResp),
  };

  return {
    propertyId: params.propertyId,
    startDate: params.startDate,
    endDate: params.endDate,
    granularity,
    totals,
    channelRoi,
    funnel,
    landing,
    trend,
    items,
    newReturning,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
