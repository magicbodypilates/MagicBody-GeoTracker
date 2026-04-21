// ─── Gemini Grounding Types ───────────────────────────────────────────────

export interface GroundingChunk {
  uri: string;
  title: string;
}

export interface GroundingSupport {
  startIndex: number;
  endIndex: number;
  text: string;
  chunkIndices: number[];
  confidenceScores: number[];
}

export interface GroundingResult {
  query: string;
  answer: string;
  searchQueries: string[];
  chunks: GroundingChunk[];
  supports: GroundingSupport[];
  targetUrlFound: boolean;
  targetUrlChunkIndices: number[];
  targetSnippets: string[];
  totalGroundingWords: number;
  targetGroundingWords: number;
  selectionRate: number;
}

// ─── Bright Data Platform Types ───────────────────────────────────────────

export type SROPlatform =
  | "ai_mode"
  | "gemini"
  | "chatgpt"
  | "perplexity"
  | "copilot"
  | "grok";

export interface PlatformConfig {
  id: SROPlatform;
  label: string;
  datasetEnvVar: string;
  targetUrl: string;
  defaultDatasetId: string;
}

export interface PlatformCitation {
  url: string;
  domain: string;
  title: string;
  description: string;
  hasTextFragment: boolean;
  citedSentence: string;
}

export interface PlatformResult {
  platform: SROPlatform;
  label: string;
  status: "pending" | "processing" | "done" | "error";
  answer: string;
  citations: PlatformCitation[];
  targetUrlCited: boolean;
  targetCitations: PlatformCitation[];
  error?: string;
}

// ─── SERP Types ──────────────────────────────────────────────────────────

export interface SerpOrganicResult {
  position: number;
  url: string;
  domain: string;
  title: string;
  description: string;
  isTarget: boolean;
}

export interface SerpResult {
  keyword: string;
  totalResults: number;
  organicResults: SerpOrganicResult[];
  targetRank: number | null;
  topCompetitors: string[];
}

// ─── AI Overview Types ──────────────────────────────────────────────────

export interface AiOverviewSource {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  /** 타겟 브랜드 도메인과 일치하는 인용인지 */
  isBrand: boolean;
}

export interface AiOverviewResult {
  keyword: string;
  /** AI Overview 블록이 SERP에 나타났는지 */
  exists: boolean;
  /** AI Overview 응답 텍스트 (있을 때) */
  text: string;
  /** 인용 출처 리스트 */
  sources: AiOverviewSource[];
  /** 응답 텍스트에 브랜드명/별칭이 등장하는지 */
  brandMentioned: boolean;
  /** 인용 출처에 브랜드 웹사이트가 포함되는지 */
  brandCited: boolean;
  /** 등장한 경쟁사 이름 목록 */
  competitorsMentioned: string[];
  /** 조회한 국가 (gl 파라미터) */
  country: string;
  /** 조회 시각 ISO */
  fetchedAt: string;
  /** 실패/미감지 원인 진단 메시지 */
  error?: string;
  /** Bright Data 원본 응답 키 프리뷰 (최상위 필드명 목록 + 샘플) */
  rawPreview?: string;
}

// ─── NAVER AI Briefing Types ────────────────────────────────────────────

export interface NaverAiSource {
  url: string;
  domain: string;
  title: string;
  isBrand: boolean;
}

export interface NaverAiBriefingResult {
  keyword: string;
  /** AI 브리핑 블록이 검색 결과에 나타났는지 */
  exists: boolean;
  /** AI 브리핑 본문 스니펫 */
  snippet: string;
  /** 스니펫 내 브랜드 멘션 횟수 */
  mentionCount: number;
  /** 브랜드명/별칭이 스니펫에 등장했는지 */
  brandMentioned: boolean;
  /** 인용 출처에 브랜드 웹사이트가 포함되는지 */
  brandCited: boolean;
  /** AI 브리핑 인용 출처 */
  sources: NaverAiSource[];
  /** 등장한 경쟁사 이름 */
  competitorsMentioned: string[];
  /** 조회 시각 ISO */
  fetchedAt: string;
  /** 디버그용 원본 검색 URL */
  sourceUrl: string;
  /** 실패 사유 (스크래핑 에러 / 키 미설정 등). exists=false일 때만 의미 있음 */
  error?: string;
  /** 디버그: 마크다운이 오긴 했지만 블록을 찾지 못한 경우 앞부분 프리뷰 */
  markdownPreview?: string;
}

// ─── Bing WMT CSV Types ─────────────────────────────────────────────────

export interface BingCsvRow {
  keyword: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  citations: number;
  date: string;
  /** 매핑되지 않은 원본 컬럼 — 참고용 */
  extra: Record<string, string>;
}

export interface BingCsvParseResult {
  /** 파싱 성공 여부 */
  ok: boolean;
  /** 오류 메시지 (ok=false 일 때) */
  error?: string;
  /** 원본 헤더 행 */
  headers: string[];
  /** 정규화된 컬럼 매핑 — key는 BingCsvRow 필드명, value는 원본 헤더명 */
  headerMap: Record<string, string | null>;
  /** 파싱된 행 */
  rows: BingCsvRow[];
  /** 합계 */
  totals: {
    clicks: number;
    impressions: number;
    citations: number;
  };
  /** 평균 CTR (0~1) */
  avgCtr: number;
  /** 평균 순위 */
  avgPosition: number;
  /** 날짜 범위 */
  dateRange: { start: string | null; end: string | null };
  /** 업로드 시각 ISO */
  uploadedAt: string;
  /** 원본 파일명 */
  fileName: string;
}

// ─── Web Unlocker Types ──────────────────────────────────────────────────

export interface ScrapedPage {
  url: string;
  domain: string;
  title: string;
  headings: string[];
  wordCount: number;
  contentSnippet: string;
  fullText: string;
  metaDescription: string;
  error?: string;
}

// ─── LLM Analysis Types ─────────────────────────────────────────────────

export interface SiteContext {
  domain: string;
  homepageUrl: string;
  primaryTopics: string[];
  industry: string;
  targetAudience: string;
  contentThemes: string[];
  siteDescription: string;
  error?: string;
}

export interface LLMAnalysisInput {
  targetUrl: string;
  keyword: string;
  grounding: GroundingResult | null;
  platforms: PlatformResult[];
  serp: SerpResult | null;
  targetPage: ScrapedPage | null;
  competitorPages: ScrapedPage[];
  siteContext?: SiteContext | null;
}

export interface LLMRecommendation {
  category: "content" | "structure" | "technical" | "strategy";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  actionItems: string[];
}

export interface LLMAnalysisResult {
  overallScore: number;
  summary: string;
  recommendations: LLMRecommendation[];
  contentGaps: string[];
  competitorInsights: string[];
}

// ─── Bulk Analysis Types ─────────────────────────────────────────────────

export interface AnalysisInput {
  url: string;
  keyword: string;
}

export type BulkItemStage =
  | "queued"
  | "grounding"
  | "platforms"
  | "serp"
  | "scraping"
  | "analyzing"
  | "done"
  | "error";

export interface BulkItemProgress {
  index: number;
  url: string;
  keyword: string;
  stage: BulkItemStage;
  error?: string;
}

export interface BulkAnalysisResult {
  index: number;
  input: AnalysisInput;
  grounding: GroundingResult | null;
  platforms: PlatformResult[];
  serp: SerpResult | null;
  targetPage: ScrapedPage | null;
  competitorPages: ScrapedPage[];
  llmAnalysis: LLMAnalysisResult | null;
  timestamp: string;
}

// ─── Bright Data Raw Types ───────────────────────────────────────────────

export interface BrightDataSnapshotRecord {
  input?: { prompt?: string };
  prompt?: string;
  answer_text?: string;
  answer_text_markdown?: string;
  citations?: BrightDataCitation[];
  sources?: BrightDataCitation[];
  links_attached?: { url: string }[];
  timestamp?: string;
  country?: string;
}

export interface BrightDataCitation {
  url?: string;
  domain?: string;
  title?: string;
  description?: string;
  cited?: boolean;
}
