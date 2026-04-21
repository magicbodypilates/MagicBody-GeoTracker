"use client";

import { useState } from "react";

type DocSection = {
  id: string;
  title: string;
  icon: string;
  content: string[];
};

const sections: DocSection[] = [
  {
    id: "overview",
    title: "개요",
    icon: "📖",
    content: [
      "GEO/AEO 트래커는 ChatGPT, Perplexity, Gemini, Google AI 등 AI 모델에서 브랜드가 어떻게 노출되는지 모니터링하는 로컬 우선 오픈소스 인텔리전스 대시보드입니다.",
      "모든 데이터는 브라우저(localStorage + IndexedDB)에 저장됩니다. 스크랩이나 분석을 명시적으로 실행하지 않는 한 데이터가 외부로 전송되지 않습니다.",
      "핵심 기능: 다중 모델 브랜드 추적, 가시성 점수, 감성 분석, 인용 발견, 경쟁사 배틀카드, AEO 사이트 감사, 자동화 템플릿.",
    ],
  },
  {
    id: "project-settings",
    title: "프로젝트 설정",
    icon: "⚙️",
    content: [
      "브랜드 정체성 구성: 이름, 별칭, 웹사이트 URL, 업종, 타겟 키워드, 간단한 설명.",
      "이 컨텍스트는 모든 AI 프롬프트에 주입되어 비즈니스와 관련된 분석이 되도록 합니다.",
      "브랜드 별칭으로 약어나 비공식 명칭을 추적할 수 있습니다 (예: 'Bright Data'를 'BD'로).",
      "필요 시 이 탭에서 모든 데이터를 초기화할 수 있습니다.",
    ],
  },
  {
    id: "prompt-hub",
    title: "프롬프트 허브",
    icon: "💬",
    content: [
      "추적 프롬프트 라이브러리를 구축합니다. {brand}를 플레이스홀더로 사용하면 실행 시 브랜드 이름으로 대체됩니다.",
      "활성화된 모든 모델에서 단일 프롬프트를 실행하거나, 전체 라이브러리를 한 번에 일괄 실행할 수 있습니다.",
      "프롬프트는 워크스페이스별로 저장되므로 브랜드마다 고유한 프롬프트 세트를 가질 수 있습니다.",
      "팁: 프롬프트에 '출처 포함' 또는 '참고 문헌 포함'을 넣으면 AI 모델이 인용 탭에서 분석 가능한 URL을 인용하도록 유도할 수 있습니다.",
    ],
  },
  {
    id: "persona-fanout",
    title: "페르소나 팬아웃",
    icon: "👥",
    content: [
      "하나의 핵심 쿼리를 작성하고 페르소나 목록(마케팅 책임자, SEO 리드, 창업자 등)을 정의합니다.",
      "시스템이 페르소나별 프롬프트 변형을 자동 생성합니다.",
      "각 변형을 독립적으로 실행하여 청중 관점에 따라 모델 응답과 브랜드 가시성이 어떻게 달라지는지 확인합니다.",
      "AI 모델에서 브랜드가 어떤 구매자 페르소나와 가장 공명하는지 파악하는 데 도움이 됩니다.",
    ],
  },
  {
    id: "niche-explorer",
    title: "니치 탐색기",
    icon: "🔍",
    content: [
      "니치 또는 제품 카테고리를 입력하여 실제 구매자가 AI 어시스턴트에 입력할 법한 고의도 검색 쿼리를 생성합니다.",
      "쿼리는 AI가 생성하며 정보 탐색, 비교, 결정 단계 의도에 초점을 맞춥니다.",
      "생성된 쿼리를 프롬프트 허브에 바로 추가해 지속적으로 추적할 수 있습니다.",
      "직접 떠올리기 어려운 프롬프트까지 포함한 포괄적인 모니터링 세트를 구축하세요.",
    ],
  },
  {
    id: "responses",
    title: "응답",
    icon: "📝",
    content: [
      "프롬프트별로 그룹화된 모든 AI 모델 응답을 열람합니다.",
      "각 응답에는 모델 배지, 가시성 점수(0–100), 감성 태그, 브랜드/경쟁사 하이라이트, 인용된 출처가 표시됩니다.",
      "모델 또는 감성으로 필터링하고, 날짜 또는 점수로 정렬할 수 있습니다.",
      "상단 인사이트 스트립에는 평균 점수, 브랜드 언급률, 감성 분포, 모델별 평균 등 집계 통계가 표시됩니다.",
      "응답 카드를 펼치면 브랜드 용어는 파란색, 경쟁사 용어는 주황색으로 강조된 전체 AI 답변을 볼 수 있습니다.",
    ],
  },
  {
    id: "visibility-analytics",
    title: "가시성 애널리틱스",
    icon: "📊",
    content: [
      "추세 차트로 브랜드의 평균 가시성 점수를 시간 흐름에 따라 추적합니다.",
      "차트는 모든 프롬프트와 모델에 걸친 일일 평균 가시성(%)을 표시합니다.",
      "요약 카드에 전체 평균 가시성과 감성 분포(긍정, 중립, 부정, 미언급)가 표시됩니다.",
      "외부 분석을 위해 모든 실행 데이터 또는 추세 데이터를 CSV로 내보낼 수 있습니다.",
    ],
  },
  {
    id: "citations",
    title: "인용",
    icon: "🔗",
    content: [
      "AI 모델이 응답에서 가장 자주 인용하는 URL과 도메인을 분석합니다.",
      "상위 인용 도메인 막대 차트, URL/도메인 검색, 인용수/페이지/프롬프트/가나다 정렬 가능.",
      "도메인 단위 보기와 URL 단위 보기를 전환할 수 있습니다.",
      "최소 인용 수로 필터링하고 전체 테이블을 CSV로 내보낼 수 있습니다.",
      "자사 웹사이트는 '내 사이트' 뱃지로 표시되어 본인 도메인의 인용 여부를 즉시 확인할 수 있습니다.",
      "인용 기회 KPI: 브랜드가 언급되지 않은 응답에서 인용된 고유 도메인 수 — 아웃리치 타겟입니다.",
    ],
  },
  {
    id: "battlecards",
    title: "경쟁사 배틀카드",
    icon: "🏆",
    content: [
      "경쟁사 이름을 쉼표로 구분하여 입력하면 AI 기반 배틀카드가 생성됩니다.",
      "각 배틀카드는 감성, 요약, 강점, 약점, 가격 인사이트, AI 가시성 노트, 핵심 차별점을 포함합니다.",
      "배틀카드는 감성에 따라 색상이 구분됩니다 (초록=긍정, 노랑=중립, 빨강=부정).",
      "AI 모델이 경쟁사를 귀사 브랜드 대비 어떻게 인식하는지 파악하는 데 활용하세요.",
    ],
  },
  {
    id: "aeo-audit",
    title: "AEO 감사",
    icon: "✅",
    content: [
      "임의의 URL을 입력하여 답변 엔진 최적화(AEO) 감사를 실행합니다.",
      "검사 항목: llms.txt 존재 여부, 스키마/구조화 데이터 신호, BLUF(핵심 먼저 쓰기) 콘텐츠 명확성, 기술 준비도.",
      "각 검사는 카테고리(발견, 구조, 콘텐츠, 기술, 렌더링)로 분류되어 통과/실패 상태와 상세 내용이 표시됩니다.",
      "전체 점수(0–100)로 AI 생성 답변에 노출될 준비가 얼마나 되었는지 확인할 수 있습니다.",
    ],
  },
  {
    id: "sro-analysis",
    title: "SRO 분석",
    icon: "📡",
    content: [
      "검색 결과 최적화(SRO)는 URL + 키워드 조합에 대해 6단계 심층 분석 파이프라인을 실행합니다.",
      "1단계 — Gemini 그라운딩: Google Gemini 모델이 그라운딩 메타데이터를 통해 귀하의 페이지에 콘텐츠를 귀속시키는지 확인합니다.",
      "2단계 — 플랫폼 교차 인용: 4개 AI 플랫폼(ChatGPT, Perplexity, Gemini, Google AI)을 스크래핑하여 귀하의 URL을 인용하는 플랫폼을 확인합니다. (Copilot / Grok 은 현재 조사 대상에서 제외 — 추후 재추가 예정)",
      "3단계 — SERP 데이터: 실제 자연 검색 결과를 가져와 순위와 상위 경쟁사를 확인합니다.",
      "4단계 — 페이지 스크래핑: 타겟 페이지와 상위 경쟁사 페이지를 스크래핑하여 콘텐츠를 비교합니다.",
      "5단계 — 사이트 컨텍스트: 홈페이지에서 주요 정보를 추출해 컨텍스트 기반 권장사항을 제공합니다.",
      "6단계 — LLM 분석: 대형 언어 모델이 수집된 모든 데이터를 종합하여 SRO 점수(0–100), 실행 가능한 권장사항, 콘텐츠 갭, 경쟁사 인사이트를 생성합니다.",
      "결과: 전체 점수 링, 플랫폼 인용 그리드, SERP 순위 테이블, 우선순위 권장사항 및 액션 아이템, 콘텐츠 갭, 경쟁사 인사이트.",
      "SRO 탭은 백그라운드에서 유지되므로 분석 중 다른 탭으로 이동해도 진행 상태가 유지됩니다.",
      "참고: 플랫폼 인용 단계는 4개 AI 플랫폼의 결과를 Bright Data에서 폴링하므로 수 분이 소요될 수 있습니다.",
    ],
  },
  {
    id: "automation",
    title: "자동화",
    icon: "⚡",
    content: [
      "반복적인 프롬프트 실행을 위한 배포 준비 스케줄 템플릿을 저장합니다.",
      "Vercel Cron 또는 서버 측 스케줄링을 위한 cron 표현식 편집기.",
      "CI/CD 기반 자동 추적을 위한 GitHub Actions 워크플로우 템플릿.",
      "두 템플릿 중 하나를 인프라에 그대로 복사하여 자동화된 모니터링을 구축하세요.",
    ],
  },
  {
    id: "workspaces",
    title: "멀티 브랜드 워크스페이스",
    icon: "🏢",
    content: [
      "추적하는 브랜드 또는 고객사별로 워크스페이스를 분리 생성할 수 있습니다.",
      "각 워크스페이스는 자체 설정, 프롬프트, 실행, 데이터를 가지며 완전히 격리됩니다.",
      "사이드바 브랜드 선택기를 통해 워크스페이스를 즉시 전환할 수 있습니다.",
      "모든 워크스페이스 데이터는 브라우저 로컬에 저장됩니다.",
    ],
  },
  {
    id: "scoring",
    title: "가시성 점수 산정",
    icon: "🎯",
    content: [
      "각 AI 응답은 브랜드가 얼마나 돋보이게 나타나는지에 따라 0–100점으로 평가됩니다:",
      "• 브랜드 언급 시 → +30점",
      "• 첫 200자 내에 언급(돋보이는 위치) → +20점",
      "• 다중 언급: 2회 이상 → +8점, 3회 이상 → +15점",
      "• 웹사이트 URL이 출처로 인용 → +20점",
      "• 긍정 감성 → +15점, 중립 → +5점",
      "점수 상한은 100이며, 0점은 브랜드가 전혀 언급되지 않았음을 의미합니다.",
    ],
  },
  {
    id: "models",
    title: "지원 AI 모델",
    icon: "🤖",
    content: [
      "트래커는 현재 4개 AI 모델을 활성 상태로 지원합니다 (Copilot / Grok 은 일시 비활성 — HIDDEN_PROVIDERS 배열에서 재활성화 가능):",
      "• ChatGPT — OpenAI의 대화형 모델",
      "• Perplexity — 실시간 인용 중심의 검색형 AI",
      "• Gemini — Google의 멀티모달 AI",
      "• Google AI — Google AI Overview / SGE 결과",
      "툴바에서 모델을 켜고 끌 수 있으며, 원하는 조합으로 동시 실행할 수 있습니다.",
    ],
  },
  {
    id: "data-privacy",
    title: "데이터 및 개인정보",
    icon: "🔒",
    content: [
      "모든 데이터는 localStorage와 IndexedDB를 통해 브라우저 로컬에 저장됩니다.",
      "스크랩(Bright Data API) 또는 분석(사용자의 LLM API)을 명시적으로 실행하지 않는 한 데이터는 외부 서버로 전송되지 않습니다.",
      "애널리틱스 탭에서 모든 데이터를 CSV로 내보낼 수 있습니다.",
      "프로젝트 설정의 '데이터 초기화' 버튼으로 활성 워크스페이스의 저장 데이터를 영구 삭제할 수 있습니다.",
      "BYOK(Bring Your Own Key) 구조 — 사용자가 직접 API 키를 제공합니다.",
    ],
  },
  {
    id: "api-routes",
    title: "API 경로",
    icon: "🛰️",
    content: [
      "트래커는 /api/ 하위에 9개 API 경로를 노출합니다:",
      "• POST /api/scrape — Bright Data AI Scraper로 AI 모델에 질의합니다. provider, prompt, requireSources를 받고 브랜드 분석이 포함된 구조화 응답을 반환합니다.",
      "• POST /api/analyze — 배틀카드, 니치 쿼리, 페르소나 생성을 위한 OpenRouter LLM 추론. Edge 런타임에서 실행됩니다.",
      "• POST /api/audit — AEO 사이트 감사. URL을 크롤링하여 llms.txt, Schema.org, BLUF 밀도, 헤딩 구조 등을 확인합니다.",
      "• POST /api/sro-analyze — 최종 SRO 분석. 수집된 데이터(그라운딩, 플랫폼, SERP, 스크랩 페이지, 사이트 컨텍스트)를 받아 전체 SRO 점수와 권장사항을 반환합니다.",
      "• POST /api/serp — 주어진 키워드에 대해 Bright Data SERP API로 자연 검색 결과를 가져옵니다.",
      "• POST /api/site-context — 홈페이지를 스크랩하여 SRO 분석용 핵심 컨텍스트(메타 정보, 헤딩, 주요 구문)를 추출합니다.",
      "• POST /api/unlocker — Bright Data Web Unlocker로 단일 또는 다수 URL을 스크랩합니다. 단일 url 또는 배치 urls 모드를 지원합니다.",
      "• POST /api/brightdata-platforms — Bright Data 데이터셋 API로 현재 활성 AI 플랫폼(기본 4개)에서 브랜드 인용 여부를 폴링합니다.",
      "• POST /api/bulk-sro — 여러 키워드에 대한 SRO 분석을 한 번에 실행하는 SSE 스트리밍 엔드포인트.",
      "모든 경로는 입력 검증과 에러 처리를 포함하며, 대부분 API 비용 절감을 위해 인메모리 캐싱을 사용합니다.",
    ],
  },
  {
    id: "environment",
    title: "환경 설정",
    icon: "🔑",
    content: [
      "앱은 .env 파일에 3개의 API 키가 필요합니다:",
      "• BRIGHT_DATA_KEY — Bright Data API 토큰. 모든 AI 스크랩, SERP, Web Unlocker, 플랫폼 인용 기능에 사용됩니다.",
      "• OPENROUTER_KEY — OpenRouter API 키. LLM 추론(배틀카드, 니치 쿼리, SRO 최종 분석, 사이트 컨텍스트 추출)에 사용됩니다.",
      "• GEMINI_API_KEY — Google Gemini API 키. SRO 분석의 Gemini 그라운딩 단계에서 사용됩니다.",
      "추가로 AI Scraper 엔드포인트를 위해 6개 Bright Data 데이터셋 ID가 필요합니다:",
      "• BRIGHT_DATA_DATASET_CHATGPT, BRIGHT_DATA_DATASET_PERPLEXITY, BRIGHT_DATA_DATASET_COPILOT, BRIGHT_DATA_DATASET_GEMINI, BRIGHT_DATA_DATASET_GOOGLE_AI, BRIGHT_DATA_DATASET_GROK",
      "선택 zone 설정: BRIGHT_DATA_SERP_ZONE (기본값: serp_n8n), BRIGHT_DATA_UNLOCKER_ZONE (기본값: web_unlocker1).",
      ".env.example을 .env로 복사한 뒤 키를 채우면 시작할 수 있습니다.",
    ],
  },
];

export function DocumentationTab() {
  const [activeSection, setActiveSection] = useState("overview");
  const [search, setSearch] = useState("");

  const filteredSections = search.trim()
    ? sections.filter(
        (s) =>
          s.title.toLowerCase().includes(search.toLowerCase()) ||
          s.content.some((line) => line.toLowerCase().includes(search.toLowerCase())),
      )
    : sections;

  const current = sections.find((s) => s.id === activeSection);

  return (
    <div className="flex gap-4">
      {/* Sidebar TOC */}
      <div className="w-52 shrink-0">
        <div className="mb-3">
          <input
            type="text"
            placeholder="문서 검색…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bd-input w-full rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <nav className="space-y-0.5 max-h-[65vh] overflow-y-auto">
          {filteredSections.map((section) => (
            <button
              key={section.id}
              onClick={() => {
                setActiveSection(section.id);
                setSearch("");
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                activeSection === section.id
                  ? "bg-th-accent-soft text-th-text-accent font-medium"
                  : "text-th-text-secondary hover:bg-th-card-hover hover:text-th-text"
              }`}
            >
              <span className="text-sm">{section.icon}</span>
              <span className="truncate">{section.title}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {current ? (
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="text-2xl">{current.icon}</span>
              <h2 className="text-lg font-semibold text-th-text">{current.title}</h2>
            </div>
            <div className="space-y-3">
              {current.content.map((line, i) => {
                if (line.startsWith("• ")) {
                  return (
                    <div key={i} className="ml-4 flex items-start gap-2 text-sm text-th-text-secondary leading-relaxed">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-th-accent" />
                      <span>{line.slice(2)}</span>
                    </div>
                  );
                }
                return (
                  <p key={i} className="text-sm leading-relaxed text-th-text-secondary">
                    {line}
                  </p>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-th-text-muted">
            {search ? `No documentation matches "${search}".` : "Select a section from the sidebar."}
          </div>
        )}

        {/* Quick nav */}
        {current && (
          <div className="mt-6 flex items-center gap-2 border-t border-th-border pt-4">
            {(() => {
              const idx = sections.findIndex((s) => s.id === current.id);
              const prev = idx > 0 ? sections[idx - 1] : null;
              const next = idx < sections.length - 1 ? sections[idx + 1] : null;
              return (
                <>
                  {prev && (
                    <button
                      onClick={() => setActiveSection(prev.id)}
                      className="flex items-center gap-1.5 rounded-lg border border-th-border px-3 py-1.5 text-xs text-th-text-secondary hover:bg-th-card-hover transition-colors"
                    >
                      ← {prev.title}
                    </button>
                  )}
                  <div className="flex-1" />
                  {next && (
                    <button
                      onClick={() => setActiveSection(next.id)}
                      className="flex items-center gap-1.5 rounded-lg border border-th-border px-3 py-1.5 text-xs text-th-text-secondary hover:bg-th-card-hover transition-colors"
                    >
                      {next.title} →
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
