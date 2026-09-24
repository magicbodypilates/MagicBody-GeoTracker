"use client";

/**
 * response-archive-panel.tsx — AI 응답 탭의 「보관함」 (계획 geotracker-response-archive-260924 §5-2).
 *
 *   ① 아직 정리하지 않은 질문 — 질문 목록에 없는 질문의 응답(보관 안 된 것), 기간과 상관없이 전체
 *   ② 보관한 질문           — 보관함으로 옮긴 질문
 * 두 구역 모두 200개씩 보여 주고 「더 보기」로 끝까지 볼 수 있다(숨은 상태를 만들지 않는다).
 *
 * 확인 창은 여기서 띄우고, 부모(대시보드)의 핸들러는 확인 없이 실행한다. 동작이 끝나면 부모가
 * refreshKey 를 올려 이 패널이 두 구역을 첫 쪽부터 다시 읽는다.
 * 영구 삭제 버튼은 onPurge 가 있을 때만 그린다 — 권한이 없는 쪽에는 버튼도 설명도 없다.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ArchiveActionResult, ArchiveCounts, ArchiveQuestionItem, ArchiveView, ScrapeRun } from "@/components/dashboard/types";
import { PROVIDER_LABELS } from "@/components/dashboard/types";
import { fetchArchivedRunsForPrompt, fetchResponseArchive } from "@/lib/client/server-store";
import { toKstDateKey } from "@/lib/client/date-kst";
import {
  buildArchiveConfirm,
  buildBulkArchiveConfirm,
  buildPurgeConfirm,
  formatArchivePeriod,
  formatArchiveRunCounts,
} from "@/lib/client/response-archive-utils";

type ActionFn = (texts: string[]) => Promise<ArchiveActionResult | null>;

type Props = {
  workspaceId: string;
  refreshKey: number;
  onArchive: ActionFn;
  onArchiveAllUntracked: (asOf: string) => Promise<ArchiveActionResult | null>;
  onRestore: ActionFn;
  /** 영구 삭제 — 삭제 권한이 있을 때만 준다 */
  onPurge?: ActionFn;
  /** 보관함 숫자가 바뀌면 부모(탭 막대의 「보관함 (N)」)에 알린다 */
  onCountsChange?: (counts: ArchiveCounts) => void;
};

type Section = {
  items: ArchiveQuestionItem[];
  nextCursor: string | null;
  asOf: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
};

const EMPTY_SECTION: Section = { items: [], nextCursor: null, asOf: null, loading: true, loadingMore: false, error: false };
const PREVIEW_LIMIT = 20;

type RunsPreview = { loading: boolean; error: boolean; runs: ScrapeRun[] };

const BTN =
  "shrink-0 rounded-md border border-th-border bg-th-card px-2.5 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:cursor-not-allowed disabled:opacity-50";
const BTN_DANGER =
  "shrink-0 rounded-md border border-th-danger/40 bg-th-card px-2.5 py-1 text-xs text-th-danger hover:bg-th-danger-soft disabled:cursor-not-allowed disabled:opacity-50";

function mergeItems(prev: ArchiveQuestionItem[], next: ArchiveQuestionItem[]): ArchiveQuestionItem[] {
  const seen = new Set(prev.map((i) => i.promptText));
  return [...prev, ...next.filter((i) => !seen.has(i.promptText))];
}

export function ResponseArchivePanel({
  workspaceId,
  refreshKey,
  onArchive,
  onArchiveAllUntracked,
  onRestore,
  onPurge,
  onCountsChange,
}: Props) {
  const [untracked, setUntracked] = useState<Section>(EMPTY_SECTION);
  const [archived, setArchived] = useState<Section>(EMPTY_SECTION);
  const [counts, setCounts] = useState<ArchiveCounts | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, RunsPreview | undefined>>({});
  /** 가장 최근 읽기만 반영 — 느린 옛 응답이 새 목록을 덮어쓰지 않게 한다. */
  const loadSeq = useRef(0);
  const onCountsRef = useRef(onCountsChange);
  useEffect(() => {
    onCountsRef.current = onCountsChange;
  }, [onCountsChange]);

  const applyCounts = useCallback((c: ArchiveCounts) => {
    setCounts(c);
    onCountsRef.current?.(c);
  }, []);

  const loadFirst = useCallback(async () => {
    const seq = ++loadSeq.current;
    setUntracked((s) => ({ ...s, loading: true, error: false }));
    setArchived((s) => ({ ...s, loading: true, error: false }));
    const [u, a] = await Promise.allSettled([
      fetchResponseArchive(workspaceId, "untracked"),
      fetchResponseArchive(workspaceId, "archived"),
    ]);
    if (seq !== loadSeq.current) return;
    if (u.status === "fulfilled") {
      setUntracked({ items: u.value.items, nextCursor: u.value.nextCursor, asOf: u.value.asOf, loading: false, loadingMore: false, error: false });
    } else {
      setUntracked({ ...EMPTY_SECTION, loading: false, error: true });
    }
    if (a.status === "fulfilled") {
      setArchived({ items: a.value.items, nextCursor: a.value.nextCursor, asOf: a.value.asOf, loading: false, loadingMore: false, error: false });
    } else {
      setArchived({ ...EMPTY_SECTION, loading: false, error: true });
    }
    const latest = a.status === "fulfilled" ? a.value.counts : u.status === "fulfilled" ? u.value.counts : null;
    if (latest) applyCounts(latest);
    setPreviews({});
  }, [workspaceId, applyCounts]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, refreshKey]);

  async function loadMore(view: ArchiveView) {
    const section = view === "untracked" ? untracked : archived;
    const set = view === "untracked" ? setUntracked : setArchived;
    if (!section.nextCursor || section.loadingMore) return;
    const seq = loadSeq.current;
    set((s) => ({ ...s, loadingMore: true }));
    try {
      const res = await fetchResponseArchive(workspaceId, view, section.nextCursor);
      if (seq !== loadSeq.current) return;
      set((s) => ({ ...s, items: mergeItems(s.items, res.items), nextCursor: res.nextCursor, loadingMore: false }));
      applyCounts(res.counts);
    } catch {
      if (seq !== loadSeq.current) return;
      set((s) => ({ ...s, loadingMore: false, error: true }));
    }
  }

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy((b) => new Set(b).add(key));
    try {
      await fn();
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  }

  function archiveOne(item: ArchiveQuestionItem) {
    if (!window.confirm(buildArchiveConfirm(item.promptText))) return;
    void run(item.promptText, () => onArchive([item.promptText]));
  }

  function purgeOne(item: ArchiveQuestionItem) {
    if (!onPurge) return;
    if (!window.confirm(buildPurgeConfirm(item.promptText, item.runCount))) return;
    void run(item.promptText, () => onPurge([item.promptText]));
  }

  function restoreOne(item: ArchiveQuestionItem) {
    void run(item.promptText, () => onRestore([item.promptText]));
  }

  async function archiveAll() {
    if (!untracked.asOf || !counts || counts.untrackedQuestions === 0) return;
    if (!window.confirm(buildBulkArchiveConfirm(counts.untrackedQuestions, counts.untrackedRuns))) return;
    setBulkBusy(true);
    try {
      await onArchiveAllUntracked(untracked.asOf);
    } finally {
      setBulkBusy(false);
    }
  }

  async function togglePreview(item: ArchiveQuestionItem) {
    const text = item.promptText;
    if (previews[text]) {
      setPreviews((p) => ({ ...p, [text]: undefined }));
      return;
    }
    setPreviews((p) => ({ ...p, [text]: { loading: true, error: false, runs: [] } }));
    try {
      const runs = await fetchArchivedRunsForPrompt(workspaceId, text, PREVIEW_LIMIT);
      setPreviews((p) => (p[text] ? { ...p, [text]: { loading: false, error: false, runs } } : p));
    } catch {
      setPreviews((p) => (p[text] ? { ...p, [text]: { loading: false, error: true, runs: [] } } : p));
    }
  }

  const untrackedTotal = counts?.untrackedQuestions ?? untracked.items.length;
  const archivedTotal = counts?.archivedQuestions ?? archived.items.length;

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs leading-relaxed text-th-text-secondary">
        보관한 응답은 AI 응답 목록과 홈·가시성·인용 통계에서 빠집니다. 되돌리면 그대로 다시 들어갑니다. 보관한 뒤 같은
        질문으로 새로 받은 응답은 ①에 다시 보입니다.
      </p>

      {/* ① 아직 정리하지 않은 질문 */}
      <section className="rounded-xl border border-th-border bg-th-card-alt" aria-labelledby="archive-untracked-title">
        <div className="flex flex-wrap items-center gap-2 border-b border-th-border px-4 py-3">
          <h3 id="archive-untracked-title" className="min-w-0 flex-1 text-sm font-semibold text-th-text">
            ① 질문 목록에 없는 질문 {untrackedTotal}개 <span className="font-normal text-th-text-muted">(기간과 상관없이 전체)</span>
          </h3>
          {untrackedTotal > 0 && (
            <button
              type="button"
              className={BTN}
              onClick={() => void archiveAll()}
              disabled={bulkBusy || untracked.loading || !untracked.asOf}
              title="이 목록을 불러온 시각까지의 응답을 모두 보관함으로 옮깁니다"
            >
              {bulkBusy ? "옮기는 중…" : "모두 보관함으로"}
            </button>
          )}
        </div>
        <SectionBody
          section={untracked}
          emptyText="질문 목록에 없는 질문이 없습니다."
          total={untrackedTotal}
          onRetry={() => void loadFirst()}
          onMore={() => void loadMore("untracked")}
          renderItem={(item) => (
            <ArchiveRow
              key={item.promptText}
              item={item}
              busy={busy.has(item.promptText) || bulkBusy}
              actions={
                <>
                  <button type="button" className={BTN} disabled={busy.has(item.promptText) || bulkBusy} onClick={() => archiveOne(item)}>
                    보관함으로
                  </button>
                  {onPurge && (
                    <button type="button" className={BTN_DANGER} disabled={busy.has(item.promptText) || bulkBusy} onClick={() => purgeOne(item)}>
                      영구 삭제
                    </button>
                  )}
                </>
              }
            />
          )}
        />
      </section>

      {/* ② 보관한 질문 */}
      <section className="rounded-xl border border-th-border bg-th-card-alt" aria-labelledby="archive-archived-title">
        <div className="border-b border-th-border px-4 py-3">
          <h3 id="archive-archived-title" className="text-sm font-semibold text-th-text">
            ② 보관한 질문 {archivedTotal}개
          </h3>
        </div>
        <SectionBody
          section={archived}
          emptyText="보관함이 비어 있습니다."
          total={archivedTotal}
          onRetry={() => void loadFirst()}
          onMore={() => void loadMore("archived")}
          renderItem={(item) => {
            const preview = previews[item.promptText];
            const isBusy = busy.has(item.promptText);
            return (
              <ArchiveRow
                key={item.promptText}
                item={item}
                busy={isBusy}
                note={
                  item.inList ? (
                    <span className="rounded bg-th-accent-soft px-1.5 py-0.5 text-[11px] text-th-text-accent">
                      질문 목록에 있음 — 되돌려야 통계에 들어갑니다
                    </span>
                  ) : null
                }
                archivedDay={item.archivedAt ? toKstDateKey(item.archivedAt) : null}
                actions={
                  <>
                    <button type="button" className={BTN} disabled={isBusy} onClick={() => restoreOne(item)}>
                      되돌리기
                    </button>
                    {!item.inList && onPurge && (
                      <button type="button" className={BTN_DANGER} disabled={isBusy} onClick={() => purgeOne(item)}>
                        영구 삭제
                      </button>
                    )}
                    {!item.inList && (
                      <button type="button" className={BTN} onClick={() => void togglePreview(item)} aria-expanded={!!preview}>
                        {preview ? "응답 접기" : "응답 보기"}
                      </button>
                    )}
                  </>
                }
                extra={preview ? <RunsPreviewList preview={preview} total={item.runCount} /> : null}
              />
            );
          }}
        />
      </section>
    </div>
  );
}

function SectionBody({
  section,
  emptyText,
  total,
  onRetry,
  onMore,
  renderItem,
}: {
  section: Section;
  emptyText: string;
  total: number;
  onRetry: () => void;
  onMore: () => void;
  renderItem: (item: ArchiveQuestionItem) => ReactNode;
}) {
  if (section.loading && section.items.length === 0) {
    return <p className="px-4 py-4 text-xs text-th-text-muted">불러오는 중…</p>;
  }
  if (section.error && section.items.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-4 text-xs text-th-text-muted">
        <span>불러오지 못했습니다.</span>
        <button type="button" className={BTN} onClick={onRetry}>
          다시 시도
        </button>
      </div>
    );
  }
  if (section.items.length === 0) {
    return <p className="px-4 py-4 text-xs text-th-text-muted">{emptyText}</p>;
  }
  const remaining = Math.max(total - section.items.length, 0);
  return (
    <div>
      <ul className="divide-y divide-th-border/60">{section.items.map(renderItem)}</ul>
      {section.error && (
        <div className="flex flex-wrap items-center gap-2 border-t border-th-border px-4 py-2 text-xs text-th-text-muted">
          <span>불러오지 못했습니다.</span>
          <button type="button" className={BTN} onClick={onRetry}>
            다시 시도
          </button>
        </div>
      )}
      {section.nextCursor && (
        <div className="border-t border-th-border px-4 py-2">
          <button type="button" className={`${BTN} w-full sm:w-auto`} onClick={onMore} disabled={section.loadingMore}>
            {section.loadingMore ? "불러오는 중…" : `더 보기 (남은 질문 ${remaining}개)`}
          </button>
        </div>
      )}
    </div>
  );
}

function ArchiveRow({
  item,
  busy,
  actions,
  note,
  archivedDay,
  extra,
}: {
  item: ArchiveQuestionItem;
  busy: boolean;
  actions: ReactNode;
  note?: ReactNode;
  archivedDay?: string | null;
  extra?: ReactNode;
}) {
  return (
    <li className={`px-4 py-3 ${busy ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[14rem]">
          <p className="line-clamp-2 break-words text-sm font-medium leading-snug text-th-text" title={item.promptText}>
            {item.promptText}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-th-text-muted">
            <span>{formatArchiveRunCounts(item.runCount, item.autoCount, item.manualCount)}</span>
            <span>{formatArchivePeriod(item.firstAt, item.lastAt)}</span>
            {archivedDay && <span>보관한 날 {archivedDay}</span>}
          </p>
          {note && <div className="mt-1">{note}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
      </div>
      {extra}
    </li>
  );
}

function RunsPreviewList({ preview, total }: { preview: RunsPreview; total: number }) {
  if (preview.loading) return <p className="mt-2 text-xs text-th-text-muted">응답을 불러오는 중…</p>;
  if (preview.error) return <p className="mt-2 text-xs text-th-text-muted">응답을 불러오지 못했습니다.</p>;
  if (preview.runs.length === 0) return <p className="mt-2 text-xs text-th-text-muted">보여 줄 응답이 없습니다.</p>;
  return (
    <div className="mt-2 space-y-1.5">
      {total > PREVIEW_LIMIT && <p className="text-[11px] text-th-text-muted">최근 {PREVIEW_LIMIT}건만 보여 줍니다.</p>}
      <ul className="space-y-1.5">
        {preview.runs.map((r, i) => {
          const text = (r.answer ?? "").replace(/\s+/g, " ").trim();
          return (
            <li key={r.id ?? `${r.provider}-${r.createdAt}-${i}`} className="rounded-md border border-th-border bg-th-card px-3 py-2 text-xs">
              <div className="flex flex-wrap gap-x-2 text-th-text-muted">
                <span className="font-semibold text-th-text-secondary">{PROVIDER_LABELS[r.provider] ?? r.provider}</span>
                <span>{toKstDateKey(r.createdAt)}</span>
                <span>점수 {r.visibilityScore}</span>
                <span>{r.auto ? "자동" : "수동"}</span>
              </div>
              <p className="mt-1 break-words text-th-text-secondary">
                {text ? (text.length > 200 ? `${text.slice(0, 200)}…` : text) : "응답 본문이 없습니다."}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
