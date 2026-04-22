/**
 * Phase 5B — 서버 기반 자동화 탭.
 *
 * 동작:
 *  - 첫 진입 시: 서버에 워크스페이스가 없으면 현재 브랜드 기준으로 자동 생성
 *  - 스케줄 목록 조회 · 추가 · 삭제 · 즉시 실행
 *  - 최근 자동 실행(runs where is_auto=true) 요약 표시
 *
 * 기존 브라우저 기반 setInterval 자동화는 이 탭으로 대체.
 * 실제 실행은 mbd-geo-tracker-worker 컨테이너가 1분마다 수행.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BrandConfig,
  Competitor,
  TaggedPrompt,
  Provider,
} from "@/components/dashboard/types";
import { PROVIDER_LABELS, VISIBLE_PROVIDERS } from "@/components/dashboard/types";

import { WORKSPACE_ID_KEY } from "@/lib/client/constants";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type ServerSchedule = {
  id: string;
  workspaceId: string;
  name: string;
  cronExpression: string;
  providers: string[];
  promptIds: string[];
  geolocation: string | null;
  active: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
};

type ServerRun = {
  id: string;
  promptText: string;
  provider: string;
  visibilityScore: number;
  sentiment: string;
  brandMentions: string[];
  createdAt: string;
  isAuto: boolean;
};

type ServerPrompt = {
  id: string;
  text: string;
  tags: string[];
  active: boolean;
};

/** 12시간 기본. UI 에서 1/6/12/24 선택 */
const INTERVAL_PRESETS: { label: string; cron: string; hours: number }[] = [
  { label: "1시간마다", cron: "0 * * * *", hours: 1 },
  { label: "6시간마다", cron: "0 */6 * * *", hours: 6 },
  { label: "12시간마다", cron: "0 */12 * * *", hours: 12 },
  { label: "하루 1회 (00:00 KST)", cron: "0 0 * * *", hours: 24 },
];

type AutomationServerTabProps = {
  brand: BrandConfig;
  competitors: Competitor[];
  customPrompts: TaggedPrompt[];
};

export function AutomationServerTab({
  brand,
  competitors,
  customPrompts,
}: AutomationServerTabProps) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [initState, setInitState] = useState<"loading" | "ready" | "error">("loading");
  const [initError, setInitError] = useState<string>("");

  const [schedules, setSchedules] = useState<ServerSchedule[]>([]);
  const [recentRuns, setRecentRuns] = useState<ServerRun[]>([]);
  const [serverPrompts, setServerPrompts] = useState<ServerPrompt[]>([]);
  const [busy, setBusy] = useState(false);
  const [rowActionIds, setRowActionIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string>("");

  // 스케줄 추가 폼 상태
  const [newName, setNewName] = useState("기본 자동 조사");
  const [newCron, setNewCron] = useState(INTERVAL_PRESETS[2].cron); // 12시간 기본
  const [newProviders, setNewProviders] = useState<Provider[]>([...VISIBLE_PROVIDERS]);

  /**
   * 워크스페이스 초기화
   * - localStorage 에 ID 있으면 → 서버에서 확인
   * - 없거나 서버에 없으면 → 신규 생성 (현재 브랜드 + 경쟁사 + 프롬프트 세팅)
   */
  const initWorkspace = useCallback(async () => {
    try {
      setInitState("loading");

      // 1) localStorage 에서 ID 확인
      const cached = typeof window !== "undefined" ? localStorage.getItem(WORKSPACE_ID_KEY) : null;

      const wsRes = await fetch(`${BP}/api/workspaces`, { credentials: "include" });
      if (!wsRes.ok) throw new Error(`워크스페이스 조회 실패 (HTTP ${wsRes.status})`);
      const { workspaces } = (await wsRes.json()) as {
        workspaces: { id: string; name: string; brandConfig: BrandConfig }[];
      };

      let ws = cached ? workspaces.find((w) => w.id === cached) : undefined;

      // 캐시가 없거나 유효하지 않으면 — 이름 일치하는 것 찾기, 아니면 첫 번째
      if (!ws) {
        ws =
          workspaces.find((w) => w.brandConfig?.brandName === brand.brandName) ??
          workspaces[0];
      }

      // 아예 없으면 — 현재 브랜드로 자동 생성
      if (!ws) {
        const createRes = await fetch(`${BP}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            name: brand.brandName?.trim() || "기본 워크스페이스",
            brandConfig: brand,
          }),
        });
        if (!createRes.ok) throw new Error("워크스페이스 자동 생성 실패");
        const created = (await createRes.json()).workspace;
        ws = created;

        // 경쟁사 + 프롬프트 동기화 (자동 생성 시 최초 1회)
        if (ws) {
          const sync = await syncInitialSetup(ws.id);
          if (sync.promptFails > 0 || sync.competitorFails > 0) {
            setMessage(
              `경고: 초기 동기화 일부 실패 — 프롬프트 ${sync.promptFails}개 · 경쟁사 ${sync.competitorFails}개. 재시도 또는 수동 추가 필요.`,
            );
          }
        }
      }

      if (ws) {
        setWorkspaceId(ws.id);
        if (typeof window !== "undefined") {
          localStorage.setItem(WORKSPACE_ID_KEY, ws.id);
        }
      }
      setInitState("ready");
    } catch (e) {
      setInitError(e instanceof Error ? e.message : String(e));
      setInitState("error");
    }
  }, [brand]);

  /**
   * 신규 워크스페이스에 경쟁사/프롬프트 최초 복사.
   * 실패 항목 수를 반환해 사용자에게 경고 표시 가능.
   */
  async function syncInitialSetup(wsId: string): Promise<{ promptFails: number; competitorFails: number }> {
    let promptFails = 0;
    let competitorFails = 0;
    for (const p of customPrompts) {
      if (!p.text?.trim()) continue;
      try {
        const res = await fetch(`${BP}/api/workspaces/${wsId}/prompts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ text: p.text, tags: p.tags ?? [] }),
        });
        // 409 (중복) 은 실패로 치지 않음 — 이미 존재하는 프롬프트
        if (!res.ok && res.status !== 409) promptFails += 1;
      } catch {
        promptFails += 1;
      }
    }
    for (const c of competitors) {
      if (!c.name?.trim()) continue;
      try {
        const res = await fetch(`${BP}/api/workspaces/${wsId}/competitors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            name: c.name,
            aliases: c.aliases ?? [],
            websites: c.websites ?? [],
          }),
        });
        if (!res.ok) competitorFails += 1;
      } catch {
        competitorFails += 1;
      }
    }
    return { promptFails, competitorFails };
  }

  const reloadSchedules = useCallback(async () => {
    if (!workspaceId) return;
    const res = await fetch(`${BP}/api/workspaces/${workspaceId}/schedules`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { schedules: ServerSchedule[] };
    setSchedules(data.schedules);
  }, [workspaceId]);

  const reloadRecentRuns = useCallback(async () => {
    if (!workspaceId) return;
    const res = await fetch(
      `${BP}/api/workspaces/${workspaceId}/runs?auto=true&limit=30`,
      { credentials: "include" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { runs: ServerRun[] };
    setRecentRuns(data.runs);
  }, [workspaceId]);

  const reloadPrompts = useCallback(async () => {
    if (!workspaceId) return;
    const res = await fetch(`${BP}/api/workspaces/${workspaceId}/prompts`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { prompts: ServerPrompt[] };
    setServerPrompts(data.prompts);
  }, [workspaceId]);

  useEffect(() => {
    void initWorkspace();
  }, [initWorkspace]);

  useEffect(() => {
    if (!workspaceId) return;
    void reloadSchedules();
    void reloadRecentRuns();
    void reloadPrompts();
    const t = setInterval(() => {
      void reloadRecentRuns();
      void reloadSchedules();
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 프롬프트·경쟁사가 외부에서 변경되면 서버 DB에 동기화 후 목록 갱신
  // syncInitialSetup 과 동일 로직이나 409(중복)는 조용히 무시 → 새로 추가된 항목만 서버에 저장됨
  useEffect(() => {
    if (!workspaceId || initState !== "ready") return;
    let cancelled = false;
    const sync = async () => {
      for (const p of customPrompts) {
        if (!p.text?.trim() || cancelled) continue;
        await fetch(`${BP}/api/workspaces/${workspaceId}/prompts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ text: p.text, tags: p.tags ?? [] }),
        }).catch(() => null); // 409 포함 모든 에러 무시
      }
      for (const c of competitors) {
        if (!c.name?.trim() || cancelled) continue;
        await fetch(`${BP}/api/workspaces/${workspaceId}/competitors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ name: c.name, aliases: c.aliases ?? [], websites: c.websites ?? [] }),
        }).catch(() => null);
      }
      if (!cancelled) void reloadPrompts();
    };
    void sync();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customPrompts.length, competitors.length, workspaceId, initState]);

  async function addSchedule() {
    if (!workspaceId || busy || !newName.trim() || newProviders.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`${BP}/api/workspaces/${workspaceId}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: newName.trim(),
          cronExpression: newCron,
          providers: newProviders,
          promptIds: [],
          active: true,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "생성 실패");
      setMessage("스케줄이 추가됐습니다. 다음 tick (최대 1분) 에 실행됩니다.");
      await reloadSchedules();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "생성 실패");
    } finally {
      setBusy(false);
    }
  }

  /** 행 단위 액션 중복 실행 방지용 락 */
  function withRowLock(id: string, fn: () => Promise<void>) {
    return async () => {
      if (rowActionIds.has(id)) return;
      setRowActionIds((prev) => new Set(prev).add(id));
      try {
        await fn();
      } finally {
        setRowActionIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    };
  }

  async function deleteSchedule(id: string) {
    if (!window.confirm("이 스케줄을 삭제할까요? 과거 실행 이력은 유지됩니다.")) return;
    try {
      const res = await fetch(`${BP}/api/schedules/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("삭제 실패");
      await reloadSchedules();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  async function triggerSchedule(id: string) {
    try {
      const res = await fetch(`${BP}/api/schedules/${id}/trigger`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("트리거 실패");
      setMessage("즉시 실행 예약됨 — Worker 가 1분 내 처리합니다.");
      await reloadSchedules();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "트리거 실패");
    }
  }

  async function toggleActive(sch: ServerSchedule) {
    try {
      // 재개(active: true) 시엔 nextRunAt 을 현재 시각으로 초기화 → 다음 tick 에 실행
      // 일시정지(active: false) 시엔 nextRunAt 유지 (재개 시 즉시 실행하지 않는 옵션도 있으나
      // 사용자가 일시정지 후 재개하면 "지금부터 주기 시작" 이 자연스러움)
      const patch: Record<string, unknown> = { active: !sch.active };
      if (!sch.active) {
        // false → true (재개)
        patch.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      }
      const res = await fetch(`${BP}/api/schedules/${sch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("변경 실패");
      await reloadSchedules();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "변경 실패");
    }
  }

  // 최근 자동 실행 요약
  const stats = useMemo(() => {
    if (recentRuns.length === 0) return null;
    const total = recentRuns.length;
    const mentioned = recentRuns.filter((r) => r.brandMentions.length > 0).length;
    const avgVisibility = Math.round(
      recentRuns.reduce((s, r) => s + r.visibilityScore, 0) / total,
    );
    return { total, mentioned, avgVisibility };
  }, [recentRuns]);

  const promptCount = serverPrompts.filter((p) => p.active).length;

  if (initState === "loading") {
    return (
      <div className="rounded-lg border border-th-border bg-th-card p-6 text-sm text-th-text-muted">
        서버 워크스페이스 확인 중…
      </div>
    );
  }

  if (initState === "error") {
    return (
      <div className="rounded-lg border border-th-danger/30 bg-th-danger-soft p-6 text-sm text-th-danger">
        워크스페이스 초기화 실패: {initError}
        <button
          onClick={() => void initWorkspace()}
          className="ml-3 rounded-md border border-th-danger/40 px-2 py-1 text-xs"
        >
          다시 시도
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 상태 요약 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          title="활성 스케줄"
          value={schedules.filter((s) => s.active).length}
          subtitle={`전체 ${schedules.length}개`}
        />
        <StatCard
          title="추적 프롬프트"
          value={promptCount}
          subtitle="서버 DB 기준"
        />
        <StatCard
          title="최근 자동 실행"
          value={stats?.total ?? 0}
          subtitle={stats ? `평균 가시성 ${stats.avgVisibility} · 언급 ${stats.mentioned}` : ""}
        />
      </div>

      {/* 스케줄 목록 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-th-text">자동 조사 스케줄</h3>
          <div className="flex items-center gap-2">
            {message && (
              <span className="text-xs text-th-text-muted">{message}</span>
            )}
            <button
              onClick={() => { void reloadSchedules(); void reloadRecentRuns(); void reloadPrompts(); }}
              className="rounded-md border border-th-border bg-th-card-alt px-2.5 py-1 text-xs text-th-text-muted hover:bg-th-card-hover hover:text-th-text"
              title="스케줄·실행 결과 즉시 새로고침"
            >
              ↻ 새로고침
            </button>
          </div>
        </div>

        {schedules.length === 0 ? (
          <p className="text-sm text-th-text-muted">
            아직 설정된 스케줄이 없습니다. 아래에서 추가하세요.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-th-border text-left text-xs text-th-text-muted">
                  <th className="py-2">이름</th>
                  <th className="py-2">주기</th>
                  <th className="py-2">프로바이더</th>
                  <th className="py-2">마지막 실행</th>
                  <th className="py-2">다음 실행</th>
                  <th className="py-2">상태</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-b border-th-border-subtle">
                    <td className="py-2 font-medium text-th-text">{s.name}</td>
                    <td className="py-2 text-th-text-secondary">
                      {humanizeCron(s.cronExpression)}
                    </td>
                    <td className="py-2 text-th-text-secondary">
                      {s.providers.length}개 · {s.providers.slice(0, 2).join(", ")}
                      {s.providers.length > 2 ? " …" : ""}
                    </td>
                    <td className="py-2 text-th-text-muted">{formatKst(s.lastRunAt)}</td>
                    <td className="py-2 text-th-text-muted">
                      {s.nextRunAt && new Date(s.nextRunAt) <= new Date()
                        ? <span className="text-th-text-accent">실행 대기 중…</span>
                        : formatKst(s.nextRunAt)}
                    </td>
                    <td className="py-2">
                      <button
                        onClick={withRowLock(s.id, () => toggleActive(s))}
                        disabled={rowActionIds.has(s.id)}
                        className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                          s.active
                            ? "bg-th-success-soft text-th-success"
                            : "bg-th-text-muted/10 text-th-text-muted"
                        }`}
                      >
                        {s.active ? "활성" : "일시정지"}
                      </button>
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={withRowLock(s.id, () => triggerSchedule(s.id))}
                        disabled={rowActionIds.has(s.id)}
                        className="mr-2 rounded border border-th-border bg-th-card-alt px-2 py-1 text-xs hover:bg-th-card-hover disabled:opacity-50"
                        title="즉시 실행 — 다음 tick 에 곧바로 실행됨"
                      >
                        ⏱ 즉시
                      </button>
                      <button
                        onClick={withRowLock(s.id, () => deleteSchedule(s.id))}
                        disabled={rowActionIds.has(s.id)}
                        className="rounded border border-th-danger/40 bg-th-danger-soft px-2 py-1 text-xs text-th-danger hover:bg-th-danger/20 disabled:opacity-50"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 스케줄 추가 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <h3 className="mb-3 text-base font-semibold text-th-text">새 스케줄 추가</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">
              이름
            </label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="bd-input w-full rounded-lg p-2 text-sm"
              placeholder="예: 기본 자동 조사"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">
              주기
            </label>
            <select
              value={newCron}
              onChange={(e) => setNewCron(e.target.value)}
              className="bd-input w-full rounded-lg p-2 text-sm"
            >
              {INTERVAL_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">
            프로바이더 선택
          </label>
          <div className="flex flex-wrap gap-2">
            {VISIBLE_PROVIDERS.map((p) => {
              const on = newProviders.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setNewProviders((prev) =>
                      on ? prev.filter((x) => x !== p) : [...prev, p],
                    )
                  }
                  className={`rounded-full border px-3 py-1 text-xs ${
                    on
                      ? "border-th-accent bg-th-accent-soft text-th-accent"
                      : "border-th-border bg-th-card-alt text-th-text-secondary"
                  }`}
                >
                  {on ? "✓" : ""} {PROVIDER_LABELS[p]}
                </button>
              );
            })}
          </div>
        </div>

        <p className="mt-3 text-xs text-th-text-muted">
          활성 프롬프트 {promptCount}개를 선택한 프로바이더에서 각각 실행합니다. (프롬프트는 서버 DB 기준)
        </p>

        <button
          onClick={addSchedule}
          disabled={busy || !newName.trim() || newProviders.length === 0}
          className="mt-3 rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-text-inverse hover:bg-th-accent-hover disabled:opacity-50"
        >
          {busy ? "추가 중…" : "스케줄 추가"}
        </button>
      </div>

      {/* 최근 자동 실행 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <h3 className="mb-3 text-base font-semibold text-th-text">최근 자동 실행 (최대 30건)</h3>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-th-text-muted">
            아직 자동 실행된 기록이 없습니다. 스케줄을 추가하고 기다리거나 &quot;⏱ 즉시&quot; 로 바로 실행하세요.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-th-border text-left text-th-text-muted">
                  <th className="py-2">시각</th>
                  <th className="py-2">프로바이더</th>
                  <th className="py-2">프롬프트</th>
                  <th className="py-2">점수</th>
                  <th className="py-2">감성</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((r) => (
                  <tr key={r.id} className="border-b border-th-border-subtle">
                    <td className="py-1.5 text-th-text-muted">{formatKst(r.createdAt)}</td>
                    <td className="py-1.5 text-th-text-secondary">
                      {PROVIDER_LABELS[r.provider as Provider] ?? r.provider}
                    </td>
                    <td className="py-1.5 max-w-xs truncate text-th-text">{r.promptText}</td>
                    <td className="py-1.5 font-mono">{r.visibilityScore}</td>
                    <td className="py-1.5 text-th-text-secondary">{r.sentiment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-th-text-muted">
        서버 Worker 가 1분마다 스케줄을 확인해 자동 실행합니다. 브라우저를 닫아도 계속 동작하며,
        여러 관리자가 로그인해도 동일한 결과를 공유합니다.
      </p>
    </div>
  );
}

function StatCard({ title, value, subtitle }: { title: string; value: number | string; subtitle?: string }) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{title}</div>
      <div className="mt-1 text-2xl font-bold text-th-text">{value}</div>
      {subtitle && <div className="mt-0.5 text-xs text-th-text-muted">{subtitle}</div>}
    </div>
  );
}

function formatKst(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function humanizeCron(cron: string): string {
  const preset = INTERVAL_PRESETS.find((p) => p.cron === cron);
  return preset ? preset.label : cron;
}
