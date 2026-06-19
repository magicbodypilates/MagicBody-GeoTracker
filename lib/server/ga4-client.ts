import { google } from "googleapis";
import type { analyticsdata_v1beta } from "googleapis";
import { getAuthedClient } from "./gsc-client";
import {
  aggregateAiReferralTiers,
  aggregateEngagementByPlatform,
  mergeActiveUsersByPlatform,
  mergeActiveUsersByDate,
  fillDateSeries,
} from "./ga4-aggregate";
import {
  rowValue,
  rowMetric,
  formatDate,
  runWithConcurrency,
} from "./ga4-report-utils";
import { enumerateDateRange, resolveGa4DateToken } from "../client/date-kst";

/** AI 플랫폼 referrer 도메인 목록. GA4 sessionSource 디멘션 값과 매칭. */
export const AI_REFERRER_DOMAINS = [
  // OpenAI / ChatGPT
  "chatgpt.com",
  "chat.openai.com",
  // Perplexity
  "perplexity.ai",
  "www.perplexity.ai",
  // Google Gemini
  "gemini.google.com",
  "bard.google.com",
  // Microsoft Copilot / Bing
  "copilot.microsoft.com",
  "bing.com",
  "www.bing.com",
  // Anthropic Claude
  "claude.ai",
  // xAI Grok
  "grok.com",
  "x.ai",
  // Meta AI
  "meta.ai",
  // DeepSeek
  "chat.deepseek.com",
  "deepseek.com",
  // Others
  "you.com",
  "poe.com",
  "character.ai",
] as const;

/** AI 플랫폼 그룹 레이블 — referrer 도메인을 플랫폼 이름으로 매핑 */
const PLATFORM_MAP: Record<string, string> = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "perplexity.ai": "Perplexity",
  "www.perplexity.ai": "Perplexity",
  "gemini.google.com": "Gemini",
  "bard.google.com": "Gemini",
  "copilot.microsoft.com": "Copilot",
  "bing.com": "Bing",
  "www.bing.com": "Bing",
  "claude.ai": "Claude",
  "grok.com": "Grok",
  "x.ai": "Grok",
  "meta.ai": "Meta AI",
  "chat.deepseek.com": "DeepSeek",
  "deepseek.com": "DeepSeek",
  "you.com": "You.com",
  "poe.com": "Poe",
  "character.ai": "Character.AI",
};

export function platformOf(source: string): string {
  return PLATFORM_MAP[source.toLowerCase()] ?? source;
}

/**
 * GA4 기본 채널그룹 "AI Assistant" 값.
 * 구글이 자체 분류하는 AI 유입 신호 — sessionSource 도메인 필터와 별개의 2차 신호.
 * 도메인 필터(referrer 살아있는 출처만)와 채널그룹(구글 분류)을 합집합으로 잡아야 누락이 최소화된다.
 * (단계1 진단: 도메인필터 35세션 / 채널그룹 12세션 — 각자 불완전, 합집합 필요)
 */
export const AI_CHANNEL_GROUP = "AI Assistant";

/** 채널그룹은 AI인데 sessionSource로 플랫폼을 특정할 수 없는 세션의 라벨 */
export const AI_UNCLASSIFIED_PLATFORM = "기타 AI (분류상)";

/** AI 유입 신뢰도 등급 (AD-1) */
export type AiReferralTier =
  | "confirmed_ai_referral" // source/referrer 또는 GA4 채널그룹으로 AI 유입이 확인된 세션
  | "suspected_ai_organic" // GA4만으론 분리 불가하나 별도 근거가 있는 제한적 케이스 (단계1: 근거 없음 → 미산출)
  | "organic_search"; // 일반 검색 (AI 구간에서 제외)

/**
 * 한 행의 (sessionSource, sessionDefaultChannelGroup) 조합을 신뢰도 등급으로 분류.
 * - source가 알려진 AI 플랫폼 도메인 → confirmed (referrer 신호 살아있음)
 * - source는 모호하나 GA4 채널그룹이 "AI Assistant" → confirmed (구글이 AI로 확정)
 * - 그 외 → organic_search (AI 구간 제외)
 *
 * suspected_ai_organic은 단계1 실데이터에서 분리 근거가 실증되지 않아 이 함수에서 산출하지 않는다
 * (gemini=google/organic, copilot=bing/organic은 일반 검색과 분리 불가 → 과장 회피).
 */
export function classifyAiReferral(
  source: string,
  channelGroup: string,
): AiReferralTier {
  if (PLATFORM_MAP[source.toLowerCase()]) return "confirmed_ai_referral";
  if (channelGroup === AI_CHANNEL_GROUP) return "confirmed_ai_referral";
  return "organic_search";
}

/**
 * 행의 플랫폼 라벨 결정.
 * source로 플랫폼을 특정할 수 있으면 그 이름, 채널그룹만 AI면 "기타 AI (분류상)".
 */
export function platformOfRow(source: string, channelGroup: string): string {
  const mapped = PLATFORM_MAP[source.toLowerCase()];
  if (mapped) return mapped;
  if (channelGroup === AI_CHANNEL_GROUP) return AI_UNCLASSIFIED_PLATFORM;
  return source;
}

export function getDefaultPropertyId(): string | null {
  const raw = process.env.GA4_PROPERTY_ID ?? "";
  return raw.trim() || null;
}

export interface Ga4ReferralRow {
  date: string;
  source: string;
  platform: string;
  /** GA4 기본 채널그룹 (예: "AI Assistant", "Organic Search") */
  channelGroup: string;
  /** 신뢰도 등급 — 이 행이 어떤 신호로 AI 유입으로 잡혔는지 */
  tier: AiReferralTier;
  landingPage: string;
  sessions: number;
  activeUsers: number;
  screenPageViews: number;
  averageSessionDuration: number;
  engagementRate: number;
}

/** 신뢰도 등급별 집계 + 분리불가 안내 (AD-1·LOW-3) */
export interface AiReferralTiers {
  /** source 또는 GA4 채널그룹으로 확인된 AI 유입 세션 */
  confirmedSessions: number;
  /** confirmed 중 sessionSource로 플랫폼을 특정할 수 없어 "기타 AI(분류상)"로 잡힌 세션 */
  unclassifiedSessions: number;
  /** GA4만으로 분리 근거가 실증된 추정 세션 (단계1: 근거 없음 → 항상 0, 빈 등급) */
  suspectedSessions: number;
  /**
   * 분리 불가 안내 — gemini/copilot처럼 구글·빙 검색에 묶여 별도 측정이 불가능한 분량.
   * 수치가 아니라 "분리 측정 불가"라는 사실만 명시 (근거 없는 추정 등급 금지).
   */
  inseparableNote: string;
}

export interface Ga4ReferralSnapshot {
  propertyId: string;
  startDate: string;
  endDate: string;
  totals: {
    sessions: number;
    activeUsers: number;
    screenPageViews: number;
  };
  /** 신뢰도 등급별 집계 + 분리불가 안내 (AD-1·LOW-3) */
  tiers: AiReferralTiers;
  byPlatform: Array<{
    platform: string;
    sessions: number;
    activeUsers: number;
    screenPageViews: number;
  }>;
  byDate: Array<{ date: string; sessions: number; activeUsers: number }>;
  /**
   * 일자별 AI 전환(결제) 추이 — AI 유입 세션에서 발생한 구매 건수·매출.
   * byDate와 동일하게 조회 구간 전체 일자를 KST 기준으로 채워(데이터 없는 날 0) 연속 타임라인.
   * 지표 정본: purchases=ecommercePurchases(GA4가 purchases는 거부), revenue=purchaseRevenue(KRW).
   * ⚠️ GA4 기여 추정값 — 결제통계 정산액과 다를 수 있음(집계 지연·환불 반영 차이).
   */
  byDateConversions: Array<{ date: string; purchases: number; revenue: number }>;
  topLandingPages: Array<{
    platform: string;
    landingPage: string;
    sessions: number;
    activeUsers: number;
  }>;
  /** 플랫폼별 engagement — 세션당 체류시간 / 페이지뷰 / 참여율 */
  byPlatformEngagement?: Array<{
    platform: string;
    sessions: number;
    averageSessionDuration: number; // 초
    pageViewsPerSession: number;
    engagementRate: number; // 0~1
  }>;
  /** 시간대별 히트맵: dayOfWeek(0=일) × hour(0~23) → 세션 */
  hourlyHeatmap?: Array<{
    dayOfWeek: number;
    hour: number;
    sessions: number;
  }>;
  /** 신규 vs 재방문 */
  newVsReturning?: Array<{
    userType: string; // "new" | "returning"
    sessions: number;
    activeUsers: number;
  }>;
  /** 주요 이벤트 Top (전환 깔때기용) */
  topEvents?: Array<{
    eventName: string;
    eventCount: number;
    sessions: number;
  }>;
  /** 전체 페이지 Top 10 (pagePath 기준, 랜딩 여부 무관) */
  topPages?: Array<{
    pagePath: string;
    sessions: number;
    activeUsers: number;
    screenPageViews: number;
  }>;
  rows: Ga4ReferralRow[];
  fetchedAt: string;
}

/**
 * AI 유입 탐지 필터 — 2신호 합집합 (AD-1).
 *   (a) sessionSource in AI_REFERRER_DOMAINS (referrer 신호 살아있는 출처)
 *   (b) sessionDefaultChannelGroup = "AI Assistant" (구글 자체 분류, 주 신호)
 * 단일 orGroup으로 묶어 GA4가 디멘션 튜플 단위로 dedup하게 한다 — 두 쿼리를 코드에서
 * 합치면 두 신호 모두에 잡힌 세션을 중복 카운트할 위험이 있어 단일 필터가 정확하고 단순하다.
 */
const AI_REFERRAL_FILTER = {
  orGroup: {
    expressions: [
      {
        filter: {
          fieldName: "sessionSource",
          inListFilter: {
            values: [...AI_REFERRER_DOMAINS],
            caseSensitive: false,
          },
        },
      },
      {
        filter: {
          fieldName: "sessionDefaultChannelGroup",
          stringFilter: {
            matchType: "EXACT",
            value: AI_CHANNEL_GROUP,
            caseSensitive: false,
          },
        },
      },
    ],
  },
};

/**
 * AI 플랫폼 유입 트래픽을 GA4에서 조회.
 * 2신호 합집합(도메인 referrer + GA4 "AI Assistant" 채널그룹)으로 탐지하고,
 * 행별로 신뢰도 등급(confirmed/organic)과 플랫폼 라벨을 매핑한다.
 */
export async function fetchAiReferralReport(params: {
  propertyId: string;
  startDate: string;
  endDate: string;
}): Promise<Ga4ReferralSnapshot> {
  const auth = await getAuthedClient();
  const analytics = google.analyticsdata({ version: "v1beta", auth });

  // runReport 응답 타입 — runWithConcurrency가 작업 배열을 union으로 추론(GaxiosResponse|null)
  //   하지 않게 구조분해 시 명시 캐스팅에 사용한다(핵심 쿼리의 .data 직접 접근 보존).
  //   호출부는 .data.rows 만 쓰므로 .data 를 가진 최소 형태로 캡처한다.
  type RunReportResp = {
    data: analyticsdata_v1beta.Schema$RunReportResponse;
  };

  const property = `properties/${params.propertyId}`;
  const dateRange = { startDate: params.startDate, endDate: params.endDate };

  // 2신호 합집합 필터 (모든 서브쿼리 공통)
  const sourceFilter = AI_REFERRAL_FILTER;

  // 1) 원본 일자 × 소스 × 랜딩페이지 rows + 추가 분석 쿼리 실행.
  //   activeUsers는 비가산(고유 사용자) 지표라 detail rows 합산이 중복 카운트를 일으킨다.
  //   표시 레벨(전체/일자/플랫폼)별 전용 쿼리로 GA4가 직접 dedup한 값을 받는다(MED 정정).
  //   detail·activeUsers 전용 3쿼리는 핵심 수치라 .catch()로 0 폴백하지 않는다(거짓 0 방지).
  //   동시 호출 제한(MED-1): 10개 쿼리를 Promise.all로 한꺼번에 발사하면 GA4 concurrent 한도
  //   (실측 10)에 정확히 도달해, 마케팅 탭 조회와 겹치면 429 위험. 마케팅 탭과 동일하게
  //   runWithConcurrency(.., 4)로 동시성을 4로 제한한다. 입력 순서 = 결과 순서가 보존되므로
  //   아래 구조분해 인덱스 의존은 그대로 유효하다.
  //   보조 쿼리의 .catch(()=>null) 폴백은 각 작업 함수 안에 유지 — runWithConcurrency는 reject를
  //   그대로 전파하므로, 핵심 쿼리는 폴백 없이(거짓 0 방지) 에러를 전파하고 보조 쿼리만 함수
  //   내부에서 null로 폴백한다.
  const [
    detailResp,
    engagementResp,
    hourlyResp,
    newReturnResp,
    eventsResp,
    pagesResp,
    totalsActiveUsersResp,
    dateActiveUsersResp,
    platformActiveUsersResp,
    dateConversionsResp,
  ] = (await runWithConcurrency([
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [
            { name: "date" },
            { name: "sessionSource" },
            { name: "landingPagePlusQueryString" },
            { name: "sessionDefaultChannelGroup" },
          ],
          metrics: [
            { name: "sessions" },
            { name: "activeUsers" },
            { name: "screenPageViews" },
            { name: "averageSessionDuration" },
            { name: "engagementRate" },
          ],
          dimensionFilter: sourceFilter,
          orderBys: [
            { dimension: { dimensionName: "date" }, desc: true },
            { metric: { metricName: "sessions" }, desc: true },
          ],
          limit: "1000",
        },
      }),
    // 2) 플랫폼별 engagement (채널그룹 디멘션 동반 — 채널그룹만 AI인 행 라벨 정확화)
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [
            { name: "sessionSource" },
            { name: "sessionDefaultChannelGroup" },
          ],
          metrics: [
            { name: "sessions" },
            { name: "averageSessionDuration" },
            { name: "screenPageViewsPerSession" },
            { name: "engagementRate" },
          ],
          dimensionFilter: sourceFilter,
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: "50",
        },
      }).catch(() => null),
    // 3) 시간대 히트맵
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [{ name: "dayOfWeek" }, { name: "hour" }],
          metrics: [{ name: "sessions" }],
          dimensionFilter: sourceFilter,
          limit: "200",
        },
      }).catch(() => null),
    // 4) 신규 vs 재방문
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [{ name: "newVsReturning" }],
          metrics: [{ name: "sessions" }, { name: "activeUsers" }],
          dimensionFilter: sourceFilter,
          limit: "10",
        },
      }).catch(() => null),
    // 5) 주요 이벤트 Top
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [{ name: "eventName" }],
          metrics: [{ name: "eventCount" }, { name: "sessions" }],
          dimensionFilter: sourceFilter,
          orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
          limit: "20",
        },
      }).catch(() => null),
    // 6) 전체 페이지 Top (pagePath, 랜딩 여부 무관)
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [{ name: "pagePath" }],
          metrics: [
            { name: "sessions" },
            { name: "activeUsers" },
            { name: "screenPageViews" },
          ],
          dimensionFilter: sourceFilter,
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit: "10",
        },
      }).catch(() => null),
    // 7) totals.activeUsers — 디멘션 없이 단일 조회 → 기간 전체 고유 사용자 (완전 dedup)
    //    하위 행 합산이 아니라 GA4가 직접 dedup한 진짜 고유 사용자 수.
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          metrics: [{ name: "activeUsers" }],
          dimensionFilter: sourceFilter,
          limit: "1",
        },
      }),
    // 8) byDate.activeUsers — date 디멘션만 → 일자별 고유 사용자 (하루 단위 dedup은 정확)
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [{ name: "date" }],
          metrics: [{ name: "activeUsers" }],
          dimensionFilter: sourceFilter,
          limit: "1000",
        },
      }),
    // 9) byPlatform.activeUsers — source + channelGroup만 → 플랫폼별 고유 사용자.
    //    engagement 쿼리와 동일 디멘션으로 platformOfRow 라벨을 일치시킨다. 같은 플랫폼이
    //    여러 source면 합산(mergeActiveUsersByPlatform) — cross-source 중복 한계는 함수 주석 참조.
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [
            { name: "sessionSource" },
            { name: "sessionDefaultChannelGroup" },
          ],
          metrics: [{ name: "activeUsers" }],
          dimensionFilter: sourceFilter,
          limit: "100",
        },
      }),
    // 10) byDateConversions — date 디멘션 + AI 필터, 일자별 AI 전환(결제).
    //    구매 지표 정본명은 ecommercePurchases (GA4가 purchases는 INVALID로 거부 — 마케팅 탭 실측).
    //    purchases·revenue는 가산 지표라 date 단일 디멘션 일자별 합산이 정상(activeUsers 비가산 한계 없음).
    //    보조 분석이라 실패해도 전체 조회를 막지 않게 .catch(()=>null)로 폴백(거짓 0 대신 빈 시계열).
    () =>
      analytics.properties.runReport({
        property,
        requestBody: {
          dateRanges: [dateRange],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "ecommercePurchases" },
            { name: "purchaseRevenue" },
          ],
          dimensionFilter: sourceFilter,
          orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
          limit: "1000",
        },
      }).catch(() => null),
  ], 4)) as [
    RunReportResp,
    RunReportResp | null,
    RunReportResp | null,
    RunReportResp | null,
    RunReportResp | null,
    RunReportResp | null,
    RunReportResp,
    RunReportResp,
    RunReportResp,
    RunReportResp | null,
  ];

  const rows: Ga4ReferralRow[] = (detailResp.data.rows ?? []).map((r) => {
    const source = rowValue(r, 1);
    const channelGroup = rowValue(r, 3);
    return {
      date: formatDate(rowValue(r, 0)),
      source,
      platform: platformOfRow(source, channelGroup),
      channelGroup,
      tier: classifyAiReferral(source, channelGroup),
      landingPage: rowValue(r, 2),
      sessions: rowMetric(r, 0),
      activeUsers: rowMetric(r, 1),
      screenPageViews: rowMetric(r, 2),
      averageSessionDuration: rowMetric(r, 3),
      engagementRate: rowMetric(r, 4),
    };
  });

  // activeUsers 표시 레벨 전용 쿼리 결과 → 플랫폼·일자별 dedup된 고유 사용자 맵
  const platformActiveUsers = mergeActiveUsersByPlatform(
    (platformActiveUsersResp.data.rows ?? []).map((r) => ({
      platform: platformOfRow(rowValue(r, 0), rowValue(r, 1)),
      activeUsers: rowMetric(r, 0),
    })),
  );
  const dateActiveUsers = mergeActiveUsersByDate(
    (dateActiveUsersResp.data.rows ?? []).map((r) => ({
      date: formatDate(rowValue(r, 0)),
      activeUsers: rowMetric(r, 0),
    })),
  );

  // 2) 집계 (플랫폼별) — sessions·screenPageViews는 detail rows 합산(가산 지표라 정확),
  //    activeUsers는 비가산이라 전용 쿼리 dedup 값으로 대체(detail 합산 시 중복).
  const platformMap = new Map<
    string,
    { sessions: number; screenPageViews: number }
  >();
  for (const row of rows) {
    const p = platformMap.get(row.platform) ?? {
      sessions: 0,
      screenPageViews: 0,
    };
    p.sessions += row.sessions;
    p.screenPageViews += row.screenPageViews;
    platformMap.set(row.platform, p);
  }
  const byPlatform = [...platformMap.entries()]
    .map(([platform, v]) => ({
      platform,
      sessions: v.sessions,
      activeUsers: platformActiveUsers.get(platform) ?? 0,
      screenPageViews: v.screenPageViews,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  // 조회 구간 전체 일자(KST 기준, 오래된→최신) — byDate·byDateConversions 연속 축 공통 사용.
  //   GA4 date 디멘션과 startDate/endDate는 같은 속성 타임존(Asia/Seoul) 기준이라 추가 변환 없음.
  //   데이터 없는 날을 0으로 채워 "데이터 있는 날만 나옴"으로 끊기던 추이를 연속 타임라인으로.
  //   MED-2: startDate/endDate가 상대 토큰("28daysAgo"·"today" 등)이면 enumerateDateRange가
  //   빈 배열로 떨궈 0 채움이 무력화된다. GA4 호출엔 원래 토큰을 그대로 넘기되(상대날짜 GA4가
  //   이해), enumerate에는 KST 기준 절대 일자로 정규화해서 넘긴다. GA4 집계 일자(KST)와
  //   enumerate 일자가 동일 타임존이라 정합.
  const allDates = enumerateDateRange(
    resolveGa4DateToken(params.startDate),
    resolveGa4DateToken(params.endDate),
  );

  // 3) 일자별 — sessions는 detail rows 합산(가산), activeUsers는 일자별 전용 쿼리 dedup 값.
  //    데이터 있는 날만 먼저 만들고, 전체 일자(allDates)로 0 채워 빠짐없는 연속 축으로 변환.
  const dateMap = new Map<string, { sessions: number }>();
  for (const row of rows) {
    const d = dateMap.get(row.date) ?? { sessions: 0 };
    d.sessions += row.sessions;
    dateMap.set(row.date, d);
  }
  const byDatePresent = [...dateMap.entries()]
    .map(([date, v]) => ({
      date,
      sessions: v.sessions,
      activeUsers: dateActiveUsers.get(date) ?? 0,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const byDate = fillDateSeries(byDatePresent, allDates, {
    sessions: 0,
    activeUsers: 0,
  });

  // 3-b) 일자별 AI 전환(결제) — purchases·revenue는 가산 지표라 date 단일 디멘션 합산이 정상.
  //    byDate와 동일하게 전체 일자로 0 채워 연속. 보조 쿼리 실패(null) 시 전 구간 0 시계열.
  const conversionsPresent = (dateConversionsResp?.data.rows ?? [])
    .map((r) => ({
      date: formatDate(rowValue(r, 0)),
      purchases: rowMetric(r, 0),
      revenue: rowMetric(r, 1),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const byDateConversions = fillDateSeries(conversionsPresent, allDates, {
    purchases: 0,
    revenue: 0,
  });

  // 4) 상위 랜딩페이지 (상위 30) — sessions 기준 정렬·표시.
  //    sessions는 가산이라 정확. activeUsers는 (platform×landingPage) 단위로 detail rows를
  //    합산하므로 같은 사용자가 여러 날 같은 랜딩페이지를 보면 중복될 수 있는 비가산 한계가
  //    남아 있다(랜딩페이지 단위 전용 dedup 쿼리는 이번 정정 범위 밖 — 보조 지표라 유지).
  //    핵심 카드/차트인 totals·byPlatform·byDate는 전용 dedup 쿼리로 정정됨.
  const lpMap = new Map<
    string,
    { platform: string; landingPage: string; sessions: number; activeUsers: number }
  >();
  for (const row of rows) {
    const key = `${row.platform}|||${row.landingPage}`;
    const existing = lpMap.get(key) ?? {
      platform: row.platform,
      landingPage: row.landingPage,
      sessions: 0,
      activeUsers: 0,
    };
    existing.sessions += row.sessions;
    existing.activeUsers += row.activeUsers;
    lpMap.set(key, existing);
  }
  const topLandingPages = [...lpMap.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 30);

  // 5) 전체 합계 — sessions·screenPageViews는 detail rows 합산(가산 지표라 정확).
  //    activeUsers는 비가산이라 합산하면 중복 카운트(고유 사용자 부풀림) → 디멘션 없는
  //    전용 쿼리(7)의 단일 dedup 값을 쓴다. 가장 눈에 띄는 카드라 반드시 정확해야 한다.
  const totalsBase = rows.reduce(
    (acc, r) => ({
      sessions: acc.sessions + r.sessions,
      screenPageViews: acc.screenPageViews + r.screenPageViews,
    }),
    { sessions: 0, screenPageViews: 0 },
  );
  const totals = {
    sessions: totalsBase.sessions,
    activeUsers: rowMetric((totalsActiveUsersResp.data.rows ?? [])[0] ?? {}, 0),
    screenPageViews: totalsBase.screenPageViews,
  };

  // 6) 플랫폼별 engagement (source + channelGroup으로 라벨 정확화)
  const byPlatformEngagement = (engagementResp?.data.rows ?? []).map((r) => {
    const source = rowValue(r, 0);
    const channelGroup = rowValue(r, 1);
    return {
      platform: platformOfRow(source, channelGroup),
      sessions: rowMetric(r, 0),
      averageSessionDuration: rowMetric(r, 1),
      pageViewsPerSession: rowMetric(r, 2),
      engagementRate: rowMetric(r, 3),
    };
  });
  // 동일 플랫폼 여러 source → 세션 가중 평균으로 합치기 (MED-3: 순수함수 추출)
  const platformEngagement = aggregateEngagementByPlatform(byPlatformEngagement);

  // 7) 시간대 히트맵
  const hourlyHeatmap = (hourlyResp?.data.rows ?? []).map((r) => ({
    dayOfWeek: Number(rowValue(r, 0)) || 0, // GA4: 0 = 일요일
    hour: Number(rowValue(r, 1)) || 0,
    sessions: rowMetric(r, 0),
  }));

  // 8) 신규 vs 재방문
  const newVsReturning = (newReturnResp?.data.rows ?? []).map((r) => ({
    userType: rowValue(r, 0) || "(unknown)",
    sessions: rowMetric(r, 0),
    activeUsers: rowMetric(r, 1),
  }));

  // 9) 주요 이벤트 Top
  const topEvents = (eventsResp?.data.rows ?? []).map((r) => ({
    eventName: rowValue(r, 0),
    eventCount: rowMetric(r, 0),
    sessions: rowMetric(r, 1),
  }));

  // 10) 전체 페이지 Top 10
  const topPages = (pagesResp?.data.rows ?? []).map((r) => ({
    pagePath: rowValue(r, 0),
    sessions: rowMetric(r, 0),
    activeUsers: rowMetric(r, 1),
    screenPageViews: rowMetric(r, 2),
  }));

  // 11) 신뢰도 등급 집계 (AD-1·LOW-3 / MED-3: 순수함수 추출)
  //   - confirmed: 도메인 referrer 또는 GA4 "AI Assistant" 채널그룹으로 확인된 세션 (필터가 admit한 전부)
  //   - unclassified: confirmed 중 source로 플랫폼을 특정 못 해 "기타 AI(분류상)"로 잡힌 분량
  //   - suspected: 단계1에서 분리 근거가 실증되지 않아 항상 0 (빈 등급 — 과장 회피)
  const tiers: AiReferralTiers = aggregateAiReferralTiers(rows);

  return {
    propertyId: params.propertyId,
    startDate: params.startDate,
    endDate: params.endDate,
    totals,
    tiers,
    byPlatform,
    byDate,
    byDateConversions,
    topLandingPages,
    byPlatformEngagement: platformEngagement,
    hourlyHeatmap,
    newVsReturning,
    topEvents,
    topPages,
    rows,
    fetchedAt: new Date().toISOString(),
  };
}
