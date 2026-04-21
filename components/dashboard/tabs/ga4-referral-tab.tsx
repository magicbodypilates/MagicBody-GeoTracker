import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getCache, setCache, getCacheAgeMs } from "@/lib/client/api-cache";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Status = { authed: boolean; propertyId: string | null };

type Ga4ReferralRow = {
  date: string;
  source: string;
  platform: string;
  landingPage: string;
  sessions: number;
  activeUsers: number;
  screenPageViews: number;
  averageSessionDuration: number;
  engagementRate: number;
};

type Ga4ReferralSnapshot = {
  propertyId: string;
  startDate: string;
  endDate: string;
  totals: { sessions: number; activeUsers: number; screenPageViews: number };
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
  byPlatformEngagement?: Array<{
    platform: string;
    sessions: number;
    averageSessionDuration: number;
    pageViewsPerSession: number;
    engagementRate: number;
  }>;
  hourlyHeatmap?: Array<{
    dayOfWeek: number;
    hour: number;
    sessions: number;
  }>;
  newVsReturning?: Array<{
    userType: string;
    sessions: number;
    activeUsers: number;
  }>;
  topEvents?: Array<{
    eventName: string;
    eventCount: number;
    sessions: number;
  }>;
  topPages?: Array<{
    pagePath: string;
    sessions: number;
    activeUsers: number;
    screenPageViews: number;
  }>;
  rows: Ga4ReferralRow[];
  fetchedAt: string;
};

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const NEW_RETURN_COLORS = ["#10a37f", "#f59e0b"];
const EVENT_COLORS = ["#6b46c1", "#10a37f", "#1a73e8", "#ea4335", "#f59e0b", "#ec4899", "#8b5cf6"];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const PLATFORM_COLORS: Record<string, string> = {
  ChatGPT: "#10a37f",
  Perplexity: "#1ba1e3",
  Gemini: "#4285f4",
  Copilot: "#7c5bbf",
  Bing: "#008373",
  Claude: "#cc785c",
  Grok: "#6b7280",
  "Meta AI": "#0866ff",
  DeepSeek: "#4d6bfe",
  "You.com": "#6d28d9",
  Poe: "#8b5cf6",
  "Character.AI": "#ec4899",
};

function PlatformBadge({ platform }: { platform: string }) {
  const bg = PLATFORM_COLORS[platform] ?? "#6b7280";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: bg + "22", color: bg, border: `1px solid ${bg}44` }}
    >
      {platform}
    </span>
  );
}

export function Ga4ReferralTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [propertyId, setPropertyId] = useState<string>("");
  const [startDate, setStartDate] = useState<string>(isoDaysAgo(30));
  const [endDate, setEndDate] = useState<string>(isoDaysAgo(1));
  const [rangePreset, setRangePreset] = useState<7 | 30 | 90>(30);
  const [snapshot, setSnapshot] = useState<Ga4ReferralSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const autoLoadedRef = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(BP + "/api/ga4/status");
      const data: Status = await r.json();
      setStatus(data);
      if (data.propertyId) setPropertyId(data.propertyId);
    } catch {
      setStatus({ authed: false, propertyId: null });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 최초 1회: 인증 + 속성 ID 준비되면 최근 30일 자동 로드
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (!status?.authed) return;
    if (!propertyId.trim()) return;
    if (snapshot) return;
    autoLoadedRef.current = true;
    void loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, propertyId]);

  async function loadReport(opts: { force?: boolean } = {}) {
    if (!propertyId.trim()) {
      setMessage("GA4 속성 ID를 입력해주세요.");
      return;
    }
    const cacheKey = `geotracker:ga4-referral:${propertyId.trim()}:${startDate}:${endDate}`;
    if (!opts.force) {
      const cached = getCache<Ga4ReferralSnapshot>(cacheKey);
      if (cached) {
        const ageMin = Math.round((getCacheAgeMs(cacheKey) ?? 0) / 60000);
        setSnapshot(cached);
        setMessage(
          `캐시 사용 (${ageMin}분 전) · 총 세션 ${cached.totals.sessions}건 · 강제 재조회는 버튼 클릭`,
        );
        return;
      }
    }
    setBusy(true);
    setMessage(opts.force ? "강제 재조회 중..." : "GA4 조회 중...");
    try {
      const r = await fetch(BP + "/api/ga4/referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: propertyId.trim(), startDate, endDate }),
      });
      const data = await r.json();
      if (!r.ok) {
        const err: string = data.error ?? "조회 실패";
        if (
          err.includes("insufficient") ||
          err.includes("scope") ||
          err.toLowerCase().includes("permission") ||
          err.toLowerCase().includes("analytics")
        ) {
          setMessage(
            `권한 오류 — GA4 API 권한이 없습니다. 아래 'Google 재인증' 버튼으로 권한을 다시 부여하세요.\n\n원문: ${err}`,
          );
        } else {
          setMessage(`조회 실패: ${err}`);
        }
        setSnapshot(null);
        return;
      }
      setSnapshot(data as Ga4ReferralSnapshot);
      setCache(cacheKey, data);
      setMessage(
        `완료: ${data.rows?.length ?? 0}개 row · 총 세션 ${data.totals?.sessions ?? 0}건 · 30분 캐시`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "알 수 없는 오류");
      setSnapshot(null);
    } finally {
      setBusy(false);
    }
  }

  const needsReauth = Boolean(status && !status.authed);

  return (
    <div className="space-y-5">
      {/* 헤더 */}
      <div>
        <div className="mb-1.5 text-base font-semibold text-th-text">AI Referral Traffic</div>
        <p className="text-sm leading-relaxed text-th-text-muted">
          실제 사용자가 ChatGPT, Perplexity, Gemini, Copilot, Claude, Grok 등 AI 플랫폼에서
          우리 사이트로 유입된 세션을 Google Analytics 4 Data API로 조회합니다. 이는 시뮬레이션이 아닌
          <strong className="text-th-text-secondary"> 실제 사용자 행동 데이터</strong>입니다.
        </p>
      </div>

      {/* 연동 상태 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-th-text">Google 연동 상태</div>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
              status?.authed
                ? "border-th-success/30 bg-th-success-soft text-th-success"
                : "border-th-border bg-th-card-alt text-th-text-muted"
            }`}
          >
            {status?.authed ? "연결됨" : "미연결"}
          </span>
        </div>

        {needsReauth && (
          <div className="mb-3 rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
            먼저 GSC Performance 탭에서 Google 계정 연결을 완료하거나, 아래 버튼으로 바로 인증하세요.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={BP + "/api/gsc/auth"}
            className="rounded-lg border border-th-border bg-th-card-alt px-3 py-1.5 text-xs font-medium text-th-text hover:bg-th-card-hover"
          >
            Google 재인증 (GA4 권한 포함)
          </a>
          <span className="text-xs text-th-text-muted">
            GA4 권한이 없다는 오류가 뜨면 이 버튼으로 재인증하세요. Google 팝업에서
            "Analytics 읽기" 권한을 허용해주세요.
          </span>
        </div>
      </div>

      {/* 조회 폼 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3 text-sm font-semibold text-th-text">기간 & 속성</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
              GA4 속성 ID
            </label>
            <input
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              placeholder="473254823"
              className="bd-input w-full rounded-lg p-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
              시작일
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="bd-input w-full rounded-lg p-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
              종료일
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="bd-input w-full rounded-lg p-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => loadReport({ force: true })}
            disabled={busy || !status?.authed}
            className="rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-white hover:bg-th-accent-hover disabled:opacity-50"
            title="API 강제 호출 (캐시 무시)"
          >
            {busy ? "조회 중..." : "AI 플랫폼 유입 조회 (재조회)"}
          </button>
          {([7, 30, 90] as const).map((n) => (
            <button
              key={n}
              onClick={() => {
                setRangePreset(n);
                setStartDate(isoDaysAgo(n));
                setEndDate(isoDaysAgo(1));
              }}
              className={`rounded-lg border px-3 py-2 text-xs ${
                rangePreset === n
                  ? "border-th-accent bg-th-accent-soft text-th-text-accent font-semibold"
                  : "border-th-border bg-th-card-alt text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              최근 {n}일
            </button>
          ))}
        </div>
        {message && (
          <div className="mt-3 whitespace-pre-wrap rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
            {message}
          </div>
        )}
      </div>

      {/* 결과 */}
      {snapshot && (
        <>
          {/* 총계 */}
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="전체 AI 유입 세션" value={snapshot.totals.sessions.toLocaleString()} accent />
            <SummaryCard label="활성 사용자" value={snapshot.totals.activeUsers.toLocaleString()} />
            <SummaryCard label="페이지뷰" value={snapshot.totals.screenPageViews.toLocaleString()} />
          </div>

          {/* 플랫폼별 순위 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <div className="mb-3 text-sm font-semibold text-th-text">
              AI 플랫폼별 유입 ({snapshot.byPlatform.length}개 플랫폼 감지)
            </div>
            {snapshot.byPlatform.length === 0 ? (
              <p className="text-sm text-th-text-muted">
                선택한 기간에 AI 플랫폼 referrer 유입이 없습니다. 아직 AI 검색 결과에 노출되지 않았거나
                데이터가 아직 집계되지 않았을 수 있습니다.
              </p>
            ) : (
              <div className="space-y-2">
                {snapshot.byPlatform.map((p) => {
                  const maxSessions = snapshot.byPlatform[0].sessions;
                  const pct = maxSessions > 0 ? (p.sessions / maxSessions) * 100 : 0;
                  return (
                    <div key={p.platform} className="rounded-lg border border-th-border bg-th-card-alt p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <PlatformBadge platform={p.platform} />
                        <span className="text-xs text-th-text-muted">
                          활성 사용자 {p.activeUsers.toLocaleString()} · PV {p.screenPageViews.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-th-border">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: PLATFORM_COLORS[p.platform] ?? "#6b7280",
                            }}
                          />
                        </div>
                        <span className="w-20 text-right text-sm font-semibold text-th-text">
                          {p.sessions.toLocaleString()} 세션
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 전체 페이지 Top 10 (AI 유입 세션 기준) */}
          {(snapshot.topPages?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-3 text-sm font-semibold text-th-text">
                AI 유입 — 전체 페이지 Top {snapshot.topPages!.length} (페이지뷰 기준)
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-th-border text-xs uppercase tracking-wider text-th-text-muted">
                      <th className="px-2 py-2 text-left font-medium">#</th>
                      <th className="px-2 py-2 text-left font-medium">페이지 경로</th>
                      <th className="px-2 py-2 text-right font-medium">페이지뷰</th>
                      <th className="px-2 py-2 text-right font-medium">세션</th>
                      <th className="px-2 py-2 text-right font-medium">활성 사용자</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.topPages!.map((r, i) => (
                      <tr
                        key={`${r.pagePath}-${i}`}
                        className="border-b border-th-border/40 last:border-0"
                      >
                        <td className="px-2 py-1.5 text-th-text-muted">{i + 1}</td>
                        <td
                          className="max-w-[480px] truncate px-2 py-1.5 text-th-text-secondary"
                          title={r.pagePath}
                        >
                          {r.pagePath}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold text-th-text">
                          {r.screenPageViews.toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-right text-th-text-secondary">
                          {r.sessions.toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-right text-th-text-secondary">
                          {r.activeUsers.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── ① 플랫폼별 체류시간 / 페이지 깊이 비교 ── */}
          {(snapshot.byPlatformEngagement?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-3 text-sm font-semibold text-th-text">
                AI 플랫폼별 세션당 체류시간 / 페이지 깊이
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="h-56">
                  <div className="mb-1 text-xs text-th-text-muted">평균 세션 체류시간 (초)</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={snapshot.byPlatformEngagement}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                      <XAxis dataKey="platform" stroke="var(--th-text-muted)" fontSize={10} />
                      <YAxis stroke="var(--th-text-muted)" fontSize={10} />
                      <Tooltip
                        contentStyle={{
                          background: "var(--th-card)",
                          border: "1px solid var(--th-border)",
                          fontSize: 12,
                        }}
                        formatter={(v: number | undefined) => `${(v ?? 0).toFixed(1)}초`}
                      />
                      <Bar dataKey="averageSessionDuration" name="체류시간(초)">
                        {snapshot.byPlatformEngagement!.map((p) => (
                          <Cell
                            key={p.platform}
                            fill={PLATFORM_COLORS[p.platform] ?? "#6b7280"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="h-56">
                  <div className="mb-1 text-xs text-th-text-muted">세션당 페이지뷰 (페이지 깊이)</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={snapshot.byPlatformEngagement}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                      <XAxis dataKey="platform" stroke="var(--th-text-muted)" fontSize={10} />
                      <YAxis stroke="var(--th-text-muted)" fontSize={10} />
                      <Tooltip
                        contentStyle={{
                          background: "var(--th-card)",
                          border: "1px solid var(--th-border)",
                          fontSize: 12,
                        }}
                        formatter={(v: number | undefined) => `${(v ?? 0).toFixed(2)} 페이지`}
                      />
                      <Bar dataKey="pageViewsPerSession" name="세션당 페이지">
                        {snapshot.byPlatformEngagement!.map((p) => (
                          <Cell
                            key={p.platform}
                            fill={PLATFORM_COLORS[p.platform] ?? "#6b7280"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="border-b border-th-border text-[10px] uppercase tracking-wider text-th-text-muted">
                      <th className="px-2 py-1 text-left">플랫폼</th>
                      <th className="px-2 py-1 text-right">세션</th>
                      <th className="px-2 py-1 text-right">평균 체류</th>
                      <th className="px-2 py-1 text-right">세션당 PV</th>
                      <th className="px-2 py-1 text-right">참여율</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.byPlatformEngagement!.map((p) => (
                      <tr key={p.platform} className="border-b border-th-border/40 last:border-0">
                        <td className="px-2 py-1"><PlatformBadge platform={p.platform} /></td>
                        <td className="px-2 py-1 text-right text-th-text">{p.sessions.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right text-th-text-secondary">{p.averageSessionDuration.toFixed(1)}초</td>
                        <td className="px-2 py-1 text-right text-th-text-secondary">{p.pageViewsPerSession.toFixed(2)}</td>
                        <td className="px-2 py-1 text-right text-th-text-secondary">{(p.engagementRate * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── ② 시간대별 히트맵 ── */}
          {(snapshot.hourlyHeatmap?.length ?? 0) > 0 && (
            <HourlyHeatmap data={snapshot.hourlyHeatmap!} />
          )}

          {/* ── ③ 신규 vs 재방문 ── */}
          {(snapshot.newVsReturning?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-3 text-sm font-semibold text-th-text">
                AI 유입 — 신규 vs 재방문
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={snapshot.newVsReturning!}
                        dataKey="sessions"
                        nameKey="userType"
                        innerRadius={50}
                        outerRadius={85}
                        paddingAngle={2}
                        label={(e: { name?: string; value?: number }) => `${e.name ?? ""} (${e.value ?? 0})`}
                      >
                        {snapshot.newVsReturning!.map((_, i) => (
                          <Cell key={i} fill={NEW_RETURN_COLORS[i % NEW_RETURN_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: "var(--th-card)",
                          border: "1px solid var(--th-border)",
                          fontSize: 12,
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-col justify-center space-y-2">
                  {snapshot.newVsReturning!.map((n, i) => {
                    const total = snapshot.newVsReturning!.reduce((a, b) => a + b.sessions, 0);
                    const pct = total > 0 ? (n.sessions / total) * 100 : 0;
                    return (
                      <div key={n.userType} className="rounded-lg border border-th-border bg-th-card-alt p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: NEW_RETURN_COLORS[i % NEW_RETURN_COLORS.length] }} />
                          <span className="text-sm font-semibold text-th-text">
                            {n.userType === "new" ? "신규 사용자" : n.userType === "returning" ? "재방문 사용자" : n.userType}
                          </span>
                          <span className="ml-auto text-sm font-bold text-th-text">{pct.toFixed(1)}%</span>
                        </div>
                        <div className="mt-1 text-xs text-th-text-muted">
                          세션 {n.sessions.toLocaleString()} · 활성 사용자 {n.activeUsers.toLocaleString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── ④ 전환 깔때기 (주요 이벤트) ── */}
          {(snapshot.topEvents?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-1 text-sm font-semibold text-th-text">
                AI 유입 — 주요 이벤트 (전환 깔때기)
              </div>
              <p className="mb-3 text-xs text-th-text-muted">
                AI 플랫폼에서 유입된 세션에서 발생한 이벤트들입니다. `session_start` → `page_view` → `click/form_submit/purchase` 순으로 사용자 여정을 확인하세요.
              </p>
              <div className="space-y-1.5">
                {snapshot.topEvents!.slice(0, 10).map((e, i) => {
                  const max = snapshot.topEvents![0].eventCount;
                  const pct = max > 0 ? (e.eventCount / max) * 100 : 0;
                  const color = EVENT_COLORS[i % EVENT_COLORS.length];
                  return (
                    <div key={e.eventName} className="flex items-center gap-2 rounded-lg border border-th-border bg-th-card-alt p-2">
                      <span className="w-5 text-xs text-th-text-muted">{i + 1}</span>
                      <span className="min-w-[140px] truncate text-sm text-th-text" title={e.eventName}>
                        {e.eventName}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-th-border">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                      </div>
                      <span className="w-24 text-right text-xs font-semibold text-th-text">
                        {e.eventCount.toLocaleString()}
                      </span>
                      <span className="w-20 text-right text-xs text-th-text-muted">
                        세션 {e.sessions.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 일자별 추이 — 세션/활성 사용자 라인차트 */}
          {snapshot.byDate.length > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold text-th-text">
                  일자별 AI 유입 추이 ({snapshot.byDate.length}일)
                </div>
                <span className="text-xs text-th-text-muted">세션 / 활성 사용자</span>
              </div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={snapshot.byDate}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                    <XAxis
                      dataKey="date"
                      stroke="var(--th-text-muted)"
                      fontSize={11}
                      tickFormatter={(v: string) => v.slice(5)}
                    />
                    <YAxis
                      allowDecimals={false}
                      stroke="var(--th-text-muted)"
                      fontSize={11}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--th-card)",
                        border: "1px solid var(--th-border)",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="sessions"
                      name="세션"
                      stroke="#10a37f"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="activeUsers"
                      name="활성 사용자"
                      stroke="#4285f4"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* 플랫폼별 세션 바차트 */}
          {snapshot.byPlatform.length > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-3 text-sm font-semibold text-th-text">
                AI 플랫폼별 세션 비교
              </div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={snapshot.byPlatform}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                    <XAxis
                      dataKey="platform"
                      stroke="var(--th-text-muted)"
                      fontSize={11}
                    />
                    <YAxis
                      allowDecimals={false}
                      stroke="var(--th-text-muted)"
                      fontSize={11}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--th-card)",
                        border: "1px solid var(--th-border)",
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="sessions" name="세션" fill="#6b46c1" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}

      {/* 도움말 */}
      {!snapshot && !busy && (
        <div className="rounded-lg border border-th-border bg-th-card-alt p-4 text-xs text-th-text-muted">
          <div className="mb-1.5 font-semibold text-th-text-secondary">데이터 한계 안내</div>
          <ul className="list-inside list-disc space-y-1 leading-relaxed">
            <li>
              AI 플랫폼이 referrer 헤더를 보내는 경우에만 집계됩니다. 일부 AI(특히 모바일 앱 내)는
              referrer를 보내지 않아 "Direct(직접)" 트래픽으로 분류될 수 있습니다.
            </li>
            <li>
              AI 답변에 링크로 인용되었지만 사용자가 클릭하지 않은 경우는 집계되지 않습니다.
              "인용 횟수"가 아닌 "실제 방문 횟수"입니다.
            </li>
            <li>
              GA4 데이터는 24-48시간 지연이 있습니다. 오늘 데이터는 미반영될 수 있습니다.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        accent ? "border-th-accent/30 bg-th-accent-soft" : "border-th-border bg-th-card"
      }`}
    >
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{label}</div>
      <div className="mt-1 text-xl font-bold text-th-text">{value}</div>
    </div>
  );
}

function HourlyHeatmap({
  data,
}: {
  data: Array<{ dayOfWeek: number; hour: number; sessions: number }>;
}) {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const cell of data) {
    if (cell.dayOfWeek >= 0 && cell.dayOfWeek < 7 && cell.hour >= 0 && cell.hour < 24) {
      grid[cell.dayOfWeek][cell.hour] = cell.sessions;
      if (cell.sessions > max) max = cell.sessions;
    }
  }

  function color(v: number): string {
    if (max === 0 || v === 0) return "var(--th-card-alt)";
    const t = v / max;
    // teal gradient
    const alpha = Math.max(0.08, Math.min(1, t));
    return `rgba(16,163,127,${alpha.toFixed(2)})`;
  }

  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-th-text">
          AI 유입 — 요일 × 시간 히트맵
        </div>
        <span className="text-xs text-th-text-muted">GA4 타임존 기준 · 진한 색 = 세션 많음</span>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-grid min-w-full gap-[2px]" style={{ gridTemplateColumns: "28px repeat(24, minmax(18px, 1fr))" }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`h-${h}`} className="text-center text-[9px] text-th-text-muted">
              {h}
            </div>
          ))}
          {DAY_LABELS.map((label, d) => (
            <div key={`row-${d}`} className="contents">
              <div className="flex items-center justify-end pr-1 text-[10px] text-th-text-muted">
                {label}
              </div>
              {Array.from({ length: 24 }, (_, h) => {
                const v = grid[d][h];
                return (
                  <div
                    key={`c-${d}-${h}`}
                    className="h-5 rounded-sm border border-th-border/30"
                    style={{ backgroundColor: color(v) }}
                    title={`${label}요일 ${h}시 · ${v.toLocaleString()} 세션`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-th-text-muted">
        적음
        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: "rgba(16,163,127,0.1)" }} />
        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: "rgba(16,163,127,0.35)" }} />
        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: "rgba(16,163,127,0.6)" }} />
        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: "rgba(16,163,127,0.9)" }} />
        많음 (최대 {max.toLocaleString()})
      </div>
    </div>
  );
}
