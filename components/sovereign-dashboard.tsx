"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadSovereignValue, saveSovereignValue, clearSovereignStore } from "@/lib/client/sovereign-store";
import { DEMO_STATE } from "@/lib/demo-data";
import { AeoAuditTab } from "@/components/dashboard/tabs/aeo-audit-tab";
import { AutomationServerTab } from "@/components/dashboard/tabs/automation-server-tab";
import { BattlecardsTab } from "@/components/dashboard/tabs/battlecards-tab";
import { CitationOpportunitiesTab } from "@/components/dashboard/tabs/citation-opportunities-tab";
import { NicheExplorerTab } from "@/components/dashboard/tabs/niche-explorer-tab";
import { FanOutTab } from "@/components/dashboard/tabs/fan-out-tab";
import { PartnerDiscoveryTab } from "@/components/dashboard/tabs/partner-discovery-tab";
import { ProjectSettingsTab } from "@/components/dashboard/tabs/project-settings-tab";
import { PromptHubTab } from "@/components/dashboard/tabs/prompt-hub-tab";
import { ReputationSourcesTab } from "@/components/dashboard/tabs/reputation-sources-tab";
import { VisibilityAnalyticsTab } from "@/components/dashboard/tabs/visibility-analytics-tab";
import { DocumentationTab } from "@/components/dashboard/tabs/documentation-tab";
import { HomeTab } from "@/components/dashboard/tabs/home-tab";
import { SROAnalysisTab } from "@/components/dashboard/tabs/sro-analysis-tab";
import { GscPerformanceTab } from "@/components/dashboard/tabs/gsc-performance-tab";
import { Ga4ReferralTab } from "@/components/dashboard/tabs/ga4-referral-tab";
import { NaverAiTab } from "@/components/dashboard/tabs/naver-ai-tab";
import { BingCitationsTab } from "@/components/dashboard/tabs/bing-citations-tab";
import type { AppState, Battlecard, Citation, DriftAlert, Provider, RunDelta, ScheduleInterval, ScrapeRun, TabKey, TaggedPrompt, Workspace } from "@/components/dashboard/types";
import { ALL_PROVIDERS, VISIBLE_PROVIDERS, PROVIDER_LABELS, SCHEDULE_OPTIONS, tabs, tabsForRole } from "@/components/dashboard/types";
import { useAuth } from "@/components/auth/auth-context";
import { splitAnswerSections } from "@/components/dashboard/answer-utils";
import {
  buildTargetKeys,
  isUrlMatchingCitedKeys,
  matchCitationDomains,
} from "@/components/dashboard/citation-utils";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * callScrapeOne 반환 타입.
 * 단순 null 반환에서 성공/실패 + 실패 사유를 담도록 확장 — 타임아웃/네트워크 오류 등을
 * UI에 모델별로 명시 표시하고 1회 자동 재시도를 제어하기 위함.
 */
type ScrapeOneResult =
  | { ok: true; run: ScrapeRun }
  | { ok: false; provider: Provider; reason: string };

/* ── Inline SVG icon helpers (16×16) ─────────────────────────────── */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

const tabIcons: Record<TabKey, ReactNode> = {
  Home: (
    <Icon>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2h-5v-7h-4v7H5a2 2 0 0 1-2-2z" />
    </Icon>
  ),
  "Project Settings": (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  ),
  "Prompt Hub": (
    <Icon>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Icon>
  ),
  "Persona Fan-Out": (
    <Icon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  ),
  "Niche Explorer": (
    <Icon>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  ),
  Automation: (
    <Icon>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </Icon>
  ),
  "Competitor Battlecards": (
    <Icon>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </Icon>
  ),
  Responses: (
    <Icon>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 9h8M8 13h6" />
    </Icon>
  ),
  "Visibility Analytics": (
    <Icon>
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </Icon>
  ),
  Citations: (
    <Icon>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  ),
  "Citation Opportunities": (
    <Icon>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </Icon>
  ),
  "AEO Audit": (
    <Icon>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </Icon>
  ),
  "SRO Analysis": (
    <Icon>
      <path d="M12 20V10" />
      <path d="M18 20V4" />
      <path d="M6 20v-4" />
    </Icon>
  ),
  "GSC Performance": (
    <Icon>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-5" />
    </Icon>
  ),
  "AI Referral": (
    <Icon>
      <path d="M3 12h4l3-9 4 18 3-9h4" />
    </Icon>
  ),
  "NAVER AI": (
    <Icon>
      <path d="M4 4h6v6H4z" />
      <path d="M14 4h6v6h-6z" />
      <path d="M4 14h6v6H4z" />
      <path d="M14 14h6v6h-6z" />
    </Icon>
  ),
  "Bing Citations": (
    <Icon>
      <path d="M4 4v16l4-2 4 2 4-2 4 2V4" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </Icon>
  ),
  Documentation: (
    <Icon>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M8 7h8M8 11h6" />
    </Icon>
  ),
};

const STORAGE_KEY = "sovereign-aeo-tracker-v1";
const WORKSPACES_KEY = "sovereign-workspaces";
const ACTIVE_WS_KEY = "sovereign-active-workspace";
const THEME_KEY = "sovereign-theme";

function storageKeyForWorkspace(wsId: string) {
  return wsId === "default" ? STORAGE_KEY : `sovereign-aeo-tracker-${wsId}`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const defaultState: AppState = {
  brand: {
    brandName: "매직바디",
    brandAliases: "MAGICBODY, 매직바디필라테스, 국제재활필라테스협회",
    websites: ["https://www.magicbodypilates.co.kr"],
    industry: "필라테스 교육 / 재활 필라테스 / 강사 양성",
    keywords: "필라테스 자격증, 재활 필라테스, 필라테스 강사 양성, 온라인 필라테스 강의",
    description:
      "매직바디는 재활 필라테스 전문 강사 양성과 온라인 강의를 제공하는 필라테스 교육 브랜드입니다. 국제재활필라테스협회가 운영합니다.",
  },
  provider: "chatgpt",
  // Copilot / Grok 은 UI에서 숨김(types.ts HIDDEN_PROVIDERS) — 기본 조사대상에서도 제외
  activeProviders: ["chatgpt", "perplexity", "gemini", "google_ai"],
  prompt: "필라테스 강사 자격증 딸 수 있는 곳 추천해줘. 출처 링크도 포함해줘.",
  customPrompts: [
    { text: "필라테스 강사 자격증 딸 수 있는 곳 추천해줘. 출처 링크도 포함해줘.", tags: [] },
    { text: "필라테스 강사 자격증 따는 방법 알려줘. 출처 링크도 포함해줘.", tags: [] },
  ],
  personas: "필라테스 강사 지망생\n재활 필라테스 강사\n필라테스 센터 원장\n스포츠 재활 전문가",
  fanoutPrompts: [],
  niche: "국내 재활 필라테스 강사 자격증 과정",
  nicheQueries: [],
  cronExpr: "0 */6 * * *",
  githubWorkflow:
    "name: magicbody-geo-tracker\non:\n  schedule:\n    - cron: '0 */6 * * *'\njobs:\n  track:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm run test:scraper",
  competitors: [
    { name: "이과마스터", aliases: ["이과마스터필라테스"], websites: [] },
    { name: "모던필라테스", aliases: [], websites: [] },
    { name: "스팟필라테스", aliases: [], websites: [] },
    { name: "바시필라테스", aliases: ["Basi Pilates"], websites: [] },
    { name: "KPIA", aliases: ["한국필라테스지도자협회"], websites: [] },
  ],
  battlecards: [],
  runs: [],
  auditUrl: "https://example.com",
  auditReport: null,
  auditHistory: [],
  scheduleEnabled: false,
  scheduleIntervalMs: 21600000,
  lastScheduledRun: null,
  driftAlerts: [],
};

const tabMeta: Record<TabKey, { title: string; tooltip: string; details: string }> = {
  Home: {
    title: "홈",
    tooltip: "핵심 지표와 모델별 가시성을 한눈에 봅니다.",
    details:
      "공통 통계 박스와 모델별 브랜드 언급/가시성 추이, AI 유입 현황을 통합 요약합니다.",
  },
  "Project Settings": {
    title: "프로젝트 설정",
    tooltip: "브랜드, 웹사이트, 키워드, 컨텍스트를 설정합니다.",
    details:
      "추적할 정확한 브랜드와 웹사이트를 정의합니다. 이 컨텍스트는 모든 분석 흐름에 재사용되어 결과가 비즈니스에 집중됩니다.",
  },
  "Prompt Hub": {
    title: "프롬프트 허브",
    tooltip: "추적 프롬프트 라이브러리를 관리합니다.",
    details:
      "시간에 걸쳐 추적할 프롬프트 라이브러리를 구축합니다. 개별 실행 또는 선택한 모델들로 일괄 실행할 수 있습니다. 편향 측정을 위해 프롬프트는 있는 그대로 AI 에 전송됩니다.",
  },
  "Persona Fan-Out": {
    title: "페르소나 분화",
    tooltip: "페르소나별 프롬프트 변형을 생성·실행합니다.",
    details:
      "하나의 핵심 질문을 작성하고 페르소나를 정의하면 페르소나별 변형이 자동 생성됩니다. 각 변형을 독립 실행하여 청중 관점이 AI 응답에 미치는 영향을 비교합니다.",
  },
  "Niche Explorer": {
    title: "니치 탐색",
    tooltip: "고의도 GEO/AEO 쿼리를 생성합니다.",
    details:
      "발견 가능성, 인용, 구매 의도에 초점을 둔 재사용 가능한 니치 프롬프트 뱅크를 구축하여 추적 세트의 완성도를 유지합니다.",
  },
  Automation: {
    title: "자동화",
    tooltip: "크론/워크플로로 반복 실행을 설정합니다.",
    details:
      "Vercel Cron 및 GitHub Actions용 배포 가능한 스케줄 템플릿을 저장합니다. 설정한 주기로 추적이 자동 실행됩니다.",
  },
  "Competitor Battlecards": {
    title: "경쟁사 배틀카드",
    tooltip: "경쟁사 대비 AI 응답 감성을 비교합니다.",
    details:
      "경쟁사별 요약과 감성 스냅샷을 나란히 생성합니다. 어떤 경쟁사가 우리 브랜드와 함께 언급되는지 확인하고 격차를 파악합니다.",
  },
  Responses: {
    title: "AI 응답",
    tooltip: "브랜드가 강조 표시된 AI 응답을 탐색합니다.",
    details:
      "수집된 모든 AI 응답을 탐색합니다. 브랜드 및 경쟁사 언급이 문맥에서 강조 표시되며, 응답별 가시성 점수, 감성, 인용 출처를 확인할 수 있습니다.",
  },
  "Visibility Analytics": {
    title: "가시성 분석",
    tooltip: "가시성 점수와 감성 추세를 추적합니다.",
    details:
      "시간에 따른 브랜드 가시성 점수를 모니터링하고, 응답별 감성 분포를 추적하며, 데이터를 CSV로 내보내 추가 분석에 활용할 수 있습니다.",
  },
  Citations: {
    title: "인용 출처",
    tooltip: "도메인별로 그룹화된 인용 출처를 분석합니다.",
    details:
      "AI 응답에서 가장 많이 인용되는 도메인과 URL을 확인합니다. 도메인별로 그룹화하여 인용 허브를 찾거나 특정 출처를 URL로 검색할 수 있으며, CSV 내보내기를 지원합니다.",
  },
  "Citation Opportunities": {
    title: "인용 기회",
    tooltip: "경쟁사만 인용되고 우리 브랜드가 누락된 출처를 찾습니다.",
    details:
      "고가치 아웃리치 대상을 발굴합니다: AI 모델이 경쟁사를 인용하면서 우리 브랜드는 언급하지 않은 URL 목록. 각 기회에는 아웃리치 요약이 포함됩니다.",
  },
  "AEO Audit": {
    title: "AEO 감사",
    tooltip: "LLM 발견 준비도를 감사합니다.",
    details:
      "llms.txt, 스키마 시그널, BLUF 스타일 명료성 지표를 점검하여 대상 URL의 AI 응답 준비도를 빠르게 진단합니다.",
  },
  "SRO Analysis": {
    title: "SRO 분석",
    tooltip: "AI 플랫폼별 선택률 최적화(SRO)를 분석합니다.",
    details:
      "Gemini 그라운딩, 크로스플랫폼 인용 점검, SERP 분석, AI 기반 권장사항을 포함한 전체 SRO 파이프라인을 실행하여 LLM 응답에서의 선택률을 개선합니다.",
  },
  "GSC Performance": {
    title: "GSC 성과",
    tooltip: "Google Search Console 전체 웹 검색 데이터를 조회합니다.",
    details:
      "GSC Search Analytics API로 쿼리/페이지/기기/국가별 노출·클릭·CTR·순위 데이터를 조회합니다. AI Overview 인용은 포함되지 않으며 전체 웹 검색이 대상입니다(SERP 스크래핑은 별도 탭 예정).",
  },
  "AI Referral": {
    title: "AI Referral",
    tooltip: "GA4 referrer 기반으로 실제 AI 플랫폼에서 유입된 트래픽을 추적합니다.",
    details:
      "ChatGPT · Perplexity · Gemini · Claude · Copilot · Grok 등 주요 AI 플랫폼에서 자사 사이트로 클릭되어 유입된 세션을 GA4 Data API(sessionSource 디멘션)로 집계합니다. 실제 사용자가 AI 응답을 보고 브랜드 사이트를 방문한 결과를 확인할 수 있습니다.",
  },
  "NAVER AI": {
    title: "NAVER AI",
    tooltip: "NAVER AI 브리핑 블록에 브랜드가 인용되는지 추적합니다.",
    details:
      "한국 사용자의 NAVER 검색 결과 상단 AI 브리핑 블록을 Bright Data Web Unlocker로 스크래핑합니다. 키워드별로 AI 브리핑 생성 여부, 브랜드 멘션/인용, 출처 목록, 경쟁사 멘션을 확인할 수 있습니다.",
  },
  "Bing Citations": {
    title: "Bing 인용",
    tooltip: "Bing Webmaster Tools에서 내보낸 CSV를 업로드하여 AI 인용 데이터를 분석합니다.",
    details:
      "Bing Webmaster Tools → 성과 보고서/AI Performance 리포트 CSV를 업로드하면 쿼리/페이지/클릭/노출/CTR/순위/인용 수가 자동 파싱되어 요약과 테이블로 표시됩니다. 영/한 헤더 모두 인식. 데이터는 브라우저 IndexedDB에 저장되어 다음 방문 시에도 유지됩니다.",
  },
  Documentation: {
    title: "도움말",
    tooltip: "트래커의 모든 기능을 안내합니다.",
    details:
      "모든 탭, 기능, 점수 산정 방식, 지원 모델, 데이터 프라이버시에 대한 종합 가이드입니다. 검색 및 탐색이 가능합니다.",
  },
};

/** 상단 KPI/주요 변동 스트립을 노출할 탭 */
const SHOW_KPI_TABS: TabKey[] = ["Home", "Prompt Hub", "Responses", "Visibility Analytics"];

export function SovereignDashboard({ demoMode = false }: { demoMode?: boolean } = {}) {
  const auth = useAuth();
  const role = auth.role;
  /** role 에 따라 필터된 탭 목록 — 최고관리자(0)는 전체, 일반관리자(>0)는 6개 제외 */
  const visibleTabs = useMemo(() => tabsForRole(role), [role]);
  /** 활성 탭이 숨겨진 탭이면 첫 탭으로 강제 리셋 (URL 조작 방어) */
  const [activeTab, setActiveTabRaw] = useState<TabKey>("Home");
  const setActiveTab = useCallback(
    (next: TabKey) => {
      if (!visibleTabs.includes(next)) return; // 권한 없음 — 무시
      setActiveTabRaw(next);
    },
    [visibleTabs],
  );
  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTabRaw(visibleTabs[0] ?? "Home");
    }
  }, [visibleTabs, activeTab]);
  const [state, setState] = useState<AppState>(demoMode ? DEMO_STATE : defaultState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(demoMode ? "데모 모드 — 읽기 전용" : "");
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWsId, setActiveWsId] = useState<string>("default");
  const [showWsPicker, setShowWsPicker] = useState(false);
  const [showScoreInfo, setShowScoreInfo] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /** Apply theme class to <html> */
  const applyTheme = useCallback((t: "light" | "dark" | "system") => {
    const root = document.documentElement;
    if (t === "dark") {
      root.classList.add("dark");
    } else if (t === "light") {
      root.classList.remove("dark");
    } else {
      // system
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    }
  }, []);

  function cycleTheme() {
    const order: ("light" | "dark" | "system")[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(theme) + 1) % 3];
    setTheme(next);
    applyTheme(next);
    if (!demoMode) localStorage.setItem(THEME_KEY, next);
  }

  /** Load workspaces on mount */
  useEffect(() => {
    // Theme
    const savedTheme = localStorage.getItem(THEME_KEY) as "light" | "dark" | "system" | null;
    if (savedTheme) {
      setTheme(savedTheme);
      applyTheme(savedTheme);
    }

    if (demoMode) return; // Skip workspace loading in demo mode

    // Workspaces
    try {
      const raw = localStorage.getItem(WORKSPACES_KEY);
      const parsed: Workspace[] = raw ? JSON.parse(raw) : [];
      if (parsed.length === 0) {
        // Create default workspace
        const defaultWs: Workspace = { id: "default", brandName: "Default", createdAt: new Date().toISOString() };
        parsed.push(defaultWs);
        localStorage.setItem(WORKSPACES_KEY, JSON.stringify(parsed));
      }
      setWorkspaces(parsed);
      const savedActiveId = localStorage.getItem(ACTIVE_WS_KEY) ?? parsed[0].id;
      setActiveWsId(savedActiveId);
    } catch {
      const defaultWs: Workspace = { id: "default", brandName: "Default", createdAt: new Date().toISOString() };
      setWorkspaces([defaultWs]);
      setActiveWsId("default");
    }
  }, [applyTheme]);

  /**
   * 로드 완료 플래그 — 저장 useEffect 가 로드 전에 defaultState 를 덮어쓰지 않도록 차단.
   * Race condition 방지:
   *   - mount 직후: state=defaultState, activeWsId 설정됨
   *   - 저장 useEffect 가 state 변경 감지 → IDB 에 defaultState 쓰기 시도
   *   - 로드 useEffect 가 비동기로 IDB 읽기 → 이미 덮어써진 defaultState 를 읽음
   *   → 기존에 저장된 사용자 데이터 소실
   * 해결: loaded=true 가 될 때까지 저장을 막는다.
   */
  const [loaded, setLoaded] = useState(false);

  /** Load app state for active workspace */
  useEffect(() => {
    if (demoMode || !activeWsId) return;
    setLoaded(false); // 워크스페이스 전환 시 재로드 — 일시적으로 저장 차단
    let mounted = true;
    const key = storageKeyForWorkspace(activeWsId);
    loadSovereignValue<AppState>(key, defaultState).then((data) => {
      if (mounted) {
        // Merge saved state with defaults so new fields are never undefined
        const merged: AppState = {
          ...defaultState,
          ...data,
          brand: { ...defaultState.brand, ...(data.brand ?? {}) },
          provider: ALL_PROVIDERS.includes(data.provider as Provider)
            ? (data.provider as Provider)
            : defaultState.provider,
          activeProviders: Array.isArray(data.activeProviders)
            ? data.activeProviders.filter((provider): provider is Provider =>
                ALL_PROVIDERS.includes(provider as Provider),
              )
            : [],
        };
        // Migrate legacy single website → websites array
        const brandAny = data.brand as Record<string, unknown> | undefined;
        if (brandAny && typeof brandAny.website === "string" && !Array.isArray(brandAny.websites)) {
          merged.brand.websites = brandAny.website ? [brandAny.website] : [];
        }
        // Migrate legacy comma-separated competitors string → Competitor[]
        if (typeof (data as Record<string, unknown>).competitors === "string") {
          merged.competitors = (data as Record<string, unknown>).competitors
            ? ((data as Record<string, unknown>).competitors as string)
                .split(",")
                .map((c: string) => c.trim())
                .filter(Boolean)
                .map((name: string) => ({ name, aliases: [], websites: [] }))
            : [];
        }
        // Migrate legacy plain-string customPrompts → TaggedPrompt[]
        if (Array.isArray(merged.customPrompts) && merged.customPrompts.length > 0 && typeof merged.customPrompts[0] === "string") {
          merged.customPrompts = (merged.customPrompts as unknown as string[]).map((t) => ({ text: t, tags: [] }));
        }
        if (merged.activeProviders.length === 0) {
          merged.activeProviders = [merged.provider];
        }
        // 필수 브랜드 별칭 자동 추가 — 저장된 데이터에 없으면 병합
        const REQUIRED_ALIASES = ["MAGICBODY", "매직바디필라테스", "국제재활필라테스협회"];
        const existingAliases = merged.brand.brandAliases
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const alias of REQUIRED_ALIASES) {
          if (!existingAliases.some((a) => a.toLowerCase() === alias.toLowerCase())) {
            existingAliases.push(alias);
          }
        }
        merged.brand.brandAliases = existingAliases.join(", ");
        setState(merged);
        setLoaded(true); // 이제부터 저장 허용
      }
    });
    return () => {
      mounted = false;
    };
  }, [activeWsId, demoMode]);

  useEffect(() => {
    if (demoMode || !activeWsId) return;
    if (!loaded) return; // 로드 완료 전엔 저장 금지 (기존 데이터 덮어쓰기 방지)
    saveSovereignValue(storageKeyForWorkspace(activeWsId), state);
    // Update workspace brandName if changed
    if (state.brand.brandName) {
      setWorkspaces((prev) => {
        const updated = prev.map((ws) =>
          ws.id === activeWsId ? { ...ws, brandName: state.brand.brandName || ws.brandName } : ws,
        );
        localStorage.setItem(WORKSPACES_KEY, JSON.stringify(updated));
        return updated;
      });
    }
  }, [state, activeWsId, loaded, demoMode]);

  /**
   * Phase 5B 이후 브라우저 기반 스케줄러 제거 완료.
   * 자동 실행은 mbd-geo-tracker-worker 컨테이너 → /api/internal/cron/tick 이 전담.
   * 수동 실행(단일 / 배치) 은 기존 callScrapeOne / batchRunAllPrompts 로 유지.
   */

  /** 진행 중인 모든 scrape 요청 취소용 AbortController 집합 */
  const activeControllersRef = useRef<Set<AbortController>>(new Set());

  /**
   * 초기화 토큰 — 초기화가 일어날 때마다 +1.
   * scrape 요청 발사 시점에 토큰을 캡처하고, 응답 setState 직전에 현재 토큰과
   * 비교해 불일치면 폐기. abort 이후에 이미 응답 본문까지 받아온 stale 요청이
   * 빈 state에 유입되는 걸 막는다.
   */
  const resetTokenRef = useRef(0);

  /*
   * 제거됨 (Phase 5B):
   *   - detectDrift()
   *   - runScheduledBatch()
   *   - scheduler useEffect (브라우저 setInterval)
   *   - dismissAlert / dismissAllAlerts
   * → 자동화는 서버 Worker 담당. 드리프트 감지는 Phase 5C 에서 서버 측으로 이전 예정.
   */

  function switchWorkspace(wsId: string) {
    if (demoMode) { setMessage("데모 모드 — 워크스페이스는 읽기 전용입니다"); return; }
    // Save current state first
    saveSovereignValue(storageKeyForWorkspace(activeWsId), state);
    setActiveWsId(wsId);
    localStorage.setItem(ACTIVE_WS_KEY, wsId);
    setShowWsPicker(false);
    setMessage(`${workspaces.find((w) => w.id === wsId)?.brandName ?? "워크스페이스"} 전환됨`);
  }

  function createWorkspace(name: string) {
    if (demoMode) { setMessage("데모 모드 — 워크스페이스는 읽기 전용입니다"); return; }
    const ws: Workspace = { id: generateId(), brandName: name, createdAt: new Date().toISOString() };
    const updated = [...workspaces, ws];
    setWorkspaces(updated);
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(updated));
    // Save current, switch to new
    saveSovereignValue(storageKeyForWorkspace(activeWsId), state);
    setState({ ...defaultState, brand: { ...defaultState.brand, brandName: name } });
    setActiveWsId(ws.id);
    localStorage.setItem(ACTIVE_WS_KEY, ws.id);
    setShowWsPicker(false);
    setMessage(`워크스페이스 생성됨: ${name}`);
  }

  function deleteWorkspace(wsId: string) {
    if (demoMode) { setMessage("데모 모드 — 워크스페이스는 읽기 전용입니다"); return; }
    if (workspaces.length <= 1) return;
    if (!window.confirm("이 워크스페이스와 모든 데이터를 삭제하시겠습니까?")) return;
    const updated = workspaces.filter((w) => w.id !== wsId);
    setWorkspaces(updated);
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(updated));
    clearSovereignStore(storageKeyForWorkspace(wsId));
    if (activeWsId === wsId) {
      switchWorkspace(updated[0].id);
    }
  }

  const partnerLeaderboard = useMemo(() => {
    // Client-side junk URL filter as safety net
    const junkHosts = [
      "cloudfront.net", "cdn.prod.website-files.com", "cdn.jsdelivr.net",
      "cdnjs.cloudflare.com", "unpkg.com", "fastly.net", "akamaihd.net",
      "connect.facebook.net", "facebook.net", "google-analytics.com",
      "googletagmanager.com", "doubleclick.net", "w3.org", "schema.org",
      "amazonaws.com", "cloudflare.com", "hotjar.com", "sentry.io",
    ];
    const junkExtPattern = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|woff2?|ttf|eot|mp4|webm)(\?|$)/i;

    function isCleanUrl(url: string): boolean {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (junkHosts.some((j) => host === j || host.endsWith(`.${j}`))) return false;
        if (junkExtPattern.test(parsed.pathname)) return false;
        if (parsed.search.length > 200) return false;
        return true;
      } catch {
        return false;
      }
    }

    const map = new Map<string, { count: number; prompts: Set<string> }>();
    state.runs.forEach((run) => {
      run.sources.filter(isCleanUrl).forEach((source) => {
        const existing = map.get(source) ?? { count: 0, prompts: new Set<string>() };
        existing.count += 1;
        existing.prompts.add(run.prompt);
        map.set(source, existing);
      });
    });

    return [...map.entries()]
      .map(([url, data]) => ({ url, count: data.count, prompts: [...data.prompts] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
  }, [state.runs]);

  const visibilityTrend = useMemo(() => {
    const byDay = new Map<string, { total: number; sum: number }>();

    state.runs.forEach((run) => {
      const day = run.createdAt.slice(0, 10);
      const row = byDay.get(day) ?? { total: 0, sum: 0 };
      row.total += 1;
      row.sum += run.visibilityScore ?? 0;
      byDay.set(day, row);
    });

    return [...byDay.entries()]
      .map(([day, { total, sum }]) => ({
        day,
        visibility: total > 0 ? Math.round(sum / total) : 0,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [state.runs]);

  const totalSources = useMemo(
    () => state.runs.reduce((acc, run) => acc + run.sources.length, 0),
    [state.runs],
  );

  /** Count unique domains cited in runs where the brand was NOT mentioned — these are outreach targets */
  const citationOpportunities = useMemo(() => {
    const domains = new Set<string>();
    state.runs
      .filter((r) => r.sentiment === "not-mentioned" || (r.brandMentions?.length ?? 0) === 0)
      .forEach((r) => {
        r.sources.forEach((url) => {
          try {
            const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
            domains.add(host);
          } catch { /* skip */ }
        });
      });
    return domains.size;
  }, [state.runs]);

  const latestRun = state.runs[0];

  /** Compute score deltas: for each prompt+provider, compare latest run to the previous one */
  const runDeltas: RunDelta[] = useMemo(() => {
    const grouped = new Map<string, ScrapeRun[]>();
    state.runs.forEach((run) => {
      const key = `${run.prompt}|||${run.provider}`;
      const list = grouped.get(key) ?? [];
      list.push(run);
      grouped.set(key, list);
    });

    const deltas: RunDelta[] = [];
    grouped.forEach((runs) => {
      // Sort newest first
      const sorted = [...runs].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      if (sorted.length < 2) return;
      const curr = sorted[0];
      const prev = sorted[1];
      const d = (curr.visibilityScore ?? 0) - (prev.visibilityScore ?? 0);
      if (d !== 0) {
        deltas.push({
          prompt: curr.prompt,
          provider: curr.provider,
          currentScore: curr.visibilityScore ?? 0,
          previousScore: prev.visibilityScore ?? 0,
          delta: d,
          currentRun: curr,
          previousRun: prev,
        });
      }
    });

    return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [state.runs]);

  /** Top movers — biggest absolute delta changes */
  const movers = useMemo(() => runDeltas.slice(0, 5), [runDeltas]);

  /** KPI delta: compare current period avg visibility vs prior period */
  const kpiVisibilityDelta = useMemo(() => {
    if (state.runs.length < 2) return null;
    const sorted = [...state.runs].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const mid = Math.floor(sorted.length / 2);
    const recentHalf = sorted.slice(0, mid);
    const olderHalf = sorted.slice(mid);
    if (recentHalf.length === 0 || olderHalf.length === 0) return null;
    const recentAvg = recentHalf.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / recentHalf.length;
    const olderAvg = olderHalf.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / olderHalf.length;
    return Math.round(recentAvg - olderAvg);
  }, [state.runs]);

  /** Unread drift alerts count */
  const unreadAlertCount = useMemo(
    () => state.driftAlerts.filter((a) => !a.dismissed).length,
    [state.driftAlerts],
  );

  /** Brand context block injected into AI prompts when available.
   *  Provides brand name, aliases, websites, industry, keywords, description
   *  so the AI answers based on user-provided facts instead of stale training data. */
  const brandCtx = (() => {
    if (!state.brand.brandName?.trim()) return "";
    const parts: string[] = [`- 브랜드: ${state.brand.brandName.trim()}`];
    const aliases = (state.brand.brandAliases ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (aliases.length > 0) parts.push(`- 별칭: ${aliases.join(", ")}`);
    const sites = state.brand.websites.filter((w) => w.trim());
    if (sites.length > 0) parts.push(`- 웹사이트: ${sites.join(", ")}`);
    if (state.brand.industry?.trim()) parts.push(`- 업종: ${state.brand.industry.trim()}`);
    if (state.brand.keywords?.trim()) parts.push(`- 타겟 키워드: ${state.brand.keywords.trim()}`);
    if (state.brand.description?.trim()) parts.push(`- 브랜드 설명: ${state.brand.description.trim()}`);
    return `다음 질문은 아래 브랜드와 관련된 것입니다. 답변 시 이 정보를 사실로 신뢰하고 참고하세요:\n${parts.join("\n")}\n\n`;
  })();

  /** Build list of brand names/aliases to detect */
  function getBrandTerms(): string[] {
    const terms: string[] = [];
    if (state.brand.brandName?.trim()) terms.push(state.brand.brandName.trim());
    if (state.brand.brandAliases?.trim()) {
      (state.brand.brandAliases ?? "").split(",").forEach((a) => {
        const t = a.trim();
        if (t) terms.push(t);
      });
    }
    return terms;
  }

  function getCompetitorTerms(): string[] {
    return state.competitors.flatMap((c) => [c.name, ...c.aliases]).filter(Boolean);
  }

  /** Find which terms appear in text (case-insensitive) */
  function findMentions(text: string, terms: string[]): string[] {
    const lower = text.toLowerCase();
    return terms.filter((t) => lower.includes(t.toLowerCase()));
  }

  /**
   * AI 답변을 "메인 본문"과 "부가 콘텐츠 섹션"으로 분리.
   * 부가 콘텐츠 = Google/Gemini가 AI 답변 말미에 자동 첨부하는 관련 동영상/추천 링크 카드 영역.
   * 브랜드가 자체 YouTube 채널 등을 운영하면 이 영역에 채널명이 노출되어 "AI의 실제 추천"과
   * 구별이 필요. 스코어링은 메인 본문만 기준으로 삼고, 부가 섹션은 별도 "보조 노출"로 집계.
   *
   * 감지 전략 — 가장 먼저 등장하는 경계 마커 위치에서 절단:
   *   1) "영상[...]확인해 보세요:" 도입 문구 (한글 AI 공통 패턴)
   *   2) "\n 7 min" 같은 동영상 duration (줄 시작에 등장)
   *   3) "\n 03:33" 같은 MM:SS duration
   * 메인 답변 본문에 위 패턴이 우연히 나올 확률은 매우 낮음 (2026-04 시점 Bright Data Gemini/Google AI dump 검증).
   */
  function splitAnswerSections(answer: string): { main: string; attached: string } {
    const boundaryPatterns: RegExp[] = [
      /영상[^\n.]{0,30}확인해\s*보세요?\s*:/,
      /\n\s*\d+\s*min\b/i,
      /\n\s*\d{1,2}:\d{2}\b/,
    ];
    let cutAt = answer.length;
    for (const pat of boundaryPatterns) {
      const m = answer.match(pat);
      if (m?.index !== undefined && m.index < cutAt) cutAt = m.index;
    }
    return {
      main: answer.slice(0, cutAt).trim(),
      attached: answer.slice(cutAt).trim(),
    };
  }

  /**
   * 판정 전에 답변에서 "우리가 주입한 컨텍스트"와 "프롬프트 에코"를 제거.
   * - 원본 answer는 그대로 저장(UI 표시용). 판정(calcVisibilityScore/findMentions)에만 cleaned 버전을 사용.
   * - 목적: AI가 brandCtx 블록을 답변에 에코하거나 프롬프트를 그대로 복사해올 때 발생하는
   *   가짜 mentioned=true를 방지.
   */
  function stripInjectedContext(
    rawAnswer: string,
    brandContext: string,
    sentPrompt: string,
    originalPrompt: string,
  ): string {
    let s = rawAnswer;

    // (A-1) brandCtx 블록이 통째로 에코된 경우 제거
    if (brandContext && brandContext.trim() && s.includes(brandContext.trim())) {
      s = s.split(brandContext.trim()).join("");
    }

    // (A-2) brandCtx 도입 문구가 그대로 섞여 있으면, 그 위치부터 최대 500자 범위를 제거
    const ctxIntro = "다음 질문은 아래 브랜드와 관련된 것입니다";
    const introIdx = s.indexOf(ctxIntro);
    if (introIdx !== -1) {
      s = s.slice(0, introIdx) + s.slice(introIdx + 500);
    }

    // (A-3) brandCtx 의 개별 라인 마커 ("- 브랜드:", "- 별칭:", ...) 제거
    //   AI가 요약·재구성하더라도 이 형태 그대로 답변에 나올 가능성은 낮지만 안전장치
    const ctxLineMarkers = [
      "- 브랜드:",
      "- 별칭:",
      "- 웹사이트:",
      "- 업종:",
      "- 타겟 키워드:",
      "- 브랜드 설명:",
    ];
    for (const marker of ctxLineMarkers) {
      let idx = s.indexOf(marker);
      while (idx !== -1) {
        const lineEnd = s.indexOf("\n", idx);
        s = lineEnd === -1 ? s.slice(0, idx) : s.slice(0, idx) + s.slice(lineEnd);
        idx = s.indexOf(marker);
      }
    }

    // (B) 프롬프트 에코 제거 — answer 앞부분이 프롬프트와 그대로 시작하면 그 부분만 제거
    for (const p of [sentPrompt, originalPrompt]) {
      const trimmed = (p ?? "").trim();
      if (trimmed.length < 10) continue;
      const left = s.trimStart();
      if (left.startsWith(trimmed)) {
        s = left.slice(trimmed.length);
      }
    }

    return s.trim();
  }

  /** Detect basic sentiment toward brand in answer */
  function detectSentiment(
    answer: string,
    brandTerms: string[],
  ): "positive" | "neutral" | "negative" | "not-mentioned" {
    if (brandTerms.length === 0) return "not-mentioned";
    const lower = answer.toLowerCase();
    const mentioned = brandTerms.some((t) => lower.includes(t.toLowerCase()));
    if (!mentioned) return "not-mentioned";

    const positiveWords = [
      "best", "leading", "top", "excellent", "recommend", "great", "outstanding",
      "innovative", "trusted", "powerful", "superior", "preferred", "popular",
      "reliable", "impressive", "standout", "strong", "ideal",
    ];
    const negativeWords = [
      "worst", "poor", "bad", "avoid", "lacking", "weak", "inferior",
      "disappointing", "overpriced", "limited", "outdated", "risky",
      "problematic", "concern", "drawback", "downside",
    ];

    let posScore = 0;
    let negScore = 0;
    positiveWords.forEach((w) => { if (lower.includes(w)) posScore++; });
    negativeWords.forEach((w) => { if (lower.includes(w)) negScore++; });

    if (posScore > negScore + 1) return "positive";
    if (negScore > posScore + 1) return "negative";
    return "neutral";
  }

  /** Calculate 0-100 visibility score */
  function calcVisibilityScore(
    answer: string,
    sources: string[],
    brandTerms: string[],
  ): number {
    if (brandTerms.length === 0) return 0;
    const lower = answer.toLowerCase();
    let score = 0;

    // Brand mentioned at all? +30
    const mentioned = brandTerms.some((t) => lower.includes(t.toLowerCase()));
    if (!mentioned) return 0;
    score += 30;

    // Mentioned in first 200 chars (prominent position)? +20
    const first200 = lower.slice(0, 200);
    if (brandTerms.some((t) => first200.includes(t.toLowerCase()))) score += 20;

    // Multiple mentions? +15
    const mentionCount = brandTerms.reduce((acc, t) => {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      return acc + (lower.match(re)?.length ?? 0);
    }, 0);
    if (mentionCount >= 3) score += 15;
    else if (mentionCount >= 2) score += 8;

    // Brand official channel in sources? +20
    // 일반 도메인은 호스트, 유튜브/인스타 등 공용 플랫폼은 채널 핸들까지 일치해야 함
    const brandTargetKeys = buildTargetKeys(state.brand.websites);
    if (
      brandTargetKeys.length > 0 &&
      sources.some((s) => isUrlMatchingCitedKeys(s, brandTargetKeys))
    ) {
      score += 20;
    }

    // Positive sentiment bonus +15
    const sent = detectSentiment(answer, brandTerms);
    if (sent === "positive") score += 15;
    else if (sent === "neutral") score += 5;

    return Math.min(100, score);
  }

  /** Run a single scrape against one specific provider */
  async function callScrapeOne(
    prompt: string,
    provider: Provider,
    attempt = 0,
  ): Promise<ScrapeOneResult> {
    if (demoMode) {
      setMessage("데모 모드 — API 호출이 비활성화되어 있습니다");
      return { ok: false, provider, reason: "데모 모드" };
    }
    // 초기화 토큰 캡처 — 사용자가 초기화를 눌러 abort된 경우 재시도 안 함
    const myToken = resetTokenRef.current;
    const controller = new AbortController();
    activeControllersRef.current.add(controller);
    let timedOut = false;
    // ChatGPT 는 Bright Data 특성상 응답 수집이 오래 걸리므로 타임아웃 여유 필요
    const timeoutMs = provider === "chatgpt" ? 300000 : 180000; // 5분 / 3분
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      // 브랜드 편향 제거 — brandCtx 주입하지 않고 사용자 프롬프트를 그대로 전송.
      // 응답 분석(brandMentions, citations 등)은 brand 설정 기반으로 별도 수행되므로
      // 추적 기능은 그대로 동작. AI 가 자연스러운 답변을 할 때의 노출도를 정확히 측정.
      const finalPrompt = prompt;
      const response = await fetch(BP + "/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          prompt: finalPrompt,
          requireSources: true,
        }),
        signal: controller.signal,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Scrape request failed");

      const answerText = data.answer || "";
      const sourceList = data.sources || [];
      const citationList = Array.isArray(data.citations) ? data.citations : [];
      const brandTerms = getBrandTerms();
      const competitorTerms = getCompetitorTerms();

      // 판정 전용 cleaned 답변 — brandCtx 에코 / 프롬프트 에코 제거.
      // 원본 answerText는 UI 표시용으로 그대로 저장한다.
      const cleanedAnswer = stripInjectedContext(
        answerText,
        brandCtx,
        finalPrompt,
        prompt,
      );

      // 구조 분리 — 메인 AI 본문과 부가 콘텐츠 섹션(관련 동영상 등)을 나눠
      // "AI 본문 추천" vs "부가 노출"을 구분해 집계한다.
      const { main: mainAnswer, attached: attachedAnswer } =
        splitAnswerSections(cleanedAnswer);

      // citations[]에 브랜드/경쟁사 공식 도메인이 포함됐는지 — "공식 인용" 신호
      const brandWebsiteUrls = state.brand.websites ?? [];
      const competitorWebsiteUrls = state.competitors.flatMap(
        (c) => c.websites ?? [],
      );
      const citedBrandDomains = matchCitationDomains(
        citationList as Citation[],
        brandWebsiteUrls,
      );
      const citedCompetitorDomains = matchCitationDomains(
        citationList as Citation[],
        competitorWebsiteUrls,
      );

      const run: ScrapeRun = {
        provider: data.provider,
        // Store original (unprepended) prompt so UI lists/filters stay clean
        prompt,
        sentPrompt: finalPrompt,
        answer: answerText,
        sources: sourceList,
        citations: citationList,
        createdAt: data.createdAt || new Date().toISOString(),
        // 스코어/감성/언급은 "메인 AI 본문"만 기준 — 부가 콘텐츠 섹션은 제외
        visibilityScore: calcVisibilityScore(mainAnswer, sourceList, brandTerms),
        sentiment: detectSentiment(mainAnswer, brandTerms),
        brandMentions: findMentions(mainAnswer, brandTerms),
        competitorMentions: findMentions(mainAnswer, competitorTerms),
        // 부가 콘텐츠 섹션에서의 노출은 별도 집계 (보조 신호)
        attachedBrandMentions: findMentions(attachedAnswer, brandTerms),
        attachedCompetitorMentions: findMentions(attachedAnswer, competitorTerms),
        // citations[]의 공식 인용 여부
        citedBrandDomains,
        citedCompetitorDomains,
      };
      return { ok: true, run };
    } catch (err) {
      // 사용자 초기화로 abort된 경우 → 재시도 금지, 조용히 취소로 반환
      if (resetTokenRef.current !== myToken) {
        return { ok: false, provider, reason: "취소됨" };
      }
      // 최대 2회 자동 재시도 (타임아웃/네트워크 오류 간헐적 실패 흡수)
      const MAX_RETRIES = 2;
      if (attempt < MAX_RETRIES) {
        clearTimeout(timeoutId);
        activeControllersRef.current.delete(controller);
        const reason = timedOut
          ? `타임아웃(${Math.round(timeoutMs / 1000)}s)`
          : err instanceof Error
            ? err.message
            : "unknown";
        console.warn(
          `[scrape] ${provider} 실패 — 재시도 ${attempt + 1}/${MAX_RETRIES}. 사유: ${reason}`,
        );
        return callScrapeOne(prompt, provider, attempt + 1);
      }
      // 최종 실패 — 사유 분류
      let reason: string;
      if (timedOut) reason = `타임아웃(${Math.round(timeoutMs / 1000)}s)`;
      else if (err instanceof Error) reason = err.message || "네트워크 오류";
      else reason = "알 수 없는 오류";
      console.error(
        `[scrape] ${provider} 최종 실패 (시도 ${attempt + 1}/${MAX_RETRIES + 1}회). 사유: ${reason}`,
      );
      return { ok: false, provider, reason };
    } finally {
      clearTimeout(timeoutId);
      activeControllersRef.current.delete(controller);
    }
  }

  /** Run a prompt across all activeProviders — results stream in as they arrive */
  async function callScrape(prompt: string) {
    const providers = state.activeProviders.length > 0
      ? state.activeProviders
      : [state.provider];
    const count = providers.length;
    // 초기화 토큰 캡처 — 이후 초기화가 일어나면 이 batch 응답은 폐기
    const myToken = resetTokenRef.current;
    setBusy(true);
    setMessage(`${count}개 AI 모델에서 실행 중... (0/${count})`);
    let firstArrived = false;
    let completed = 0;
    let succeeded = 0;
    const failures: { provider: Provider; reason: string }[] = [];

    const jobs = providers.map((p) =>
      callScrapeOne(prompt, p).then((result) => {
        // 초기화 이후에 도착한 stale 응답은 state 오염을 막기 위해 폐기
        if (resetTokenRef.current !== myToken) return result;
        completed += 1;
        if (result.ok) {
          succeeded += 1;
          setState((prev) => ({
            ...prev,
            runs: [result.run, ...prev.runs].slice(0, 500),
          }));
          if (!firstArrived) {
            firstArrived = true;
            setActiveTab("Responses");
          }
        } else if (result.reason !== "취소됨") {
          failures.push({ provider: result.provider, reason: result.reason });
        }
        setMessage(
          `진행 중: ${completed}/${count} · 성공 ${succeeded}${completed < count ? " (나머지 대기 중...)" : ""}`,
        );
        return result;
      }),
    );

    await Promise.allSettled(jobs);

    if (resetTokenRef.current !== myToken) {
      setBusy(false);
      return;
    }

    const failSummary = failures
      .map((f) => `${PROVIDER_LABELS[f.provider] ?? f.provider}(${f.reason})`)
      .join(", ");

    if (succeeded === 0) {
      setMessage(
        failSummary
          ? `모든 스크랩 요청이 실패했습니다 · ${failSummary}`
          : "모든 스크랩 요청이 실패했습니다.",
      );
    } else {
      setMessage(
        `완료: ${count}개 중 ${succeeded}개 성공${failSummary ? ` · 실패: ${failSummary}` : ""}`,
      );
    }
    setBusy(false);
  }

  /** Batch run all custom prompts across all active providers — fully parallel */
  async function batchRunAllPrompts() {
    // 프롬프트를 그대로 사용 — {brand} 치환 제거 (브랜드 편향 방지)
    // 브랜드 관련 질문이 필요하면 사용자가 직접 프롬프트에 브랜드명을 써야 함
    const prompts = state.customPrompts.map((p) => p.text);
    if (prompts.length === 0) {
      setMessage("실행할 추적 프롬프트가 없습니다. 먼저 프롬프트를 추가하세요.");
      return;
    }
    const providers = state.activeProviders.length > 0
      ? state.activeProviders
      : [state.provider];
    const totalJobs = prompts.length * providers.length;
    // 초기화 토큰 캡처 — 이후 초기화가 일어나면 이 batch 전체 폐기
    const myToken = resetTokenRef.current;
    setBusy(true);
    setMessage(`배치 실행: ${totalJobs}개 작업을 병렬 시작합니다...`);

    // Fire ALL prompt × provider combinations at once
    const jobs = prompts.flatMap((prompt) =>
      providers.map((p) => callScrapeOne(prompt, p)),
    );
    const results = await Promise.allSettled(jobs);

    // 초기화 이후에 완료된 batch는 결과를 state에 반영하지 않음
    if (resetTokenRef.current !== myToken) {
      setBusy(false);
      return;
    }

    const allRuns: ScrapeRun[] = [];
    const failures: { provider: Provider; reason: string }[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const value = r.value;
      if (value.ok) {
        allRuns.push(value.run);
      } else if (value.reason !== "취소됨") {
        failures.push({ provider: value.provider, reason: value.reason });
      }
    }

    setState((prev) => ({
      ...prev,
      runs: [...allRuns, ...prev.runs].slice(0, 500),
    }));

    const failSummary = failures
      .map((f) => `${PROVIDER_LABELS[f.provider] ?? f.provider}(${f.reason})`)
      .join(", ");
    setMessage(
      `배치 완료: ${prompts.length}개 프롬프트 × ${providers.length}개 모델 → ${allRuns.length}건 수집${failSummary ? ` · 실패: ${failSummary}` : ""}`,
    );
    if (allRuns.length > 0) setActiveTab("Responses");
    setBusy(false);
  }

  function generatePersonaFanout() {
    const personas = state.personas
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const corePrompt = state.prompt.trim();
    if (!corePrompt) {
      setMessage("먼저 코어 프롬프트를 입력하세요.");
      return;
    }
    if (personas.length === 0) {
      setMessage("페르소나를 한 줄에 하나씩 입력하세요.");
      return;
    }

    const fanout = personas.map(
      (persona) =>
        `[${persona} 관점에서] ${corePrompt} — 출처와 구체적 근거를 먼저 제시해줘.`,
    );

    setState((prev) => ({ ...prev, fanoutPrompts: fanout }));
    setMessage(`페르소나 ${personas.length}개 기준으로 분화 프롬프트가 생성되었습니다.`);
  }

  function addCustomPrompt(value: string) {
    const cleaned = value.trim();
    if (!cleaned) return;
    setState((prev) => {
      if (prev.customPrompts.some((p) => p.text === cleaned)) return prev;
      return { ...prev, customPrompts: [{ text: cleaned, tags: [] }, ...prev.customPrompts].slice(0, 50) };
    });
    setMessage("추적 프롬프트가 추가되었습니다.");
  }

  function removeCustomPrompt(value: string, deleteResponses?: boolean) {
    setState((prev) => ({
      ...prev,
      customPrompts: prev.customPrompts.filter((entry) => entry.text !== value),
      runs: deleteResponses
        ? prev.runs.filter((r) => r.prompt !== value)
        : prev.runs,
    }));
  }

  function updatePromptTags(text: string, tags: string[]) {
    setState((prev) => ({
      ...prev,
      customPrompts: prev.customPrompts.map((p) =>
        p.text === text ? { ...p, tags } : p,
      ),
    }));
  }

  function deleteRun(index: number) {
    setState((prev) => ({
      ...prev,
      runs: prev.runs.filter((_, i) => i !== index),
    }));
  }

  function extractNicheQueries(payload: unknown) {
    const data = payload as {
      text?: unknown;
      output?: unknown;
      response?: unknown;
      content?: unknown;
    };

    const directText = [data.text, data.output, data.response, data.content].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) as string | undefined;

    const raw = directText ?? "";
    // Strip markdown fences entirely
    const cleaned = raw.replace(/```[\w]*\n?/g, "").trim();

    // Try JSON array first
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]) as unknown;
        if (Array.isArray(parsed)) {
          const items = parsed
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter((line) => line.length > 10)
            .slice(0, 20);
          if (items.length > 0) return items;
        }
      } catch {
        // fall through to line parsing
      }
    }

    // Line-by-line parsing
    const fromLines = cleaned
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*[-*•]\s+/, "")
          .replace(/^\s*\d+[.)]\s+/, "")
          .replace(/^\s*"|"\s*$/g, "")
          .replace(/^\*\*(.+?)\*\*$/, "$1")
          .replace(/^"+|"+$/g, "")
          .trim(),
      )
      .filter((line) => line.length > 10 && line.length < 300)
      .filter((line) => !/^(here\s+(are|is)|high[- ]intent|sure|certainly|below|the following)\b/i.test(line))
      .filter((line) => line.includes(" ")); // must have at least 2 words

    return fromLines.slice(0, 20);
  }

  async function runNicheExplorer() {
    if (demoMode) { setMessage("데모 모드 — API 호출이 비활성화되어 있습니다"); return; }
    setBusy(true);
    setMessage("니치 쿼리를 생성 중입니다...");

    try {
      const response = await fetch(BP + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `다음 니치에 대해, 실제 한국 사용자가 ChatGPT/Perplexity/Gemini 같은 AI에게 물어볼 만한 고의도(high-intent) 검색 질문을 정확히 12개 한국어로 생성하세요: "${state.niche}".

요구사항:
- 전부 한국어로 작성, 자연스럽고 구어체에 가까운 질문
- 정보형(informational), 비교형(comparison), 구매/결정 단계(decision-stage)를 고르게 섞을 것
- "출처와 함께", "전문가 기준으로", "추천 기관과 이유" 같은 출처 요청 표현을 일부에 포함
- 브랜드명을 직접 넣지 말고, 카테고리/상위 질문 위주로
- 번호가 매겨진 리스트만 반환 (설명·서두 금지, 한 줄에 하나씩)`,
          maxTokens: 1500,
          skipCache: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Niche generation failed");

      const queries = extractNicheQueries(data);

      setState((prev) => ({ ...prev, nicheQueries: queries }));
      setMessage(
        queries.length > 0
          ? "니치 쿼리가 업데이트되었습니다."
          : "유효한 니치 쿼리가 반환되지 않았습니다. 더 구체적인 니치를 입력하세요.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "쿼리 생성 실패.");
    } finally {
      setBusy(false);
    }
  }

  async function runBattlecards() {
    if (demoMode) { setMessage("데모 모드 — API 호출이 비활성화되어 있습니다"); return; }
    setBusy(true);
    setMessage("경쟁사 배틀카드 생성 중...");

    try {
      const competitorList = state.competitors
        .map((c) => c.name.trim())
        .filter(Boolean);

      if (competitorList.length === 0) {
        setMessage("경쟁사를 최소 1개 이상 먼저 추가하세요.");
        setBusy(false);
        return;
      }

      const exampleJson = JSON.stringify([
        {
          competitor: "example.com",
          sentiment: "positive",
          summary: "Strong brand presence with frequent citations.",
          sections: [
            { heading: "Strengths", points: ["High domain authority", "Frequent AI citations"] },
            { heading: "Weaknesses", points: ["Limited product range"] },
            { heading: "Pricing", points: ["Premium tier: $99/mo", "Free plan available"] },
            { heading: "AI Visibility", points: ["Mentioned in 8/10 tested prompts"] },
          ],
        },
      ]);

      const response = await fetch(BP + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `You are an AI search visibility analyst. Analyze how AI models (ChatGPT, Perplexity, Gemini, Copilot, Google AI, Grok) likely perceive each of these competitors: ${competitorList.join(", ")}.

For EACH competitor, provide a JSON object with:
- "competitor": the name exactly as given
- "sentiment": one of "positive", "neutral", or "negative" based on likely AI recommendation tone
- "summary": 2-3 sentences overview
- "sections": an array of objects with "heading" (string) and "points" (string[]) covering:
  * "Strengths" — what the competitor does well in AI visibility
  * "Weaknesses" — gaps or disadvantages
  * "Pricing Insights" — known pricing tiers or cost perception
  * "AI Visibility" — how often/prominently they appear in AI responses
  * "Key Differentiators" — what sets them apart

Return ONLY a valid JSON array. No markdown fences. No extra text. Example format:
${exampleJson}

Now analyze all ${competitorList.length} competitors:`,
          maxTokens: Math.max(2000, Math.min(4096, 500 * competitorList.length)),
          temperature: 0.3,
          skipCache: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Battlecard generation failed");

      const text = String(data.text ?? "").trim();

      let parsed: Battlecard[] | null = null;

      const normalizeBattlecards = (arr: unknown): Battlecard[] => {
        if (!Array.isArray(arr)) return [];
        const mapped = arr
          .map((item) => {
            const record = (item ?? {}) as Record<string, unknown>;
            const competitor = String(record.competitor ?? "").trim();
            if (!competitor) return null;
            const sentimentRaw = String(record.sentiment ?? "neutral").toLowerCase();
            const sentiment = (["positive", "neutral", "negative"].includes(sentimentRaw)
              ? sentimentRaw
              : "neutral") as "positive" | "neutral" | "negative";
            const summary = String(record.summary ?? record.analysis ?? "No summary provided.").trim();
            // Parse structured sections
            const rawSections = Array.isArray(record.sections) ? record.sections : [];
            const sections = rawSections
              .map((s: unknown) => {
                const sec = (s ?? {}) as Record<string, unknown>;
                const heading = String(sec.heading ?? "").trim();
                const points = Array.isArray(sec.points) ? sec.points.map((p: unknown) => String(p).trim()).filter(Boolean) : [];
                return heading && points.length > 0 ? { heading, points } : null;
              })
              .filter((s): s is { heading: string; points: string[] } => s !== null);
            return { competitor, sentiment, summary, sections: sections.length > 0 ? sections : undefined } as Battlecard;
          });
        return mapped.filter((entry): entry is Battlecard => entry !== null);
      };

      const parseCandidate = (candidate: string): Battlecard[] => {
        try {
          return normalizeBattlecards(JSON.parse(candidate));
        } catch {
          return [];
        }
      };

      const direct = parseCandidate(text);
      if (direct.length > 0) {
        parsed = direct;
      }

      if (!parsed) {
        const noFence = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
        const fromNoFence = parseCandidate(noFence);
        if (fromNoFence.length > 0) parsed = fromNoFence;
      }

      if (!parsed) {
        const start = text.indexOf("[");
        if (start >= 0) {
          for (let i = text.length - 1; i > start; i -= 1) {
            if (text[i] !== "]") continue;
            const candidate = text.slice(start, i + 1);
            const maybe = parseCandidate(candidate);
            if (maybe.length > 0) {
              parsed = maybe;
              break;
            }
          }
        }
      }

      // Fallback: use raw text split by competitor names
      if (!parsed || parsed.length === 0) {
        parsed = competitorList.map((name) => {
          // Try to find a section about this competitor in the raw text
          const namePattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const idx = text.search(namePattern);
          const snippet = idx >= 0 ? text.slice(idx, idx + 300).replace(/[#*`]/g, "").trim() : "";
          return {
            competitor: name,
            sentiment: "neutral" as const,
            summary: snippet || `AI could not generate structured analysis. Raw response: ${text.slice(0, 200)}`,
          };
        });
      }

      setState((prev) => ({ ...prev, battlecards: parsed! }));
      setMessage(`${parsed!.length}개 경쟁사 배틀카드가 준비되었습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "배틀카드 생성 실패.");
    } finally {
      setBusy(false);
    }
  }

  async function runAudit() {
    if (demoMode) { setMessage("데모 모드 — API 호출이 비활성화되어 있습니다"); return; }
    setBusy(true);
    setMessage("AEO 감사를 실행 중입니다...");

    try {
      const response = await fetch(BP + "/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: state.auditUrl }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Audit failed");

      const newEntry = {
        id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        url: data.url,
        createdAt: new Date().toISOString(),
        report: data,
      };

      setState((prev) => ({
        ...prev,
        auditReport: data,
        auditHistory: [newEntry, ...(prev.auditHistory ?? [])].slice(0, 30),
      }));
      setMessage("감사 완료 — 이력에 자동 저장되었습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "감사 실행 실패.");
    } finally {
      setBusy(false);
    }
  }

  function handleDeleteAuditHistory(id: string) {
    setState((prev) => ({
      ...prev,
      auditHistory: (prev.auditHistory ?? []).filter((e) => e.id !== id),
    }));
  }

  function handleUpdateAuditNote(id: string, note: string) {
    setState((prev) => ({
      ...prev,
      auditHistory: (prev.auditHistory ?? []).map((e) =>
        e.id === id ? { ...e, note } : e,
      ),
    }));
  }

  /** 이력 항목의 리포트를 현재 보기로 로드 */
  function handleViewAuditHistory(id: string) {
    const entry = (state.auditHistory ?? []).find((e) => e.id === id);
    if (!entry) return;
    setState((prev) => ({
      ...prev,
      auditUrl: entry.url,
      auditReport: entry.report,
    }));
    setMessage(`이력 로드: ${entry.createdAt.replace("T", " ").slice(0, 16)} · ${entry.url}`);
  }

  async function handleResetData() {
    if (demoMode) { setMessage("데모 모드 — 데이터를 변경할 수 없습니다"); return; }
    if (!window.confirm("저장된 모든 데이터(실행 이력, 프롬프트, 설정)가 삭제됩니다. 계속하시겠습니까?")) return;

    // 진행 중이던 scrape/batch 응답이 초기화 이후 state에 유입되는 걸 차단
    resetTokenRef.current += 1;
    activeControllersRef.current.forEach((c) => c.abort());
    activeControllersRef.current.clear();
    try {
      await fetch(BP + "/api/cache/clear", { method: "POST" });
    } catch {
      // 서버 캐시 클리어 실패는 무시 — UI 초기화는 진행
    }

    await clearSovereignStore(storageKeyForWorkspace(activeWsId));
    setBusy(false);
    setState(defaultState);
    setMessage("모든 데이터가 초기화되었습니다.");
  }

  /** 응답/분석 이력만 초기화 (설정·프롬프트·경쟁사는 유지) */
  async function handleResetResponses() {
    if (demoMode) { setMessage("데모 모드 — 데이터를 변경할 수 없습니다"); return; }
    if (!window.confirm("AI 응답 이력, 배틀카드, 감사 결과, 변동 알림이 삭제됩니다.\n프로젝트 설정과 프롬프트는 유지됩니다. 계속하시겠습니까?")) return;

    // 1) 진행 중인 모든 scrape 요청 취소 + 초기화 토큰 증가 (stale 응답 가드)
    //    abort 이후에 이미 response.json()까지 완료된 요청이 뒤늦게 도착해
    //    빈 state에 run을 추가하던 버그 차단. 수동/배치/자동 경로 모두 이 토큰으로 폐기.
    resetTokenRef.current += 1;
    const pending = activeControllersRef.current.size;
    activeControllersRef.current.forEach((c) => c.abort());
    activeControllersRef.current.clear();

    // 2) 서버 인메모리 캐시(20분 TTL) 비우기 — 동일 프롬프트 재실행 시 Bright Data 재호출 보장
    let cacheCleared = 0;
    try {
      const resp = await fetch(BP + "/api/cache/clear", { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        cacheCleared = data.cleared ?? 0;
      }
    } catch {
      // 실패해도 UI 상태는 계속 초기화
    }

    // 3) 클라이언트 상태 비우기
    setBusy(false);
    setState((prev) => ({
      ...prev,
      runs: [],
      battlecards: [],
      auditReport: null,
      driftAlerts: [],
      lastScheduledRun: null,
    }));
    setMessage(
      `응답 이력 초기화 완료 (진행 중 ${pending}건 취소 · 서버 캐시 ${cacheCleared}건 삭제)`,
    );
  }

  function renderActiveTab() {
    if (activeTab === "Home") {
      return (
        <HomeTab
          runs={state.runs}
          onOpenTab={(tab) => setActiveTab(tab as TabKey)}
        />
      );
    }

    if (activeTab === "Project Settings") {
      return (
        <ProjectSettingsTab
          brand={state.brand}
          onBrandChange={(patch) =>
            setState((prev) => ({ ...prev, brand: { ...prev.brand, ...patch } }))
          }
          onReset={handleResetData}
          onResetResponses={handleResetResponses}
          fullState={state}
        />
      );
    }

    if (activeTab === "Prompt Hub") {
      return (
        <PromptHubTab
          customPrompts={state.customPrompts}
          busy={busy}
          activeProviderCount={state.activeProviders.length}
          onAddCustomPrompt={addCustomPrompt}
          onRemoveCustomPrompt={removeCustomPrompt}
          onUpdatePromptTags={updatePromptTags}
          onRunPrompt={callScrape}
          onBatchRunAll={batchRunAllPrompts}
        />
      );
    }

    if (activeTab === "Persona Fan-Out") {
      return (
        <FanOutTab
          prompt={state.prompt}
          personas={state.personas}
          fanoutPrompts={state.fanoutPrompts}
          busy={busy}
          onPromptChange={(value) => setState((prev) => ({ ...prev, prompt: value }))}
          onPersonasChange={(value) => setState((prev) => ({ ...prev, personas: value }))}
          onGenerateFanout={generatePersonaFanout}
          onRunPrompt={callScrape}
        />
      );
    }

    if (activeTab === "Niche Explorer") {
      return (
        <NicheExplorerTab
          niche={state.niche}
          nicheQueries={state.nicheQueries}
          trackedPrompts={state.customPrompts.map((p) => p.text)}
          busy={busy}
          onNicheChange={(value) => setState((prev) => ({ ...prev, niche: value }))}
          onGenerateQueries={runNicheExplorer}
          onAddToTracking={addCustomPrompt}
        />
      );
    }

    if (activeTab === "Automation") {
      return (
        <AutomationServerTab
          brand={state.brand}
          competitors={state.competitors}
          customPrompts={state.customPrompts}
        />
      );
    }

    if (activeTab === "Competitor Battlecards") {
      return (
        <BattlecardsTab
          competitors={state.competitors}
          battlecards={state.battlecards}
          onCompetitorsChange={(competitors) => setState((prev) => ({ ...prev, competitors }))}
          onBuildBattlecards={runBattlecards}
        />
      );
    }

    if (activeTab === "Responses") {
      return (
        <ReputationSourcesTab
          runs={state.runs}
          brandTerms={getBrandTerms()}
          competitorTerms={getCompetitorTerms()}
          runDeltas={runDeltas}
          onDeleteRun={deleteRun}
        />
      );
    }

    if (activeTab === "Visibility Analytics") {
      return <VisibilityAnalyticsTab data={visibilityTrend} runs={state.runs} brandTerms={getBrandTerms()} />;
    }

    if (activeTab === "Citations") {
      return <PartnerDiscoveryTab partnerLeaderboard={partnerLeaderboard} brandWebsites={state.brand.websites} />;
    }

    if (activeTab === "Citation Opportunities") {
      return <CitationOpportunitiesTab runs={state.runs} brandWebsites={state.brand.websites} />;
    }

    if (activeTab === "SRO Analysis") {
      return null; // rendered persistently below to preserve state
    }

    if (activeTab === "GSC Performance") {
      return (
        <GscPerformanceTab
          brandName={state.brand.brandName}
          brandAliases={state.brand.brandAliases}
          websites={state.brand.websites}
          competitors={state.competitors}
        />
      );
    }

    if (activeTab === "AI Referral") {
      return <Ga4ReferralTab />;
    }

    if (activeTab === "NAVER AI") {
      return (
        <NaverAiTab
          brandName={state.brand.brandName}
          brandAliases={state.brand.brandAliases}
          websites={state.brand.websites}
          competitors={state.competitors}
        />
      );
    }

    if (activeTab === "Bing Citations") {
      return <BingCitationsTab />;
    }

    if (activeTab === "Documentation") {
      return <DocumentationTab />;
    }

    return (
      <AeoAuditTab
        auditUrl={state.auditUrl}
        auditReport={state.auditReport}
        auditHistory={state.auditHistory ?? []}
        onAuditUrlChange={(value) => setState((prev) => ({ ...prev, auditUrl: value }))}
        onRunAudit={runAudit}
        onDeleteAuditHistory={handleDeleteAuditHistory}
        onUpdateAuditNote={handleUpdateAuditNote}
        onViewAuditHistory={handleViewAuditHistory}
      />
    );
  }

  const themeIcon = theme === "dark" ? "🌙" : theme === "light" ? "☀️" : "💻";

  return (
    <div className="flex h-screen overflow-hidden text-th-text">
      {/* ── Mobile sidebar backdrop ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* ── Sidebar ──────────────────────────────────── */}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[250px] shrink-0 flex-col border-r border-th-border bg-th-sidebar transition-transform duration-200 md:static md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        {/* Brand / Workspace switcher */}
        <div className="border-b border-th-border px-4 py-3">
          {demoMode ? (
            <div className="flex items-center gap-2 px-1 py-0.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-th-accent">
                <span className="text-xs font-bold text-th-text-inverse">
                  {(state.brand.brandName || "AE").slice(0, 2).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-th-text">
                  {state.brand.brandName || "GEO 트래커"}
                </div>
                <div className="text-xs text-th-text-muted">데모 워크스페이스</div>
              </div>
            </div>
          ) : (
          <>
          <button
            onClick={() => setShowWsPicker(!showWsPicker)}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-th-card-hover transition-colors"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-th-accent">
              <span className="text-xs font-bold text-th-text-inverse">
                {(state.brand.brandName || "AE").slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-th-text">
                {state.brand.brandName || "GEO 트래커"}
              </div>
              {state.brand.websites.length > 0 && (
                <div className="truncate text-xs text-th-text-muted">{state.brand.websites[0].replace(/^https?:\/\//, "")}{state.brand.websites.length > 1 ? ` +${state.brand.websites.length - 1}` : ""}</div>
              )}
            </div>
            <span className="text-xs text-th-text-muted">{showWsPicker ? "▲" : "▼"}</span>
          </button>

          {/* Workspace dropdown */}
          {showWsPicker && (
            <div className="mt-2 rounded-lg border border-th-border bg-th-card p-2 shadow-lg">
              <div className="mb-2 text-xs font-medium text-th-text-muted uppercase tracking-wider">워크스페이스</div>
              <div className="max-h-[200px] space-y-1 overflow-auto">
                {workspaces.map((ws) => (
                  <div key={ws.id} className="flex items-center gap-1">
                    <button
                      onClick={() => switchWorkspace(ws.id)}
                      className={`flex-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        ws.id === activeWsId
                          ? "bg-th-accent-soft text-th-text-accent font-medium"
                          : "text-th-text-secondary hover:bg-th-card-hover"
                      }`}
                    >
                      {ws.brandName || "이름 없음"}
                    </button>
                    {workspaces.length > 1 && (
                      <button
                        onClick={() => deleteWorkspace(ws.id)}
                        className="rounded p-1 text-xs text-th-text-muted hover:text-th-danger hover:bg-th-danger-soft"
                        title="워크스페이스 삭제"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  const name = window.prompt("브랜드 / 워크스페이스 이름:");
                  if (name?.trim()) createWorkspace(name.trim());
                }}
                className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-dashed border-th-border px-2 py-1.5 text-sm text-th-text-accent hover:bg-th-accent-soft transition-colors"
              >
                <span className="text-base">+</span> 새 브랜드
              </button>
            </div>
          )}
          </>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {visibleTabs.map((tab) => {
            const active = activeTab === tab;
            const isSettings = tab === "Project Settings";
            // "분석 영역" 라벨은 visibleTabs 에서 "Home" 바로 다음 오는 탭 앞에 표시
            const homeIdx = visibleTabs.indexOf("Home");
            const firstAnalysisTab = homeIdx >= 0 ? visibleTabs[homeIdx + 1] : undefined;
            const isFirstAnalysis = tab === firstAnalysisTab;
            return (
              <div key={tab}>
                {isFirstAnalysis && (
                  <div className="mb-1 mt-3 px-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
                    분석 영역
                  </div>
                )}
                {isSettings && (
                  <div className="mb-1 mt-2 border-t border-th-border pt-2 px-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
                    설정
                  </div>
                )}
                <button
                  title={tabMeta[tab].tooltip}
                  onClick={() => { setActiveTab(tab); setSidebarOpen(false); }}
                  className={`group mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    active
                      ? "bg-th-accent-soft text-th-text font-medium"
                      : "text-th-text-secondary hover:bg-th-card-hover hover:text-th-text"
                  }`}
                  style={active ? { boxShadow: "inset 3px 0 0 var(--th-accent)" } : undefined}
                >
                  <span className={active ? "text-th-text-accent" : "text-th-text-muted group-hover:text-th-text-secondary"}>
                    {tabIcons[tab]}
                  </span>
                  {tabMeta[tab].title}
                  {tab === "Automation" && unreadAlertCount > 0 && (
                    <span className="ml-auto rounded-full bg-th-danger px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                      {unreadAlertCount}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </nav>

        {/* Powered by links */}
        <div className="flex items-center justify-center gap-3 border-t border-th-border px-3 py-2 text-xs text-th-text-muted">
          <a
            href="https://brightdata.com/?utm_source=geo-tracker-os"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-th-text-accent hover:underline"
          >
            Bright Data
          </a>
          <span className="text-th-border">·</span>
          <a
            href="https://openrouter.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-th-text-accent hover:underline"
          >
            OpenRouter
          </a>
        </div>

        {/* User info + logout */}
        {(auth.kind === "admin" || auth.role > 0) && (
          <div className="flex items-center justify-between gap-2 border-t border-th-border px-4 py-2 text-xs text-th-text-muted">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">{auth.kind === "admin" ? "🛡️" : "👤"}</span>
              <span className="truncate">
                {auth.kind === "admin"
                  ? "최고관리자"
                  : auth.name || auth.email || "일반관리자"}
              </span>
            </div>
            <button
              type="button"
              onClick={async () => {
                const kind = auth.kind === "admin" ? "admin" : "user";
                const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/geo-tracker";
                await fetch(`${basePath}/api/auth/logout?kind=${kind}`, {
                  method: "POST",
                  credentials: "include",
                });
                // 최고관리자는 /admin/login, 일반관리자는 CMS 로그아웃으로 이동
                if (kind === "admin") {
                  window.location.href = `${basePath}/admin/login`;
                } else {
                  try {
                    const { firebaseSignOut } = await import("@/lib/auth/firebase-client");
                    await firebaseSignOut();
                  } catch { /* noop */ }
                  window.location.href = `${basePath}/login`;
                }
              }}
              className="shrink-0 rounded border border-th-border px-2 py-0.5 hover:bg-th-card-hover hover:text-th-text"
            >
              로그아웃
            </button>
          </div>
        )}

        {/* Footer info */}
        <div className="border-t border-th-border px-4 py-2 text-center text-xs leading-relaxed text-th-text-muted">
          {demoMode && <div>읽기 전용 데모</div>}
          <div className={demoMode ? "mt-1" : ""}>매직바디 GEO 트래커</div>
        </div>
      </aside>

      {/* ── Main content ───────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Demo banner */}
        {demoMode && (
          <div className="flex shrink-0 items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-medium text-white shadow-sm">
            <span>🎯</span>
            <span>읽기 전용 데모를 보고 있습니다 — 데이터는 미리 로드되어 있고 API 호출은 비활성화됩니다</span>
          </div>
        )}
        {/* Toolbar */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-th-border bg-th-card px-3 py-2 md:gap-3 md:px-5 md:py-2.5">
          {/* Hamburger for mobile */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-md border border-th-border p-1.5 text-th-text-muted hover:bg-th-card-hover md:hidden"
            aria-label="사이드바 토글"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <h1 className="mr-auto text-sm font-semibold text-th-text md:text-base">{tabMeta[activeTab].title}</h1>
          <label className="hidden text-sm text-th-text-muted sm:inline">AI 모델</label>
          <div className="flex items-center gap-1 overflow-x-auto">
            {VISIBLE_PROVIDERS.map((p) => {
              const active = state.activeProviders.includes(p);
              return (
                <button
                  key={p}
                  onClick={() =>
                    setState((prev) => {
                      const next = active
                        ? prev.activeProviders.filter((x) => x !== p)
                        : [...prev.activeProviders, p];
                      if (next.length === 0) return prev;
                      return { ...prev, activeProviders: next, provider: next[0] };
                    })
                  }
                  className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "bg-th-accent text-th-text-inverse"
                      : "bg-th-card-alt text-th-text-muted hover:bg-th-card-hover hover:text-th-text-secondary"
                  }`}
                  title={active ? `${PROVIDER_LABELS[p]} 선택 해제` : `${PROVIDER_LABELS[p]} 선택`}
                >
                  {PROVIDER_LABELS[p]}
                </button>
              );
            })}
            <button
              onClick={() =>
                setState((prev) => {
                  const visible = VISIBLE_PROVIDERS;
                  const allVisibleSelected = visible.every((p) => prev.activeProviders.includes(p));
                  return {
                    ...prev,
                    activeProviders: allVisibleSelected ? [prev.provider] : [...visible],
                  };
                })
              }
              className="ml-1 rounded-md border border-th-border px-2 py-1 text-xs text-th-text-muted hover:bg-th-card-hover hover:text-th-text-secondary"
              title={VISIBLE_PROVIDERS.every((p) => state.activeProviders.includes(p)) ? "하나만 선택" : "모든 모델 선택"}
            >
              {VISIBLE_PROVIDERS.every((p) => state.activeProviders.includes(p)) ? "1개" : "전체"}
            </button>
          </div>

          {/* Theme toggle */}
          <button
            onClick={cycleTheme}
            className="rounded-md border border-th-border px-2 py-1 text-sm hover:bg-th-card-hover transition-colors"
            title={`테마: ${theme === "dark" ? "어둡게" : theme === "light" ? "밝게" : "시스템"}`}
          >
            {themeIcon}
          </button>

          <span className={`rounded-md px-2.5 py-1 text-xs ${busy ? "animate-pulse bg-th-accent-soft text-th-text-accent" : "bg-th-card-alt text-th-text-muted"}`}>
            {message || "준비됨"}
          </span>
        </header>

        {/* Scrollable body */}
        <main className="flex-1 overflow-y-auto bg-th-bg px-3 py-3 md:px-5 md:py-4">
          {/* KPI strip - 메인/프롬프트허브/AI응답/가시성 페이지에만 노출 */}
          {SHOW_KPI_TABS.includes(activeTab) && (
            <section className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-5">
              <KpiCard label="전체 실행" value={state.runs.length} />
              <KpiCard
                label="평균 가시성"
                value={
                  state.runs.length > 0
                    ? `${Math.round(state.runs.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / state.runs.length)}%`
                    : "—"
                }
                delta={kpiVisibilityDelta}
                small
                onInfoClick={() => setShowScoreInfo(!showScoreInfo)}
              />
              <KpiCard
                label="브랜드 언급"
                value={state.runs.filter((r) => (r.brandMentions?.length ?? 0) > 0).length}
              />
              <KpiCard label="수집된 출처" value={totalSources} />
              <KpiCard
                label="최근 실행"
                value={
                  latestRun
                    ? latestRun.createdAt.replace("T", " ").slice(0, 16)
                    : "—"
                }
                small
              />
            </section>
          )}

          {/* 인용 기회 카드 - 인용 기회 페이지에만 노출 */}
          {activeTab === "Citation Opportunities" && (
            <section className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
              <KpiCard label="인용 기회" value={citationOpportunities} />
            </section>
          )}

          {/* ── Movers strip — KPI와 동일한 페이지에서만 ── */}
          {SHOW_KPI_TABS.includes(activeTab) && movers.length > 0 && (
            <section className="mb-4 rounded-xl border border-th-border bg-th-card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-base">📊</span>
                <h3 className="text-sm font-semibold text-th-text">주요 변동</h3>
                <span className="text-xs text-th-text-muted">실행 간 가시성 변화가 큰 항목</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {movers.map((m, i) => {
                  const up = m.delta > 0;
                  return (
                    <div
                      key={`${m.prompt.slice(0, 20)}-${m.provider}-${i}`}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                        up
                          ? "border-th-success/30 bg-th-success-soft"
                          : "border-th-danger/30 bg-th-danger-soft"
                      }`}
                    >
                      <span className={`text-lg font-bold ${up ? "text-th-success" : "text-th-danger"}`}>
                        {up ? "↑" : "↓"}{Math.abs(m.delta)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-th-text" style={{ maxWidth: "180px" }}>
                          {m.prompt.length > 50 ? m.prompt.slice(0, 47) + "…" : m.prompt}
                        </div>
                        <div className="text-xs text-th-text-muted">
                          {PROVIDER_LABELS[m.provider]} · {m.previousScore}→{m.currentScore}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Scoring explanation */}
          {showScoreInfo && (
            <section className="mb-4 rounded-xl border border-th-border bg-th-card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-th-text">가시성 점수 산정 방식</h3>
                <button onClick={() => setShowScoreInfo(false)} className="text-th-text-muted hover:text-th-text text-lg">✕</button>
              </div>
              <p className="text-sm text-th-text-secondary mb-3">
                가시성 점수(0–100)는 AI 응답에서 브랜드가 얼마나 두드러지게 등장하는지 측정합니다. 각 요소가 점수에 기여합니다:
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <ScoreFactorCard emoji="🔍" label="브랜드 언급" points="+30" desc="응답에 브랜드명 또는 별칭이 등장" />
                <ScoreFactorCard emoji="🏆" label="노출 위치" points="+20" desc="첫 200자 이내에 브랜드가 등장" />
                <ScoreFactorCard emoji="🔁" label="반복 언급" points="+8~+15" desc="2회 이상(8점) 또는 3회 이상(15점) 언급" />
                <ScoreFactorCard emoji="🔗" label="웹사이트 인용" points="+20" desc="인용 출처에 자사 웹사이트 URL 포함" />
                <ScoreFactorCard emoji="👍" label="긍정 감성" points="+15" desc="응답이 브랜드를 긍정적으로 언급" />
                <ScoreFactorCard emoji="😐" label="중립 감성" points="+5" desc="응답이 브랜드를 중립적 문맥에서 언급" />
              </div>
            </section>
          )}

          {/* Active tab panel */}
          <section className="rounded-xl border border-th-border bg-th-card p-5 shadow-sm">{renderActiveTab()}</section>
          {/* SRO Analysis stays mounted to preserve in-flight state */}
          <div className={activeTab === "SRO Analysis" ? "" : "hidden"}>
            <section className="rounded-xl border border-th-border bg-th-card p-5 shadow-sm">
              <SROAnalysisTab />
            </section>
          </div>
          <section className="mt-3 rounded-lg border border-th-border bg-th-card px-4 py-3">
            <div className="text-xs uppercase tracking-wider font-medium text-th-text-muted">이 탭의 역할</div>
            <p className="mt-1 text-sm leading-relaxed text-th-text-secondary">{tabMeta[activeTab].details}</p>
          </section>
        </main>
      </div>
    </div>
  );
}

/* ── Score Factor Card ────────────────────────────────────────── */
function ScoreFactorCard({ emoji, label, points, desc }: { emoji: string; label: string; points: string; desc: string }) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{emoji}</span>
        <span className="text-sm font-medium text-th-text">{label}</span>
        <span className="ml-auto text-sm font-semibold text-th-accent">{points}</span>
      </div>
      <p className="text-xs text-th-text-muted leading-relaxed">{desc}</p>
    </div>
  );
}

/* ── Compact KPI Card ─────────────────────────────────────────── */
function KpiCard({ label, value, small, delta, onInfoClick }: { label: string; value: string | number; small?: boolean; delta?: number | null; onInfoClick?: () => void }) {
  return (
    <div className="rounded-xl border border-th-border bg-th-card px-4 py-3 shadow-sm">
      <div className="flex items-center gap-1">
        <div className="text-xs font-medium uppercase tracking-wider text-th-text-muted">{label}</div>
        {onInfoClick && (
          <button onClick={onInfoClick} className="text-th-text-muted hover:text-th-text-accent text-xs" title="점수 산정 방식">ⓘ</button>
        )}
      </div>
      <div className={`mt-1 flex items-center gap-1.5 font-semibold text-th-text ${small ? "text-base" : "text-xl"}`}>
        {value}
        {delta != null && delta !== 0 && (
          <span className={`text-xs font-bold ${delta > 0 ? "text-th-success" : "text-th-danger"}`}>
            {delta > 0 ? "↑" : "↓"}{Math.abs(delta)}
          </span>
        )}
      </div>
    </div>
  );
}
