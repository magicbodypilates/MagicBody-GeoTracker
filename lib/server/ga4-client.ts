import { google } from "googleapis";
import { getAuthedClient } from "./gsc-client";

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

export function getDefaultPropertyId(): string | null {
  const raw = process.env.GA4_PROPERTY_ID ?? "";
  return raw.trim() || null;
}

export interface Ga4ReferralRow {
  date: string;
  source: string;
  platform: string;
  landingPage: string;
  sessions: number;
  activeUsers: number;
  screenPageViews: number;
  averageSessionDuration: number;
  engagementRate: number;
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
  byPlatform: Array<{
    platform: string;
    sessions: number;
    activeUsers: number;
    screenPageViews: number;
  }>;
  byDate: Array<{ date: string; sessions: number; activeUsers: number }>;
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

type RunReportRow = {
  dimensionValues?: Array<{ value?: string | null }>;
  metricValues?: Array<{ value?: string | null }>;
};

function rowValue(row: RunReportRow, idx: number): string {
  return row.dimensionValues?.[idx]?.value ?? "";
}

function rowMetric(row: RunReportRow, idx: number): number {
  const raw = row.metricValues?.[idx]?.value ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** YYYYMMDD → YYYY-MM-DD */
function formatDate(ymd: string): string {
  if (ymd.length !== 8) return ymd;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * AI 플랫폼 referrer 트래픽을 GA4에서 조회.
 * sessionSource in AI_REFERRER_DOMAINS 로 필터링.
 */
export async function fetchAiReferralReport(params: {
  propertyId: string;
  startDate: string;
  endDate: string;
}): Promise<Ga4ReferralSnapshot> {
  const auth = await getAuthedClient();
  const analytics = google.analyticsdata({ version: "v1beta", auth });

  const property = `properties/${params.propertyId}`;
  const dateRange = { startDate: params.startDate, endDate: params.endDate };

  // sessionSource in AI_REFERRER_DOMAINS
  const sourceFilter = {
    filter: {
      fieldName: "sessionSource",
      inListFilter: {
        values: [...AI_REFERRER_DOMAINS],
        caseSensitive: false,
      },
    },
  };

  // 1) 원본 일자 × 소스 × 랜딩페이지 rows + 추가 분석 쿼리 병렬 실행
  const [
    detailResp,
    engagementResp,
    hourlyResp,
    newReturnResp,
    eventsResp,
    pagesResp,
  ] = await Promise.all([
    analytics.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [
          { name: "date" },
          { name: "sessionSource" },
          { name: "landingPagePlusQueryString" },
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
    // 2) 플랫폼별 engagement
    analytics.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: "sessionSource" }],
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
  ]);

  const rows: Ga4ReferralRow[] = (detailResp.data.rows ?? []).map((r) => {
    const source = rowValue(r, 1);
    return {
      date: formatDate(rowValue(r, 0)),
      source,
      platform: platformOf(source),
      landingPage: rowValue(r, 2),
      sessions: rowMetric(r, 0),
      activeUsers: rowMetric(r, 1),
      screenPageViews: rowMetric(r, 2),
      averageSessionDuration: rowMetric(r, 3),
      engagementRate: rowMetric(r, 4),
    };
  });

  // 2) 집계 (플랫폼별)
  const platformMap = new Map<
    string,
    { sessions: number; activeUsers: number; screenPageViews: number }
  >();
  for (const row of rows) {
    const p = platformMap.get(row.platform) ?? {
      sessions: 0,
      activeUsers: 0,
      screenPageViews: 0,
    };
    p.sessions += row.sessions;
    p.activeUsers += row.activeUsers;
    p.screenPageViews += row.screenPageViews;
    platformMap.set(row.platform, p);
  }
  const byPlatform = [...platformMap.entries()]
    .map(([platform, v]) => ({ platform, ...v }))
    .sort((a, b) => b.sessions - a.sessions);

  // 3) 일자별
  const dateMap = new Map<string, { sessions: number; activeUsers: number }>();
  for (const row of rows) {
    const d = dateMap.get(row.date) ?? { sessions: 0, activeUsers: 0 };
    d.sessions += row.sessions;
    d.activeUsers += row.activeUsers;
    dateMap.set(row.date, d);
  }
  const byDate = [...dateMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // 4) 상위 랜딩페이지 (상위 30)
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

  // 5) 전체 합계
  const totals = rows.reduce(
    (acc, r) => ({
      sessions: acc.sessions + r.sessions,
      activeUsers: acc.activeUsers + r.activeUsers,
      screenPageViews: acc.screenPageViews + r.screenPageViews,
    }),
    { sessions: 0, activeUsers: 0, screenPageViews: 0 },
  );

  // 6) 플랫폼별 engagement
  const byPlatformEngagement = (engagementResp?.data.rows ?? []).map((r) => {
    const source = rowValue(r, 0);
    return {
      platform: platformOf(source),
      sessions: rowMetric(r, 0),
      averageSessionDuration: rowMetric(r, 1),
      pageViewsPerSession: rowMetric(r, 2),
      engagementRate: rowMetric(r, 3),
    };
  });
  // 동일 플랫폼 여러 source → 세션 가중 평균으로 합치기
  const engAgg = new Map<
    string,
    {
      platform: string;
      sessions: number;
      durationSum: number;
      pvSum: number;
      engSum: number;
    }
  >();
  for (const e of byPlatformEngagement) {
    const prev = engAgg.get(e.platform) ?? {
      platform: e.platform,
      sessions: 0,
      durationSum: 0,
      pvSum: 0,
      engSum: 0,
    };
    prev.sessions += e.sessions;
    prev.durationSum += e.averageSessionDuration * e.sessions;
    prev.pvSum += e.pageViewsPerSession * e.sessions;
    prev.engSum += e.engagementRate * e.sessions;
    engAgg.set(e.platform, prev);
  }
  const platformEngagement = [...engAgg.values()]
    .map((v) => ({
      platform: v.platform,
      sessions: v.sessions,
      averageSessionDuration: v.sessions > 0 ? v.durationSum / v.sessions : 0,
      pageViewsPerSession: v.sessions > 0 ? v.pvSum / v.sessions : 0,
      engagementRate: v.sessions > 0 ? v.engSum / v.sessions : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

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

  return {
    propertyId: params.propertyId,
    startDate: params.startDate,
    endDate: params.endDate,
    totals,
    byPlatform,
    byDate,
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
