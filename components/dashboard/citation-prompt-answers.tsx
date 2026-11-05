/**
 * 「이 URL 을 인용한 질문」 한 줄을 펼쳤을 때 보이는 **AI 답변 목록** (2026-11-06 — 질문별 AI 답변 보기).
 *
 * - 답변 = 그 질문에 AI 가 답한 응답 중 이 주소를 인용한 응답(질문 줄의 「N회」와 같은 판정) · 최신순.
 * - 답변 기간은 탭 상단 기간과 별개(기본 최근 7일 · 30·90일·전체·직접 선택). AI 모델·자동조사/브랜드 보기는 탭 상단을 따른다.
 * - 각 답변은 AI 응답 탭과 같은 카드(ModelResponseCard)로 보인다(삭제 버튼 없음).
 * - 한 번에 10개 · 「답변 더 보기」. 기간을 바꾸거나 닫으면 진행 중 요청을 끊고, 늦게 온 이전 결과는 버린다(요청 세대).
 * 휴대폰 폭에서 버튼·라벨 글자가 끊기지 않게 줄바꿈 금지 + 묶음 단위로 넘긴다(citation-filter-bar.tsx 와 같은 규칙).
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKstDateKey } from "@/lib/client/date-kst";
import { scrapeRunFromServer, type ServerRun } from "@/lib/client/server-store";
import { promptQueryParam } from "@/lib/client/prompt-hash";
import { validateCustomRange } from "@/components/dashboard/range-selector";
import {
  CITATION_PRESET_OPTIONS,
  DEFAULT_ANSWER_PERIOD,
  citationAnswerParams,
  describeCitationAnswerPeriod,
  shiftDateKey,
  type CitationAnswerPeriod,
} from "@/components/dashboard/citation-filters";
import { ModelResponseCard } from "@/components/dashboard/tabs/reputation-sources-tab";
import { PROVIDER_LABELS, type Provider, type ScrapeRun } from "@/components/dashboard/types";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 한 번에 불러오는 답변 수 */
export const ANSWER_PAGE_SIZE = 10;

type AnswersResponse = {
  answerCount: number;
  providerCounts: Array<{ provider: string; count: number }>;
  lastAnswerAt: string | null;
  capped: boolean;
  runs: ServerRun[];
  nextCursor: string | null;
};

const btn = (active: boolean) =>
  `shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
    active ? "bg-th-accent text-th-text-inverse shadow-sm" : "text-th-text-secondary hover:bg-th-card-hover"
  }`;

function providerLabel(p: string): string {
  return PROVIDER_LABELS[p as Provider] ?? p;
}

export function PromptAnswers({
  workspaceId,
  pathSeg,
  canonicalUrlKey,
  promptText,
  auto,
  branded,
  tabProvider,
  lastSeen,
  brandTerms,
  competitorTerms,
}: {
  workspaceId: string;
  pathSeg: "urls" | "brand-mentions";
  canonicalUrlKey: string;
  promptText: string;
  auto: boolean;
  branded: boolean;
  /** 탭 상단에서 고른 AI 모델 — 없으면 전체 */
  tabProvider?: string;
  /** 질문 줄의 마지막 인용 시각(탭 상단 기간 기준) — 답변이 없을 때 안내에 쓴다 */
  lastSeen: string;
  brandTerms: string[];
  competitorTerms: string[];
}) {
  const todayKst = toKstDateKey(new Date());
  const [period, setPeriod] = useState<CitationAnswerPeriod>(DEFAULT_ANSWER_PERIOD);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(() => shiftDateKey(todayKst, -29));
  const [draftTo, setDraftTo] = useState(todayKst);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const [runs, setRuns] = useState<ScrapeRun[]>([]);
  const [meta, setMeta] = useState<Omit<AnswersResponse, "runs" | "nextCursor"> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 요청 세대 — 기간이 바뀌면 +1. 늦게 도착한 이전 조건의 결과가 새 목록을 덮어쓰지 않게 한다 */
  const genRef = useRef(0);

  const params = useMemo(
    () => citationAnswerParams(period, tabProvider, todayKst),
    [period, tabProvider, todayKst],
  );
  const paramsKey = JSON.stringify(params);
  const periodLabel = describeCitationAnswerPeriod(period, tabProvider, todayKst);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean, gen: number, signal?: AbortSignal) => {
      // 질문은 해시로 보낸다 — 긴 질문도 주소창 길이 한도에 걸리지 않게 (검수 A-C3)
      const promptParam = await promptQueryParam(promptText);
      const qs = new URLSearchParams({
        canonicalUrlKey,
        ...promptParam,
        auto: String(auto),
        branded: String(branded),
        pageSize: String(ANSWER_PAGE_SIZE),
        ...params,
      });
      if (cursor) qs.set("cursor", cursor);
      const resp = await fetch(
        `${BP}/api/workspaces/${workspaceId}/stats/citations/${pathSeg}/answers?${qs.toString()}`,
        { credentials: "include", signal },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as AnswersResponse;
      if (gen !== genRef.current) return;
      const fresh = data.runs.map((r) => scrapeRunFromServer(r));
      setRuns((prev) => {
        if (!append) return fresh;
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...fresh.filter((r) => !seen.has(r.id))];
      });
      setMeta({
        answerCount: data.answerCount,
        providerCounts: data.providerCounts,
        lastAnswerAt: data.lastAnswerAt,
        capped: data.capped,
      });
      setNextCursor(data.nextCursor);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey 가 params 를 대표한다
    [workspaceId, pathSeg, canonicalUrlKey, promptText, auto, branded, paramsKey],
  );

  // 처음 펼칠 때 + 답변 기간이 바뀔 때 첫 쪽을 새로 받는다. 이전 요청은 끊고 결과도 버린다.
  useEffect(() => {
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setRuns([]);
    setMeta(null);
    setNextCursor(null);
    fetchPage(null, false, gen, ctrl.signal)
      .catch((e) => {
        if (gen === genRef.current && !ctrl.signal.aborted) setError(e instanceof Error ? e.message : "불러오기 실패");
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const gen = genRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      await fetchPage(nextCursor, true, gen);
    } catch (e) {
      if (gen === genRef.current) setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      if (gen === genRef.current) setLoadingMore(false);
    }
  }, [nextCursor, fetchPage]);

  function choosePreset(preset: CitationAnswerPeriod["preset"]) {
    setPanelOpen(false);
    setRangeError(null);
    setPeriod({ preset, custom: null });
  }

  function applyCustom() {
    const msg = validateCustomRange(draftFrom, draftTo, todayKst);
    if (msg) {
      setRangeError(msg);
      return;
    }
    setRangeError(null);
    setPanelOpen(false);
    setPeriod({ preset: "custom", custom: { from: draftFrom, to: draftTo } });
  }

  const empty = !loading && !error && meta !== null && runs.length === 0;

  return (
    <div className="mt-2 space-y-2 border-t border-th-border pt-2">
      {/* 답변 기간 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="shrink-0 whitespace-nowrap text-[11px] font-medium text-th-text-muted">답변 기간:</span>
        <div className="flex flex-wrap gap-0.5 rounded-lg border border-th-border bg-th-card p-0.5">
          {CITATION_PRESET_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => choosePreset(o.value)}
              className={btn(period.preset === o.value)}
              aria-pressed={period.preset === o.value}
            >
              {o.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              const opening = !panelOpen;
              if (opening && period.custom) {
                setDraftFrom(period.custom.from);
                setDraftTo(period.custom.to);
              }
              setPanelOpen(opening);
            }}
            className={btn(period.preset === "custom")}
            aria-pressed={period.preset === "custom"}
            aria-expanded={panelOpen}
          >
            직접 선택
          </button>
        </div>
      </div>

      {panelOpen && (
        <div className="flex flex-col gap-2 rounded-lg border border-th-border bg-th-card p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-th-text-secondary">
              <span>시작일</span>
              <input
                type="date"
                value={draftFrom}
                max={todayKst}
                onChange={(e) => {
                  setDraftFrom(e.target.value);
                  setRangeError(null);
                }}
                className="rounded-md border border-th-border bg-th-card-alt px-2 py-1 text-xs text-th-text"
              />
            </label>
            <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-th-text-secondary">
              <span>종료일</span>
              <input
                type="date"
                value={draftTo}
                max={todayKst}
                onChange={(e) => {
                  setDraftTo(e.target.value);
                  setRangeError(null);
                }}
                className="rounded-md border border-th-border bg-th-card-alt px-2 py-1 text-xs text-th-text"
              />
            </label>
            <button
              type="button"
              onClick={applyCustom}
              className="whitespace-nowrap rounded-md bg-th-accent px-3 py-1 text-[11px] font-medium text-th-text-inverse"
            >
              적용
            </button>
          </div>
          {rangeError && (
            <div role="alert" className="text-[11px] text-th-danger">
              {rangeError}
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] text-th-text-muted">
        보는 범위: {periodLabel} · 이 질문에 AI가 답하면서 이 주소를 인용한 답변을 최근 것부터 보여 줍니다.
      </p>

      {meta && meta.answerCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-th-text-secondary">
          <span className="whitespace-nowrap font-semibold text-th-text">이 기간 답변 {meta.answerCount}개</span>
          {meta.providerCounts.map((pc) => (
            <span key={pc.provider} className="whitespace-nowrap text-th-text-muted">
              {providerLabel(pc.provider)} {pc.count}
            </span>
          ))}
        </div>
      )}

      {meta?.capped && (
        <div className="rounded-md border border-th-border bg-th-card px-2.5 py-1.5 text-[11px] text-th-text-muted">
          기록이 많아 최근 인용부터 일부만 찾았습니다. 오래된 답변은 빠졌을 수 있습니다.
        </div>
      )}

      {loading && <div className="py-3 text-center text-xs text-th-text-muted">답변을 불러오는 중…</div>}
      {error && !loading && (
        <div className="rounded-md border border-th-danger/30 bg-th-danger-soft px-2.5 py-1.5 text-[11px] text-th-danger">
          답변을 불러오지 못했습니다: {error}
        </div>
      )}
      {empty && (
        <div className="rounded-md border border-th-border bg-th-card px-2.5 py-3 text-[11px] text-th-text-secondary">
          이 기간에는 이 질문에서 이 주소를 인용한 답변이 없습니다.
          {lastSeen ? ` 마지막으로 인용된 날은 ${toKstDateKey(lastSeen)}입니다.` : ""}
          {period.preset !== "all" && " 답변 기간을 넓혀 보세요."}
        </div>
      )}

      {runs.length > 0 && (
        <div className="space-y-2">
          {runs.map((run) => (
            <ModelResponseCard
              key={run.id}
              run={run}
              brandTerms={brandTerms}
              competitorTerms={competitorTerms}
              wrapHeader
            />
          ))}
        </div>
      )}

      {nextCursor && !loading && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="whitespace-nowrap rounded-md border border-th-border bg-th-card px-3 py-1 text-[11px] text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
          >
            {loadingMore ? "불러오는 중…" : "답변 더 보기"}
          </button>
        </div>
      )}
    </div>
  );
}
