import { useMemo, useState } from "react";
import type { ScrapeRun } from "@/components/dashboard/types";
import { VISIBLE_PROVIDERS, PROVIDER_LABELS, type Provider } from "@/components/dashboard/types";
import type { RunDelta } from "@/components/dashboard/types";
import { splitAnswerSections } from "@/components/dashboard/answer-utils";
import { isRelatedCitation, isUrlMatchingCitedKeys } from "@/components/dashboard/citation-utils";

type ReputationSourcesTabProps = {
  runs: ScrapeRun[];
  brandTerms: string[];
  competitorTerms: string[];
  runDeltas?: RunDelta[];
  onDeleteRun?: (index: number) => void;
  onResetManualResponses?: () => void;
};

function normalizeAnswerForDisplay(answer: string): string {
  let text = answer;

  // If the answer looks like raw JSON, try to extract the text content
  if (/^\s*[{\[]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      const extract = (obj: unknown): string => {
        if (typeof obj === "string") return obj;
        if (Array.isArray(obj)) return obj.map(extract).filter(Boolean).join("\n\n");
        if (obj && typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          for (const key of ["answer", "response", "output", "text", "content", "message", "body"]) {
            if (typeof rec[key] === "string" && (rec[key] as string).trim()) return (rec[key] as string).trim();
          }
          return Object.values(rec).map(extract).filter(Boolean).join("\n\n");
        }
        return String(obj ?? "");
      };
      const extracted = extract(parsed);
      if (extracted.trim().length > 20) text = extracted;
    } catch {
      // Strip JSON structural characters as fallback
      text = text
        .replace(/[{}\[\]"]/g, " ")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, " ");
    }
  }

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Highlight brand and competitor mentions in text */
function HighlightedText({
  text,
  brandTerms,
  competitorTerms,
}: {
  text: string;
  brandTerms: string[];
  competitorTerms: string[];
}) {
  if (brandTerms.length === 0 && competitorTerms.length === 0) {
    return <span>{text}</span>;
  }

  const allTerms = [
    ...brandTerms.map((t) => ({ term: t, type: "brand" as const })),
    ...competitorTerms.map((t) => ({ term: t, type: "competitor" as const })),
  ].sort((a, b) => b.term.length - a.term.length);

  const escaped = allTerms.map((t) => ({
    ...t,
    pattern: t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  }));

  const regex = new RegExp(
    `(${escaped.map((t) => t.pattern).join("|")})`,
    "gi",
  );

  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) => {
        const match = allTerms.find(
          (t) => t.term.toLowerCase() === part.toLowerCase(),
        );
        if (match) {
          return (
            <mark
              key={i}
              className={
                match.type === "brand"
                  ? "rounded-sm bg-th-brand-bg px-0.5 font-medium text-th-brand-text"
                  : "rounded-sm bg-th-competitor-bg px-0.5 font-medium text-th-competitor-text"
              }
              title={match.type === "brand" ? "내 브랜드" : "경쟁사"}
            >
              {part}
            </mark>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const colors: Record<string, string> = {
    positive: "bg-th-success-soft text-th-success border-th-success/30",
    neutral: "bg-th-accent-soft text-th-text-accent border-th-accent/30",
    negative: "bg-th-danger-soft text-th-danger border-th-danger/30",
    "not-mentioned": "bg-th-card-alt text-th-text-muted border-th-border",
  };
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium uppercase ${colors[sentiment] ?? colors["neutral"]}`}
    >
      {sentiment}
    </span>
  );
}

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#1ba1e3",
  copilot: "#7c5bbf",
  gemini: "#4285f4",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

function ProviderBadge({ provider }: { provider: Provider }) {
  const bg = PROVIDER_COLORS[provider] ?? "#4285f4";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: bg + "22", color: bg, border: `1px solid ${bg}44` }}
    >
      {PROVIDER_LABELS[provider] ?? provider}
    </span>
  );
}

function ModelResponseCard({
  run,
  brandTerms,
  competitorTerms,
  delta,
  onDelete,
}: {
  run: ScrapeRun;
  brandTerms: string[];
  competitorTerms: string[];
  delta?: number | null;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rawDisplay = normalizeAnswerForDisplay(run.answer ?? "");
  // Filter out garbage: answers that just echo the prompt or are just a URL
  const isGarbage =
    !rawDisplay ||
    rawDisplay.toLowerCase().trim() === run.prompt.toLowerCase().trim() ||
    /^https?:\/\/\S+$/i.test(rawDisplay.trim());
  const display = isGarbage ? "" : rawDisplay;
  // 메인 본문 vs 부가 콘텐츠(관련 동영상/추천) 분리 — UI 표시용
  const { main: mainDisplay, attached: attachedDisplay } = splitAnswerSections(display);
  const previewBase = mainDisplay || display;
  const preview = previewBase.length > 300 ? previewBase.slice(0, 300) + "…" : previewBase;
  const uniqueSources = [...new Set(run.sources)];
  // 구조화된 citations 있으면 우선 사용 (title/domain 포함)
  const citationList = run.citations ?? [];
  const citationByUrl = new Map(citationList.map((c) => [c.url, c]));

  // 3종 브랜드 신호 (① AI 본문 인용 / ② 공식 출처 / ③ 연관 출처)
  const mainAliases = [...new Set(run.brandMentions ?? [])];
  const citedDomains = [...new Set(run.citedBrandDomains ?? [])];
  // 연관 출처: URL이 공식과 매칭되진 않지만 제목/설명에 브랜드명이 포함된 인용
  const relatedCitationUrls = citationList
    .filter(
      (c) =>
        !isUrlMatchingCitedKeys(c.url, citedDomains) &&
        isRelatedCitation(c, brandTerms),
    )
    .map((c) => c.url);
  const hasMainMention = mainAliases.length > 0;
  const hasCitedBrand = citedDomains.length > 0;
  const hasRelatedCitation = relatedCitationUrls.length > 0;
  const hasAnyBrandSignal = hasMainMention || hasCitedBrand || hasRelatedCitation;

  return (
    <div
      className={
        hasMainMention
          ? "group relative rounded-lg border-2 border-th-success/60 bg-th-card shadow-[0_0_0_1px_rgba(34,197,94,0.18)]"
          : hasAnyBrandSignal
            ? "group relative rounded-lg border border-th-brand-bg/40 bg-th-card"
            : "group relative rounded-lg border border-th-border bg-th-card"
      }
    >
      {hasAnyBrandSignal && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-th-brand-bg/30 bg-th-brand-bg/5 px-4 py-1.5 text-xs">
          {hasMainMention && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-th-success/50 bg-th-success-soft px-2 py-0.5 font-semibold text-th-success"
              title="AI가 본문 답변 내에서 브랜드를 직접 인용/언급"
            >
              <span aria-hidden="true">🎯</span>
              AI 본문 인용
              {mainAliases.length > 0 && (
                <span className="font-normal opacity-80">
                  · {mainAliases.slice(0, 3).join(", ")}
                  {mainAliases.length > 3 ? ` 외 ${mainAliases.length - 3}` : ""}
                </span>
              )}
            </span>
          )}
          {hasCitedBrand && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-th-brand-bg/50 bg-th-brand-bg/20 px-2 py-0.5 font-semibold text-th-brand-text"
              title="AI 답변의 인용 출처 URL이 브랜드 공식 채널과 일치"
            >
              <span aria-hidden="true">📍</span>
              공식 출처
              <span className="font-normal opacity-80">
                · {citedDomains.slice(0, 2).join(", ")}
                {citedDomains.length > 2 ? ` 외 ${citedDomains.length - 2}` : ""}
              </span>
            </span>
          )}
          {hasRelatedCitation && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-th-border bg-th-card-alt px-2 py-0.5 font-medium text-th-text-secondary"
              title="공식 URL은 아니지만 인용 출처의 제목/설명에 브랜드명이 포함됨 (제3자 언급)"
            >
              <span aria-hidden="true">🏷️</span>
              연관 출처
              <span className="font-normal opacity-80">
                · {relatedCitationUrls.length}건
              </span>
            </span>
          )}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center hover:bg-th-card-hover rounded-t-lg">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-3 px-4 py-3 text-left"
        >
          <ProviderBadge provider={run.provider} />
          <div className="flex flex-1 items-center gap-3">
            <span className="text-xs text-th-text-muted">
              점수: <span className="font-semibold text-th-text">{run.visibilityScore}</span>/100
            </span>
            {delta != null && delta !== 0 && (
              <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
                delta > 0 ? "bg-th-success-soft text-th-success" : "bg-th-danger-soft text-th-danger"
              }`}>
                {delta > 0 ? "↑" : "↓"}{Math.abs(delta)}
              </span>
            )}
            <SentimentBadge sentiment={run.sentiment ?? "neutral"} />
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                run.auto
                  ? "bg-th-accent-soft text-th-text-accent"
                  : "bg-th-card-alt text-th-text-muted"
              }`}
              title={run.auto ? "스케줄러에 의한 자동 실행" : "사용자가 직접 실행"}
            >
              {run.auto ? "자동" : "수동"}
            </span>
            {uniqueSources.length > 0 && (
              <span className="text-xs text-th-text-muted">
                출처 {uniqueSources.length}개
              </span>
            )}
          </div>
          <span className="text-xs text-th-text-muted">{run.createdAt.slice(0, 10)}</span>
        </button>
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm("이 응답을 삭제할까요? 되돌릴 수 없습니다.")) onDelete();
            }}
            className="shrink-0 rounded p-1.5 text-th-text-muted opacity-0 transition-opacity hover:bg-th-danger-soft hover:text-th-danger group-hover:opacity-100"
            title="이 응답 삭제"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 px-3 py-3 text-xs text-th-text-muted"
        >
          {expanded ? "▲" : "▼"}
        </button>
      </div>

      {/* Preview when collapsed */}
      {!expanded && (
        <div className="border-t border-th-border/40 px-4 py-2.5 text-sm leading-relaxed text-th-text-secondary">
          {preview ? (
            <HighlightedText
              text={preview}
              brandTerms={brandTerms}
              competitorTerms={competitorTerms}
            />
          ) : (
            <span className="italic text-th-text-muted">응답 텍스트가 캡처되지 않았습니다 — 이 프롬프트를 재실행해 보세요.</span>
          )}
        </div>
      )}

      {/* Full content when expanded */}
      {expanded && (
        <div className="space-y-3 border-t border-th-border px-4 py-3">
          {/* 실제 전송된 프롬프트 (편향 검증용) */}
          {run.sentPrompt && run.sentPrompt !== run.prompt && (
            <details className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-th-text-muted">
                실제 전송 프롬프트 (brandCtx 주입됨)
              </summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs text-th-text-secondary">
                {run.sentPrompt}
              </pre>
            </details>
          )}
          {run.sentPrompt && run.sentPrompt === run.prompt && (
            <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-1.5 text-xs text-th-text-muted">
              ✓ 전송 프롬프트는 원본과 동일 (brandCtx 미주입 — 편향 없음)
            </div>
          )}

          {/* Highlight legend */}
          {(brandTerms.length > 0 || competitorTerms.length > 0) && (
            <div className="flex items-center gap-3 text-xs text-th-text-muted">
              {brandTerms.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-th-brand-bg" />
                  브랜드
                </span>
              )}
              {competitorTerms.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-th-competitor-bg" />
                  경쟁사
                </span>
              )}
            </div>
          )}

          <div className="max-h-[400px] overflow-auto whitespace-pre-wrap break-words pr-1 text-sm leading-7 text-th-text">
            {display ? (
              <HighlightedText
                text={mainDisplay || display}
                brandTerms={brandTerms}
                competitorTerms={competitorTerms}
              />
            ) : (
              <span className="italic text-th-text-muted">이 AI 모델에서 응답 텍스트를 캡처하지 못했습니다. 프롬프트를 재실행하여 새 데이터를 받아보세요.</span>
            )}
          </div>

          {attachedDisplay && (
            <details className="group/attached rounded-lg border border-th-border bg-th-card-alt/50">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-th-text-muted hover:bg-th-card-hover">
                <span className="inline-block transition-transform group-open/attached:rotate-90">▶</span>
                <span aria-hidden="true">📺</span>
                <span className="uppercase tracking-wider">관련 콘텐츠 (부가 섹션)</span>
                <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-th-text-muted">
                  AI 본문 밖 · 스코어 미반영
                </span>
              </summary>
              <div className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words border-t border-th-border px-3 py-2 text-xs leading-6 text-th-text-secondary">
                <HighlightedText
                  text={attachedDisplay}
                  brandTerms={brandTerms}
                  competitorTerms={competitorTerms}
                />
              </div>
            </details>
          )}

          {uniqueSources.length > 0 && (
            <details className="group/cite rounded-lg border border-th-border bg-th-card-alt/30">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium uppercase tracking-wider text-th-text-muted hover:bg-th-card-hover">
                <span className="inline-block transition-transform group-open/cite:rotate-90">▶</span>
                <span>인용된 출처</span>
                <span className="rounded-full bg-th-card-alt px-2 py-0.5 font-semibold normal-case tracking-normal text-th-text-secondary">
                  {uniqueSources.length}개
                </span>
              </summary>
              <div className="space-y-1.5 px-3 pb-3 pt-1">
                {uniqueSources.map((source) => {
                  const cite = citationByUrl.get(source);
                  const domain = (() => {
                    if (cite?.domain) return cite.domain;
                    try {
                      return new URL(source).hostname.replace(/^www\./, "");
                    } catch {
                      return source;
                    }
                  })();
                  // 공식 출처: URL이 브랜드 공식 채널과 일치
                  // 연관 출처: URL은 매칭 안 되지만 제목/설명에 브랜드명 포함 (공식 우선)
                  const isBrandCitation = isUrlMatchingCitedKeys(source, citedDomains);
                  const isRelated =
                    !isBrandCitation && isRelatedCitation(cite, brandTerms);
                  const citationState: "official" | "related" | "none" = isBrandCitation
                    ? "official"
                    : isRelated
                      ? "related"
                      : "none";
                  const cardClass =
                    citationState === "official"
                      ? "block rounded-md border-2 border-th-success/50 bg-th-success-soft px-3 py-2 hover:bg-th-success-soft/70"
                      : citationState === "related"
                        ? "block rounded-md border border-th-brand-bg/40 bg-th-brand-bg/5 px-3 py-2 hover:bg-th-brand-bg/10"
                        : "block rounded-md border border-th-border bg-th-card-alt px-3 py-2 hover:bg-th-card-hover";
                  const titleAttr =
                    citationState === "official"
                      ? `브랜드 공식 출처로 인용됨 · ${source}`
                      : citationState === "related"
                        ? `제목/설명에 브랜드명 포함 (공식 URL 아님) · ${source}`
                        : source;
                  const Badge =
                    citationState === "official" ? (
                      <span
                        className="mt-0.5 rounded-full bg-th-brand-bg/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-th-brand-text"
                        aria-label="브랜드 공식 출처"
                      >
                        📍 공식
                      </span>
                    ) : citationState === "related" ? (
                      <span
                        className="mt-0.5 rounded-full bg-th-brand-bg/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-th-brand-text"
                        aria-label="연관 출처 (제3자 언급)"
                      >
                        🏷️ 연관
                      </span>
                    ) : null;
                  const domainTextClass =
                    citationState === "official"
                      ? "text-th-brand-text"
                      : citationState === "related"
                        ? "text-th-text-secondary"
                        : "text-th-text-accent";
                  return (
                    <a
                      key={source}
                      href={source}
                      target="_blank"
                      rel="noreferrer"
                      className={cardClass}
                      title={titleAttr}
                    >
                      {cite?.title ? (
                        <div className="flex items-start gap-1.5">
                          {Badge}
                          <div className="truncate text-sm font-medium text-th-text">
                            {cite.title}
                          </div>
                        </div>
                      ) : null}
                      <div className={`flex items-center gap-1.5 text-xs ${domainTextClass}`}>
                        {!cite?.title && Badge}
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                        </svg>
                        <span className="truncate">{domain}</span>
                      </div>
                      {cite?.description ? (
                        <div className="mt-1 line-clamp-2 text-xs text-th-text-secondary">
                          {cite.description}
                        </div>
                      ) : null}
                    </a>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function ReputationSourcesTab({
  runs,
  brandTerms,
  competitorTerms,
  runDeltas = [],
  onDeleteRun,
  onResetManualResponses,
}: ReputationSourcesTabProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [filterProvider, setFilterProvider] = useState<Provider | "all">("all");
  const [filterSentiment, setFilterSentiment] = useState<string>("all");
  const [filterOrigin, setFilterOrigin] = useState<"auto" | "manual">("auto");
  const [sortField, setSortField] = useState<"date" | "score">("date");

  // Apply filters
  const filteredRuns = useMemo(() => {
    let list = [...runs];
    if (filterOrigin === "auto") list = list.filter((r) => r.auto === true);
    else list = list.filter((r) => r.auto !== true);
    if (filterProvider !== "all") list = list.filter((r) => r.provider === filterProvider);
    if (filterSentiment !== "all") list = list.filter((r) => r.sentiment === filterSentiment);
    return list;
  }, [runs, filterProvider, filterSentiment, filterOrigin]);

  // Group runs by prompt
  const promptGroups = useMemo(() => {
    const m = new Map<string, ScrapeRun[]>();
    filteredRuns.forEach((run) => {
      const key = run.prompt;
      const group = m.get(key) ?? [];
      group.push(run);
      m.set(key, group);
    });
    const groups = [...m.entries()]
      .map(([prompt, groupRuns]) => ({
        prompt,
        runs: groupRuns.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      }));

    if (sortField === "score") {
      return groups.sort((a, b) => {
        const aAvg = a.runs.reduce((s, r) => s + (r.visibilityScore ?? 0), 0) / a.runs.length;
        const bAvg = b.runs.reduce((s, r) => s + (r.visibilityScore ?? 0), 0) / b.runs.length;
        return bAvg - aAvg;
      });
    }

    return groups.sort((a, b) => {
      const aLatest = new Date(a.runs[0].createdAt).getTime();
      const bLatest = new Date(b.runs[0].createdAt).getTime();
      return bLatest - aLatest;
    });
  }, [filteredRuns, sortField]);

  // Insight stats — filteredRuns 기준 (자동/수동 탭 반영)
  const insights = useMemo(() => {
    if (filteredRuns.length === 0) return null;
    const avgScore = Math.round(filteredRuns.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / filteredRuns.length);
    const sentiments = { positive: 0, neutral: 0, negative: 0, "not-mentioned": 0 };
    const providerCounts: Partial<Record<Provider, number>> = {};
    const providerScores: Partial<Record<Provider, number[]>> = {};
    let brandMentioned = 0;
    let totalSources = 0;

    filteredRuns.forEach((r) => {
      sentiments[r.sentiment as keyof typeof sentiments] = (sentiments[r.sentiment as keyof typeof sentiments] ?? 0) + 1;
      providerCounts[r.provider] = (providerCounts[r.provider] ?? 0) + 1;
      if (!providerScores[r.provider]) providerScores[r.provider] = [];
      providerScores[r.provider]!.push(r.visibilityScore ?? 0);
      if ((r.brandMentions?.length ?? 0) > 0) brandMentioned++;
      totalSources += r.sources.length;
    });

    const providerAvgs = Object.entries(providerScores).map(([p, scores]) => ({
      provider: p as Provider,
      avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      count: scores.length,
    })).sort((a, b) => b.avg - a.avg);

    return { avgScore, sentiments, providerAvgs, brandMentioned, totalSources };
  }, [runs]);

  // Auto-expand first group
  const isGroupOpen = (prompt: string, idx: number) => {
    return expandedGroups[prompt] ?? idx === 0;
  };

  // Build a lookup map of deltas by prompt+provider
  const deltaMap = useMemo(() => {
    const m = new Map<string, number>();
    runDeltas.forEach((d) => m.set(`${d.prompt}|||${d.provider}`, d.delta));
    return m;
  }, [runDeltas]);

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-th-accent-soft">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-th-text-accent">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M8 9h8M8 13h6" />
          </svg>
        </div>
        <p className="text-sm font-medium text-th-text">아직 모델 응답이 없습니다</p>
        <p className="mt-1 text-sm text-th-text-secondary">프롬프트를 실행하여 AI 모델 전반의 브랜드 분석을 확인하세요.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* ── 자동/수동 탭 ── */}
      <div className="flex gap-0.5 rounded-lg border border-th-border bg-th-card-alt p-1">
        <button
          onClick={() => setFilterOrigin("auto")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            filterOrigin === "auto"
              ? "bg-th-accent text-th-text-inverse shadow-sm"
              : "text-th-text-secondary hover:bg-th-card-hover"
          }`}
        >
          자동 응답
        </button>
        <button
          onClick={() => setFilterOrigin("manual")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            filterOrigin === "manual"
              ? "bg-th-accent text-th-text-inverse shadow-sm"
              : "text-th-text-secondary hover:bg-th-card-hover"
          }`}
        >
          수동 응답
        </button>
      </div>

      {/* ── Insight cards ── */}
      {insights && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <InsightMini label="평균 점수" value={`${insights.avgScore}/100`} accent />
          <InsightMini label="브랜드 언급" value={`${insights.brandMentioned}/${filteredRuns.length}`} />
          <InsightMini
            label="긍정"
            value={insights.sentiments.positive}
            sub={`${Math.round((insights.sentiments.positive / (filteredRuns.length || 1)) * 100)}%`}
            color="text-th-success"
          />
          <InsightMini
            label="중립"
            value={insights.sentiments.neutral}
            sub={`${Math.round((insights.sentiments.neutral / (filteredRuns.length || 1)) * 100)}%`}
            color="text-th-text-accent"
          />
          <InsightMini
            label="부정"
            value={insights.sentiments.negative}
            sub={`${Math.round((insights.sentiments.negative / (filteredRuns.length || 1)) * 100)}%`}
            color="text-th-danger"
          />
          <InsightMini label="인용 출처" value={insights.totalSources} />
          <InsightMini label="사용 모델" value={insights.providerAvgs.length} />
        </div>
      )}

      {/* ── Per-model breakdown ── */}
      {insights && insights.providerAvgs.length > 1 && (
        <div className="rounded-xl border border-th-border bg-th-card p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
            모델별 점수
          </div>
          <div className="flex flex-wrap gap-2">
            {insights.providerAvgs.map(({ provider, avg, count }) => (
              <div
                key={provider}
                className="flex items-center gap-2 rounded-lg border border-th-border bg-th-card-alt px-3 py-1.5"
              >
                <ProviderBadge provider={provider} />
                <span className="text-sm font-semibold text-th-text">{avg}</span>
                <span className="text-xs text-th-text-muted">/ 100</span>
                <span className="text-xs text-th-text-muted">({count})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Filter / sort toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-th-border bg-th-card px-3 py-2.5">
        <span className="text-xs font-medium text-th-text-muted">필터:</span>

        {/* Provider filter */}
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value as Provider | "all")}
          className="bd-input rounded-lg px-2.5 py-1.5 text-xs"
        >
          <option value="all">모든 모델</option>
          {VISIBLE_PROVIDERS.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>

        {/* Sentiment filter */}
        <select
          value={filterSentiment}
          onChange={(e) => setFilterSentiment(e.target.value)}
          className="bd-input rounded-lg px-2.5 py-1.5 text-xs"
        >
          <option value="all">모든 감성</option>
          <option value="positive">긍정</option>
          <option value="neutral">중립</option>
          <option value="negative">부정</option>
          <option value="not-mentioned">미언급</option>
        </select>

        {/* Sort */}
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as "date" | "score")}
          className="bd-input rounded-lg px-2.5 py-1.5 text-xs"
        >
          <option value="date">정렬: 최신순</option>
          <option value="score">정렬: 점수순</option>
        </select>

        <span className="ml-auto text-xs text-th-text-muted">
          <span className="font-semibold text-th-text">{filteredRuns.length}</span> responses across{" "}
          <span className="font-semibold text-th-text">{promptGroups.length}</span> prompt{promptGroups.length > 1 ? "s" : ""}
        </span>
        {onResetManualResponses && filterOrigin === "manual" && runs.some((r) => r.auto !== true) && (
          <button
            type="button"
            onClick={onResetManualResponses}
            className="shrink-0 rounded-md border border-th-border bg-th-card-alt px-3 py-1.5 text-xs text-th-text-muted hover:bg-th-card-hover hover:text-th-text"
            title="수동으로 실행한 응답 이력만 삭제 (자동 실행 이력은 유지)"
          >
            수동 응답 삭제
          </button>
        )}
      </div>

      {/* ── Prompt groups ── */}
      <div className="space-y-2">
        {promptGroups.map(({ prompt, runs: groupRuns }, groupIdx) => {
          const open = isGroupOpen(prompt, groupIdx);
          const avgScore = Math.round(
            groupRuns.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / groupRuns.length,
          );
          const providers = [...new Set(groupRuns.map((r) => r.provider))];
          const scoreColor =
            avgScore >= 60 ? "text-th-success" : avgScore >= 30 ? "text-th-text-accent" : "text-th-danger";

          // Compute group-level average delta
          const groupDeltas = groupRuns
            .map((r) => deltaMap.get(`${r.prompt}|||${r.provider}`))
            .filter((d): d is number => d != null);
          const avgDelta = groupDeltas.length > 0
            ? Math.round(groupDeltas.reduce((a, b) => a + b, 0) / groupDeltas.length)
            : null;

          return (
            <div key={prompt} className="rounded-xl border border-th-border bg-th-card-alt">
              {/* Prompt header */}
              <button
                onClick={() =>
                  setExpandedGroups((prev) => ({ ...prev, [prompt]: !open }))
                }
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-th-card-hover transition-colors rounded-t-xl"
              >
                <span className="mt-0.5 text-xs text-th-text-muted">{open ? "▼" : "▶"}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug text-th-text">
                    {prompt.length > 120 ? prompt.slice(0, 117) + "…" : prompt}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {providers.map((p) => (
                      <ProviderBadge key={p} provider={p} />
                    ))}
                    <span className="text-xs text-th-text-muted">
                      {groupRuns.length} response{groupRuns.length > 1 ? "s" : ""}
                    </span>
                    <span className="text-xs text-th-text-muted">·</span>
                    <span className={`text-xs font-semibold ${scoreColor}`}>
                      Avg: {avgScore}/100
                    </span>
                    {avgDelta != null && avgDelta !== 0 && (
                      <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
                        avgDelta > 0 ? "bg-th-success-soft text-th-success" : "bg-th-danger-soft text-th-danger"
                      }`}>
                        {avgDelta > 0 ? "↑" : "↓"}{Math.abs(avgDelta)}
                      </span>
                    )}
                  </div>
                </div>
              </button>

              {/* Model cards */}
              {open && (
                <div className="space-y-2 border-t border-th-border p-3">
                  {groupRuns.map((run, i) => (
                    <ModelResponseCard
                      key={`${run.provider}-${run.createdAt}-${i}`}
                      run={run}
                      brandTerms={brandTerms}
                      competitorTerms={competitorTerms}
                      delta={deltaMap.get(`${run.prompt}|||${run.provider}`) ?? null}
                      onDelete={onDeleteRun ? () => {
                        const origIdx = runs.indexOf(run);
                        if (origIdx !== -1) onDeleteRun(origIdx);
                      } : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Insight Mini Card ── */
function InsightMini({
  label,
  value,
  sub,
  accent,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  color?: string;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${accent ? "border-th-accent/30 bg-th-accent-soft" : "border-th-border bg-th-card"}`}>
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold ${color ?? "text-th-text"}`}>
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-th-text-muted">{sub}</span>}
      </div>
    </div>
  );
}
