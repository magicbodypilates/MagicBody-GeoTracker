export type Provider =
  | "chatgpt"
  | "perplexity"
  | "copilot"
  | "gemini"
  | "google_ai"
  | "grok";

/** Bright Data에서 구조화되어 오는 인용 한 건 */
export type Citation = {
  url: string;
  domain: string;
  title: string;
  description: string;
};

export type ScrapeRun = {
  provider: Provider;
  prompt: string;
  /** 실제로 Bright Data에 전송된 최종 프롬프트 (brandCtx 주입 여부 검증용) */
  sentPrompt?: string;
  answer: string;
  sources: string[];
  /** 구조화된 인용 (Bright Data citations 필드에서 직접 수집). sources보다 풍부 */
  citations?: Citation[];
  createdAt: string;
  /** 0-100 visibility score based on brand mention, position, sentiment */
  visibilityScore: number;
  /** Detected sentiment of the response toward the brand */
  sentiment: "positive" | "neutral" | "negative" | "not-mentioned";
  /** Brand names/aliases found in the MAIN AI answer body (not the attached/related content section). 스코어링에 사용 */
  brandMentions: string[];
  /** Competitor names found in the MAIN AI answer body. 스코어링에 사용 */
  competitorMentions: string[];
  /**
   * 부가 콘텐츠 섹션(관련 동영상/추천 링크 등 AI 본문 뒤에 자동 첨부되는 영역)에서 감지된 브랜드 언급.
   * Google/Gemini가 답변 말미에 붙이는 동영상 카드 영역으로, AI 추천과 구분해 "보조 노출"로 집계.
   */
  attachedBrandMentions?: string[];
  /** 부가 콘텐츠 섹션에서 감지된 경쟁사 언급 */
  attachedCompetitorMentions?: string[];
  /**
   * 구조화된 인용(citations[])에 브랜드 공식 도메인이 포함된 경우 해당 도메인들.
   * AI가 답변 근거로 우리 브랜드를 출처로 채택한 강한 신호.
   */
  citedBrandDomains?: string[];
  /** citations[]에 포함된 경쟁사 도메인 */
  citedCompetitorDomains?: string[];
  /** true면 스케줄러에 의해 자동 생성된 실행, false/undefined는 사용자 수동 실행 */
  auto?: boolean;
};

/** Structured section inside a battlecard */
type BattlecardSection = {
  heading: string;
  points: string[];
};

export type Battlecard = {
  competitor: string;
  sentiment: "positive" | "neutral" | "negative";
  summary: string;
  /** Structured sections: strengths, weaknesses, pricing, AI visibility, etc. */
  sections?: BattlecardSection[];
};

export type AuditCheck = {
  id: string;
  label: string;
  category: "discovery" | "structure" | "content" | "technical" | "rendering";
  pass: boolean;
  value: string;
  detail: string;
};

export type AuditReport = {
  url: string;
  score: number;
  checks: AuditCheck[];
  /** Legacy fields kept for backward compat */
  llmsTxtPresent: boolean;
  schemaMentions: number;
  blufDensity: number;
  pass: {
    llmsTxt: boolean;
    schema: boolean;
    bluf: boolean;
  };
};

/** 저장된 AEO 감사 스냅샷 (결과 비교용) */
export type AuditHistoryEntry = {
  id: string;
  url: string;
  createdAt: string;
  report: AuditReport;
  /** 사용자가 지정한 메모 (선택) */
  note?: string;
};

export type BrandConfig = {
  brandName: string;
  brandAliases: string;
  /** Multiple brand/company website URLs */
  websites: string[];
  industry: string;
  keywords: string;
  description: string;
};

/** Workspace for multi-brand tracking */
export type Workspace = {
  id: string;
  brandName: string;
  createdAt: string;
};

export const ALL_PROVIDERS: Provider[] = [
  "chatgpt", "perplexity", "copilot", "gemini", "google_ai", "grok",
];

/**
 * UI(조사 대상 선택, 필터 드롭다운 등)에 노출할 provider 목록.
 * Copilot / Grok 은 현재 조사 범위에서 제외 — 내부 enum/마이그레이션은 ALL_PROVIDERS 사용.
 * 추후 재활성화 시 이 필터에서 제거.
 */
const HIDDEN_PROVIDERS: Provider[] = ["copilot", "grok"];
export const VISIBLE_PROVIDERS: Provider[] = ALL_PROVIDERS.filter(
  (p) => !HIDDEN_PROVIDERS.includes(p),
);

export const PROVIDER_LABELS: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  copilot: "Copilot",
  gemini: "Gemini",
  google_ai: "Google AI",
  grok: "Grok",
};

/** A drift alert generated when visibility changes significantly between auto-runs */
export type DriftAlert = {
  id: string;
  prompt: string;
  provider: Provider;
  oldScore: number;
  newScore: number;
  delta: number;
  createdAt: string;
  dismissed: boolean;
};

/** Schedule interval value in milliseconds */
export type ScheduleInterval = 3600000 | 21600000 | 43200000 | 86400000;

export const SCHEDULE_OPTIONS: { value: ScheduleInterval; label: string; desc: string }[] = [
  { value: 3600000, label: "1시간마다", desc: "시간당 1회 실행" },
  { value: 21600000, label: "6시간마다", desc: "하루 4회 실행" },
  { value: 43200000, label: "12시간마다", desc: "하루 2회 실행" },
  { value: 86400000, label: "매일", desc: "하루 1회 실행" },
];

/** Computed delta for a prompt+provider pair between runs */
export type RunDelta = {
  prompt: string;
  provider: Provider;
  currentScore: number;
  previousScore: number;
  delta: number;
  currentRun: ScrapeRun;
  previousRun: ScrapeRun;
};

/** Structured competitor with optional aliases and websites */
export type Competitor = {
  name: string;
  aliases: string[];
  websites: string[];
};

/** A tracking prompt with optional tags for grouping/filtering */
export type TaggedPrompt = {
  text: string;
  tags: string[];
};

export type AppState = {
  brand: BrandConfig;
  provider: Provider;
  /** Multiple providers selected for parallel runs */
  activeProviders: Provider[];
  prompt: string;
  customPrompts: TaggedPrompt[];
  personas: string;
  fanoutPrompts: string[];
  niche: string;
  nicheQueries: string[];
  cronExpr: string;
  githubWorkflow: string;
  competitors: Competitor[];
  battlecards: Battlecard[];
  runs: ScrapeRun[];
  auditUrl: string;
  auditReport: AuditReport | null;
  /** AEO 감사 이력 — 이전 스냅샷 비교 */
  auditHistory: AuditHistoryEntry[];
  /** In-app scheduling */
  scheduleEnabled: boolean;
  scheduleIntervalMs: ScheduleInterval;
  lastScheduledRun: string | null;
  /** Drift alerts from auto-runs */
  driftAlerts: DriftAlert[];
};

export const tabs = [
  "Home",
  "Prompt Hub",
  "Responses",
  "Visibility Analytics",
  "Citations",
  "Citation Opportunities",
  "Automation",
  "GSC Performance",
  "AI Referral",
  "SRO Analysis",
  "NAVER AI",
  "Bing Citations",
  "AEO Audit",
  "Persona Fan-Out",
  "Niche Explorer",
  "Competitor Battlecards",
  "Documentation",
  "Project Settings",
] as const;

/** A single row returned from GSC Search Analytics API */
export type GscRow = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscSnapshot = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimension: "query" | "page" | "device" | "country" | "date";
  rowCount: number;
  totals: { clicks: number; impressions: number };
  rows: GscRow[];
  fetchedAt: string;
};

export type TabKey = (typeof tabs)[number];

/**
 * 일반관리자(role > 0)에게 숨기는 탭 목록.
 * 최고관리자(role === 0)는 전체 탭 모두 접근 가능.
 *
 * 숨김 사유: 미완성 / 베타 / 개발자 전용 영역. 추후 정식 기능으로 정리되면 이 배열에서 제거.
 */
export const REGULAR_ADMIN_HIDDEN_TABS: readonly TabKey[] = [
  "Citation Opportunities",
  "SRO Analysis",
  "NAVER AI",
  "Persona Fan-Out",
  "Niche Explorer",
  "Documentation",
] as const;

/**
 * role 에 따라 노출할 탭 목록을 반환.
 * - role === 0 (최고관리자): 전체 탭
 * - role > 0  (일반관리자): REGULAR_ADMIN_HIDDEN_TABS 제외한 탭
 * - 그 외 (-1 비로그인 등): 일반관리자와 동일하게 처리 (미들웨어가 이미 차단하므로 방어적 기본값)
 */
export function tabsForRole(role: number): readonly TabKey[] {
  if (role === 0) return tabs;
  return tabs.filter((t) => !REGULAR_ADMIN_HIDDEN_TABS.includes(t));
}
