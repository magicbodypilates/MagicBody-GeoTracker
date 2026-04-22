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
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { GscRow, GscSnapshot, Competitor } from "@/components/dashboard/types";
import type { AiOverviewResult } from "@/lib/server/sro-types";
import { getCache, setCache, getCacheAgeMs } from "@/lib/client/api-cache";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** ISO 3166-1 alpha-3 → 한국어 국가 풀네임 (GSC에서 자주 등장하는 국가 우선) */
const COUNTRY_NAME_KR: Record<string, string> = {
  kor: "대한민국",
  usa: "미국",
  jpn: "일본",
  chn: "중국",
  twn: "대만",
  hkg: "홍콩",
  sgp: "싱가포르",
  tha: "태국",
  vnm: "베트남",
  idn: "인도네시아",
  mys: "말레이시아",
  phl: "필리핀",
  ind: "인도",
  aus: "호주",
  nzl: "뉴질랜드",
  can: "캐나다",
  mex: "멕시코",
  bra: "브라질",
  gbr: "영국",
  deu: "독일",
  fra: "프랑스",
  ita: "이탈리아",
  esp: "스페인",
  nld: "네덜란드",
  che: "스위스",
  swe: "스웨덴",
  rus: "러시아",
  ukr: "우크라이나",
  tur: "튀르키예",
  are: "아랍에미리트",
  sau: "사우디아라비아",
  zaf: "남아프리카공화국",
};

function countryFullName(code: string): string {
  const key = code.toLowerCase();
  return COUNTRY_NAME_KR[key] ?? code.toUpperCase();
}

type Status = { authed: boolean; siteUrl: string | null };

type Dimension = "query" | "page" | "device" | "country" | "date";

type GscPerformanceTabProps = {
  brandName: string;
  brandAliases: string;
  websites: string[];
  competitors: Competitor[];
};

type GscAnalytics = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  totals: { clicks: number; impressions: number };
  totalsPrev: { clicks: number; impressions: number };
  topQueries: Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  queryTrend: Array<{
    date: string;
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  queryDelta: Array<{
    query: string;
    currentClicks: number;
    previousClicks: number;
    delta: number;
    deltaPct: number | null;
    currentPosition: number;
    previousPosition: number;
  }>;
  topPages: Array<{
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  byDevice: Array<{
    device: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  byCountry: Array<{
    country: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  fetchedAt: string;
};

const DEVICE_COLORS: Record<string, string> = {
  MOBILE: "#6b46c1",
  DESKTOP: "#10a37f",
  TABLET: "#f59e0b",
};

const COUNTRY_PALETTE = [
  "#10a37f",
  "#6b46c1",
  "#1a73e8",
  "#ea4335",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#64748b",
  "#14b8a6",
];

const QUERY_LINE_COLORS = [
  "#10a37f",
  "#6b46c1",
  "#1a73e8",
  "#ea4335",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#e11d48",
  "#14b8a6",
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^www\./, "");
  }
}

export function GscPerformanceTab({
  brandName,
  brandAliases,
  websites,
  competitors,
}: GscPerformanceTabProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  const [loadingSites, setLoadingSites] = useState(false);
  const [selectedSite, setSelectedSite] = useState<string>("");
  const [dimension, setDimension] = useState<Dimension>("query");
  // 최근 30일 창으로 고정 — GSC 데이터는 1~2일 지연이 있어 종료일을 1일 전으로 설정
  // (시작일 31일 전 ~ 종료일 1일 전 = 30일 구간)
  const startDate = isoDaysAgo(31);
  const endDate = isoDaysAgo(1);
  const [snapshot, setSnapshot] = useState<GscSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");

  // AI Overview tracking state
  const [aiKeyword, setAiKeyword] = useState<string>("");
  const [aiCountry, setAiCountry] = useState<string>("kr");
  const [aiResult, setAiResult] = useState<AiOverviewResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState<string>("");

  // Analytics state
  const [analytics, setAnalytics] = useState<GscAnalytics | null>(null);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsMessage, setAnalyticsMessage] = useState<string>("");

  const autoLoadedRef = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(BP + "/api/gsc/status");
      const data: Status = await r.json();
      setStatus(data);
      if (data.siteUrl) setSelectedSite(data.siteUrl);
    } catch {
      setStatus({ authed: false, siteUrl: null });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 최초 1회: 인증 + 사이트 준비되면 최근 30일 기본 조회 + 심화 분석 자동 실행
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (!status?.authed) return;
    if (!selectedSite) return;
    autoLoadedRef.current = true;
    void runQuery();
    void runAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedSite]);

  async function loadSites() {
    setLoadingSites(true);
    setMessage("");
    try {
      const r = await fetch(BP + "/api/gsc/sites");
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "failed");
      setSites(data.sites ?? []);
      if ((data.sites ?? []).length > 0 && !selectedSite) {
        setSelectedSite(data.sites[0]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "사이트 목록을 가져오지 못했습니다.";
      setMessage(msg);
    } finally {
      setLoadingSites(false);
    }
  }

  async function saveSite(siteUrl: string) {
    try {
      const r = await fetch(BP + "/api/gsc/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl }),
      });
      if (!r.ok) throw new Error("저장 실패");
      setMessage(`사이트 저장됨: ${siteUrl}`);
      await loadStatus();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function runQuery(opts: { force?: boolean } = {}) {
    if (!selectedSite) {
      setMessage("먼저 사이트를 선택하세요.");
      return;
    }
    const cacheKey = `geotracker:gsc-query:${selectedSite}:${startDate}:${endDate}:${dimension}`;
    if (!opts.force) {
      const cached = getCache<GscSnapshot>(cacheKey);
      if (cached) {
        const ageMin = Math.round((getCacheAgeMs(cacheKey) ?? 0) / 60000);
        setSnapshot(cached);
        setMessage(
          `캐시 사용 (${ageMin}분 전) · ${cached.rowCount}행 · 클릭 ${cached.totals.clicks} · 노출 ${cached.totals.impressions} · 재조회는 "조회 실행" 버튼`,
        );
        return;
      }
    }
    setBusy(true);
    setMessage("GSC 데이터 조회 중...");
    try {
      const params = new URLSearchParams({
        siteUrl: selectedSite,
        startDate,
        endDate,
        dimension,
        rowLimit: "100",
      });
      const r = await fetch(`${BP}/api/gsc/web?${params.toString()}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "조회 실패");
      setSnapshot(data as GscSnapshot);
      setCache(cacheKey, data);
      setMessage(`완료: ${data.rowCount}행, 클릭 ${data.totals.clicks}, 노출 ${data.totals.impressions}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setBusy(false);
    }
  }

  function startAuth() {
    window.location.href = BP + "/api/gsc/auth";
  }

  async function runAnalytics(opts: { force?: boolean } = {}) {
    if (!selectedSite) {
      setAnalyticsMessage("먼저 사이트를 선택하세요.");
      return;
    }
    const cacheKey = `geotracker:gsc-analytics:${selectedSite}:${startDate}:${endDate}`;
    if (!opts.force) {
      const cached = getCache<GscAnalytics>(cacheKey);
      if (cached) {
        const ageMin = Math.round((getCacheAgeMs(cacheKey) ?? 0) / 60000);
        setAnalytics(cached);
        setAnalyticsMessage(
          `캐시 사용 (${ageMin}분 전) · Top 쿼리 ${(cached.topQueries ?? []).length}개 · 강제 재조회는 "심화 분석 실행" 버튼`,
        );
        return;
      }
    }
    setAnalyticsBusy(true);
    setAnalyticsMessage("심화 분석 로드 중... (Top 쿼리, 트렌드, 페이지, 기기, 국가, 증감)");
    try {
      const r = await fetch(BP + "/api/gsc/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteUrl: selectedSite,
          startDate,
          endDate,
          topQueryLimit: 10,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "분석 실패");
      setAnalytics(data as GscAnalytics);
      setCache(cacheKey, data);
      setAnalyticsMessage(
        `분석 완료 · Top 쿼리 ${(data.topQueries ?? []).length}개 · 증감 대상 ${(data.queryDelta ?? []).length}개 · 페이지 ${(data.topPages ?? []).length}개`,
      );
    } catch (e) {
      setAnalyticsMessage(e instanceof Error ? e.message : "분석 실패");
    } finally {
      setAnalyticsBusy(false);
    }
  }

  async function runAiOverview() {
    if (!aiKeyword.trim()) {
      setAiMessage("키워드를 입력하세요.");
      return;
    }
    setAiBusy(true);
    setAiMessage("AI Overview 조회 중...");
    try {
      const brandDomains = websites
        .map((w) => extractHostname(w))
        .filter((h) => h.length > 0);
      const aliases = [
        brandName,
        ...brandAliases.split(",").map((a) => a.trim()),
      ].filter((a) => a.length > 0);
      const competitorNames = competitors
        .flatMap((c) => [c.name, ...c.aliases])
        .filter((n) => n.trim().length > 0);

      const r = await fetch(BP + "/api/gsc/ai-overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: aiKeyword.trim(),
          brandDomains,
          brandAliases: aliases,
          competitors: competitorNames,
          country: aiCountry,
          hl: aiCountry === "kr" ? "ko" : "en",
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "조회 실패");
      setAiResult(data as AiOverviewResult);
      if (!data.exists) {
        if (data.error) {
          setAiMessage(`감지 실패: ${data.error}`);
        } else {
          setAiMessage(
            "AI Overview 블록이 나타나지 않았습니다. (Google이 해당 키워드에 AI Overview를 생성하지 않았을 가능성 — 대화형/로컬/개인화 질문은 종종 제외됨)"
          );
        }
      } else {
        setAiMessage(
          `AI Overview 감지됨 · 출처 ${data.sources.length}개 · 브랜드 ${
            data.brandCited ? "인용" : data.brandMentioned ? "멘션" : "미등장"
          }`
        );
      }
    } catch (e) {
      setAiMessage(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setAiBusy(false);
    }
  }

  if (status === null) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-th-border bg-th-card-alt p-6 text-center text-sm text-th-text-muted">
          상태 확인 중...
        </div>
      </div>
    );
  }

  if (!status.authed) {
    return (
      <div className="space-y-4">
        <div>
          <div className="mb-2 text-base font-semibold text-th-text">Google Search Console 연결</div>
          <p className="mb-3 text-sm leading-relaxed text-th-text-muted">
            사이트의 전체 웹 검색 데이터(노출, 클릭, CTR, 순위)를 조회하려면 Google 계정 승인이 필요합니다.
            최초 1회만 진행하면 이후 자동으로 갱신됩니다.
          </p>
        </div>
        <div className="rounded-lg border border-th-border bg-th-card p-5">
          <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm text-th-text-secondary">
            <li><code className="rounded bg-th-card-alt px-1.5 py-0.5">.env.local</code> 에 <code className="rounded bg-th-card-alt px-1.5 py-0.5">GOOGLE_CLIENT_ID</code>, <code className="rounded bg-th-card-alt px-1.5 py-0.5">GOOGLE_CLIENT_SECRET</code> 가 저장되어 있어야 합니다.</li>
            <li>아래 버튼을 클릭 → Google 로그인 → 권한 허용</li>
            <li>승인 후 자동으로 이 화면으로 돌아옵니다.</li>
          </ol>
          <button
            onClick={startAuth}
            className="bd-btn-primary rounded-lg px-4 py-2.5 text-sm"
          >
            Google 계정 연결하기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Site selection + Query controls — PC(md↑)에서 좌우 배치 */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Site selection */}
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-th-text">연결된 사이트</span>
            <button
              onClick={loadSites}
              disabled={loadingSites}
              className="rounded-md border border-th-border bg-th-card-alt px-2.5 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
            >
              {loadingSites ? "불러오는 중..." : "사이트 목록 새로고침"}
            </button>
          </div>
          <div className="flex gap-2">
            <select
              value={selectedSite}
              onChange={(e) => setSelectedSite(e.target.value)}
              className="bd-input flex-1 rounded-lg p-2 text-sm"
            >
              <option value="">{sites.length === 0 ? "— 사이트 목록 새로고침을 먼저 실행 —" : "— 사이트 선택 —"}</option>
              {sites.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
              {selectedSite && !sites.includes(selectedSite) && (
                <option value={selectedSite}>{selectedSite} (저장됨)</option>
              )}
            </select>
            <button
              onClick={() => saveSite(selectedSite)}
              disabled={!selectedSite}
              className="rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-white hover:bg-th-accent-hover disabled:opacity-50"
            >
              기본 사이트로 저장
            </button>
          </div>
          {status.siteUrl && (
            <div className="mt-2 text-xs text-th-text-muted">
              현재 저장된 기본 사이트: <span className="text-th-text-accent">{status.siteUrl}</span>
            </div>
          )}
        </div>

        {/* Query controls */}
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-2 text-sm font-semibold text-th-text">Search Analytics 조회</div>
          <div className="mb-2 text-xs text-th-text-muted">
            조회 기간: 최근 30일 고정 ({startDate} ~ {endDate})
            <span className="ml-1 text-th-text-muted/70">· GSC 데이터 2~3일 지연 반영</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-1">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">차원</label>
              <select
                value={dimension}
                onChange={(e) => setDimension(e.target.value as Dimension)}
                className="bd-input w-full rounded-lg p-2 text-sm"
              >
                <option value="query">쿼리</option>
                <option value="page">페이지</option>
                <option value="device">기기</option>
                <option value="country">국가</option>
                <option value="date">날짜</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={() => runQuery({ force: true })}
                disabled={busy || !selectedSite}
                title="API 강제 호출 (캐시 무시)"
                className="bd-btn-primary w-full rounded-lg px-4 py-2 text-sm"
              >
                {busy ? "조회 중..." : "조회 실행 (재조회)"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-th-border bg-th-card-alt px-4 py-2 text-sm text-th-text-secondary">
          {message}
        </div>
      )}

      {snapshot && (
        <div className="space-y-3">
          {/* Totals */}
          <div className="grid gap-3 sm:grid-cols-3">
            <KpiCard label="총 클릭" value={snapshot.totals.clicks.toLocaleString()} />
            <KpiCard label="총 노출" value={snapshot.totals.impressions.toLocaleString()} />
            <KpiCard
              label="평균 CTR"
              value={`${(
                snapshot.totals.impressions > 0
                  ? (snapshot.totals.clicks / snapshot.totals.impressions) * 100
                  : 0
              ).toFixed(2)}%`}
            />
          </div>

          {/* Rows table */}
          <div className="overflow-hidden rounded-lg border border-th-border">
            <table className="w-full text-sm">
              <thead className="bg-th-card-alt text-xs uppercase tracking-wider text-th-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">{dimensionLabel(dimension)}</th>
                  <th className="px-3 py-2 text-right">클릭</th>
                  <th className="px-3 py-2 text-right">노출</th>
                  <th className="px-3 py-2 text-right">CTR</th>
                  <th className="px-3 py-2 text-right">순위</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-th-border">
                {snapshot.rows.map((r: GscRow, i: number) => (
                  <tr key={i} className="bg-th-card">
                    <td className="px-3 py-2 text-th-text">{r.key}</td>
                    <td className="px-3 py-2 text-right text-th-text">{r.clicks.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-th-text-secondary">{r.impressions.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-th-text-secondary">{(r.ctr * 100).toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right text-th-text-secondary">{r.position.toFixed(1)}</td>
                  </tr>
                ))}
                {snapshot.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-th-text-muted">
                      데이터가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-th-text-muted">
            조회 기간: {snapshot.startDate} ~ {snapshot.endDate} · 조회 시각: {new Date(snapshot.fetchedAt).toLocaleString()}
          </div>
        </div>
      )}

      {/* ── 심화 분석 (Top 쿼리 트렌드, 히트맵, CTR 스캐터, 기기/국가, 증감) ── */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-th-text">심화 분석 (Advanced Analytics)</div>
            <p className="mt-0.5 text-xs text-th-text-muted">
              위의 기간으로 Top 쿼리·트렌드·페이지 CTR·기기·국가·증감을 한꺼번에 로드합니다. 위 기본 조회와 독립적으로 실행됩니다.
            </p>
          </div>
          <button
            onClick={() => runAnalytics({ force: true })}
            disabled={analyticsBusy || !selectedSite}
            title="API 강제 호출 (캐시 무시)"
            className="bd-btn-primary rounded-lg px-4 py-2 text-sm"
          >
            {analyticsBusy ? "분석 중..." : "심화 분석 실행 (재조회)"}
          </button>
        </div>
        {analyticsMessage && (
          <div className="mb-3 rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
            {analyticsMessage}
          </div>
        )}

        {analytics && (
          <div className="space-y-4">
            {/* 기간 대비 */}
            <div className="grid gap-2 sm:grid-cols-4">
              <AnalyticsStat
                label="기간 클릭"
                value={analytics.totals.clicks.toLocaleString()}
                sub={`전기간 ${analytics.totalsPrev.clicks.toLocaleString()}`}
              />
              <AnalyticsStat
                label="기간 노출"
                value={analytics.totals.impressions.toLocaleString()}
                sub={`전기간 ${analytics.totalsPrev.impressions.toLocaleString()}`}
              />
              <AnalyticsStat
                label="클릭 증감"
                value={formatDelta(analytics.totals.clicks - analytics.totalsPrev.clicks)}
                sub={`전기간 대비 ${formatDeltaPct(analytics.totals.clicks, analytics.totalsPrev.clicks)}`}
                accent={analytics.totals.clicks - analytics.totalsPrev.clicks >= 0}
              />
              <AnalyticsStat
                label="비교 기간"
                value={`${analytics.previousStartDate.slice(5)} ~ ${analytics.previousEndDate.slice(5)}`}
                sub="직전 동일 길이 기간"
              />
            </div>

            {/* ⑥ 쿼리별 4분할 트렌드 */}
            {analytics.topQueries.length > 0 && analytics.queryTrend.length > 0 && (
              <QueryTrendQuad analytics={analytics} />
            )}

            {/* ⑦ 포지션 히트맵 */}
            {analytics.topQueries.length > 0 && analytics.queryTrend.length > 0 && (
              <PositionHeatmap analytics={analytics} />
            )}

            {/* ⑧ 페이지 CTR 스캐터 */}
            {analytics.topPages.length > 0 && (
              <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
                <div className="mb-2 text-sm font-semibold text-th-text">
                  페이지별 CTR 분포 (노출 vs CTR · 버블 크기 = 클릭)
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                      <XAxis
                        type="number"
                        dataKey="impressions"
                        name="노출"
                        stroke="var(--th-text-muted)"
                        fontSize={10}
                      />
                      <YAxis
                        type="number"
                        dataKey="ctrPct"
                        name="CTR(%)"
                        unit="%"
                        stroke="var(--th-text-muted)"
                        fontSize={10}
                      />
                      <ZAxis type="number" dataKey="clicks" range={[30, 400]} name="클릭" />
                      <Tooltip
                        cursor={{ strokeDasharray: "3 3" }}
                        contentStyle={{
                          background: "var(--th-card)",
                          border: "1px solid var(--th-border)",
                          fontSize: 12,
                        }}
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload as {
                            page: string;
                            impressions: number;
                            clicks: number;
                            ctrPct: number;
                            position: number;
                          };
                          return (
                            <div className="rounded-lg border border-th-border bg-th-card px-2.5 py-2 text-xs">
                              <div className="max-w-[320px] truncate font-medium text-th-text" title={d.page}>
                                {d.page}
                              </div>
                              <div className="mt-1 text-th-text-secondary">
                                노출 {d.impressions.toLocaleString()} · 클릭 {d.clicks.toLocaleString()} · CTR {d.ctrPct.toFixed(2)}% · 순위 {d.position.toFixed(1)}
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Scatter
                        data={analytics.topPages.map((p) => ({
                          ...p,
                          ctrPct: p.ctr * 100,
                        }))}
                        fill="#10a37f"
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-1 text-[10px] text-th-text-muted">
                  좌측 아래(노출 많음 + CTR 낮음) = 제목·스니펫 개선으로 클릭 회수 여지. 우측 위(노출 적음 + CTR 높음) = 이미 유효한 페이지, 노출 확대 대상.
                </p>
              </div>
            )}

            {/* ⑨ 기기 / 국가 도넛 */}
            <div className="grid gap-3 md:grid-cols-2">
              {analytics.byDevice.length > 0 && (
                <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
                  <div className="mb-2 text-sm font-semibold text-th-text">기기별 클릭 분포</div>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={analytics.byDevice}
                          dataKey="clicks"
                          nameKey="device"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={2}
                          label={(e: { name?: string; value?: number }) => `${e.name ?? ""} (${e.value ?? 0})`}
                        >
                          {analytics.byDevice.map((d) => (
                            <Cell
                              key={d.device}
                              fill={DEVICE_COLORS[d.device] ?? "#6b7280"}
                            />
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
                  <div className="mt-2 space-y-1 text-xs text-th-text-secondary">
                    {analytics.byDevice.map((d) => (
                      <div key={d.device} className="flex justify-between">
                        <span>{d.device}</span>
                        <span>클릭 {d.clicks.toLocaleString()} · CTR {(d.ctr * 100).toFixed(1)}% · 순위 {d.position.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {analytics.byCountry.length > 0 && (
                <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
                  <div className="mb-2 text-sm font-semibold text-th-text">국가별 클릭 Top 10</div>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={analytics.byCountry}
                          dataKey="clicks"
                          nameKey="country"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={2}
                          label={false}
                          labelLine={false}
                        >
                          {analytics.byCountry.map((_, i) => (
                            <Cell key={i} fill={COUNTRY_PALETTE[i % COUNTRY_PALETTE.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: "var(--th-card)",
                            border: "1px solid var(--th-border)",
                            fontSize: 12,
                          }}
                          formatter={(v: number | string | undefined, _name, entry) => {
                            const code = (entry?.payload as { country?: string } | undefined)?.country ?? "";
                            return [`${v ?? 0}`, countryFullName(code)];
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2 max-h-32 space-y-1 overflow-auto text-xs text-th-text-secondary">
                    {analytics.byCountry.map((c, i) => (
                      <div key={c.country} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="inline-block h-2 w-3 flex-shrink-0 rounded-sm"
                            style={{ background: COUNTRY_PALETTE[i % COUNTRY_PALETTE.length] }}
                          />
                          <span className="truncate">
                            {countryFullName(c.country)}
                            <span className="ml-1 text-[10px] text-th-text-muted">({c.country.toUpperCase()})</span>
                          </span>
                        </span>
                        <span className="flex-shrink-0 text-right">
                          클릭 {c.clicks.toLocaleString()} · CTR {(c.ctr * 100).toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ⑩ 쿼리 증감 Top/Bottom 10 */}
            {analytics.queryDelta.length > 0 && (
              <QueryDeltaTable deltas={analytics.queryDelta} />
            )}
          </div>
        )}
      </div>

      {/* AI Overview tracking (SERP scraping) */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-1 text-sm font-semibold text-th-text">
          AI Overview 인용 추적
        </div>
        <p className="mb-3 text-xs text-th-text-muted">
          Google 검색 결과 상단의 AI Overview 블록에 브랜드가 인용되는지 확인합니다.
          Bright Data SERP 스크래핑 기반.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">키워드</label>
            <input
              type="text"
              value={aiKeyword}
              onChange={(e) => setAiKeyword(e.target.value)}
              placeholder={brandName ? `예: ${brandName} 리뷰` : "예: 필라테스 자격증"}
              className="bd-input w-full rounded-lg p-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">국가</label>
            <select
              value={aiCountry}
              onChange={(e) => setAiCountry(e.target.value)}
              className="bd-input w-full rounded-lg p-2 text-sm"
            >
              <option value="kr">한국 (kr)</option>
              <option value="us">미국 (us)</option>
              <option value="jp">일본 (jp)</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={runAiOverview}
              disabled={aiBusy || !aiKeyword.trim()}
              className="bd-btn-primary w-full rounded-lg px-4 py-2 text-sm"
            >
              {aiBusy ? "조회 중..." : "AI Overview 조회"}
            </button>
          </div>
        </div>
        {aiMessage && (
          <div className="mt-3 rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
            {aiMessage}
          </div>
        )}

        {aiResult && !aiResult.exists && (
          <div className="mt-3 space-y-2">
            <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
              <a
                href={`https://www.google.com/search?q=${encodeURIComponent(aiKeyword)}&gl=${aiCountry}&hl=${aiCountry === "kr" ? "ko" : "en"}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-th-text-accent hover:underline"
              >
                ↗ Google에서 "{aiKeyword}" 직접 확인
              </a>
              <span className="ml-2 text-th-text-muted">
                브라우저에서 AI Overview가 실제로 노출되는지 대조하세요. 노출되지 않으면 Google 측 미생성이며 파서 문제가 아닙니다.
              </span>
            </div>
            {aiResult.rawPreview && (
              <details className="rounded-lg border border-th-border bg-th-card-alt">
                <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold uppercase tracking-wider text-th-text-muted">
                  ▸ Bright Data 응답 프리뷰 (최상위 필드 확인)
                </summary>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-th-border px-3 py-2 text-xs text-th-text-secondary">
                  {aiResult.rawPreview}
                </pre>
              </details>
            )}
          </div>
        )}

        {aiResult && aiResult.exists && (
          <div className="mt-3 space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <MiniStat
                label="AI Overview"
                value={aiResult.exists ? "생성됨" : "없음"}
                accent={aiResult.exists}
              />
              <MiniStat
                label="브랜드 멘션"
                value={aiResult.brandMentioned ? "있음" : "없음"}
                accent={aiResult.brandMentioned}
              />
              <MiniStat
                label="브랜드 인용"
                value={aiResult.brandCited ? "있음" : "없음"}
                accent={aiResult.brandCited}
              />
            </div>

            {aiResult.text && (
              <div className="rounded-lg border border-th-border bg-th-card-alt p-3 text-sm text-th-text leading-relaxed whitespace-pre-wrap">
                {aiResult.text}
              </div>
            )}

            {aiResult.sources.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-th-border">
                <table className="w-full text-sm">
                  <thead className="bg-th-card-alt text-xs uppercase tracking-wider text-th-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">도메인</th>
                      <th className="px-3 py-2 text-left">제목</th>
                      <th className="px-3 py-2 text-left">브랜드</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-th-border">
                    {aiResult.sources.map((s, i) => (
                      <tr key={i} className="bg-th-card">
                        <td className="px-3 py-2 text-th-text-muted">{i + 1}</td>
                        <td className="px-3 py-2 text-th-text">{s.domain}</td>
                        <td className="px-3 py-2 text-th-text-secondary">
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {s.title || s.url}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {s.isBrand ? (
                            <span className="rounded bg-th-accent/20 px-2 py-0.5 text-xs text-th-text-accent">
                              자사
                            </span>
                          ) : (
                            <span className="text-xs text-th-text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {aiResult.competitorsMentioned.length > 0 && (
              <div className="text-xs text-th-text-muted">
                경쟁사 멘션: {aiResult.competitorsMentioned.join(", ")}
              </div>
            )}

            <div className="text-xs text-th-text-muted">
              키워드: {aiResult.keyword} · 국가: {aiResult.country} · 조회 시각: {new Date(aiResult.fetchedAt).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{label}</div>
      <div
        className={`mt-0.5 text-base font-semibold ${
          accent ? "text-th-text-accent" : "text-th-text"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-th-text">{value}</div>
    </div>
  );
}

function dimensionLabel(d: Dimension): string {
  return { query: "쿼리", page: "페이지", device: "기기", country: "국가", date: "날짜" }[d];
}

function formatDelta(n: number): string {
  if (n > 0) return `+${n.toLocaleString()}`;
  if (n < 0) return n.toLocaleString();
  return "0";
}

function formatDeltaPct(cur: number, prev: number): string {
  if (prev === 0) return cur > 0 ? "신규" : "0%";
  const p = ((cur - prev) / prev) * 100;
  const sign = p > 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

function AnalyticsStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        accent === true
          ? "border-th-success/30 bg-th-success-soft"
          : accent === false
            ? "border-th-danger/30 bg-th-danger-soft"
            : "border-th-border bg-th-card-alt"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-th-text-muted">{label}</div>
      <div className="mt-0.5 text-base font-bold text-th-text">{value}</div>
      {sub && <div className="text-[10px] text-th-text-muted">{sub}</div>}
    </div>
  );
}

/** 쿼리별 4분할 트렌드 — Top 쿼리 선택 드롭다운 + clicks/impressions/ctr/position */
function QueryTrendQuad({ analytics }: { analytics: GscAnalytics }) {
  // Pivot queryTrend into date-indexed wide rows for Recharts
  const dates = Array.from(new Set(analytics.queryTrend.map((r) => r.date))).sort();
  const queryNames = analytics.topQueries.map((q) => q.query).slice(0, 10);

  function pivot(metric: "clicks" | "impressions" | "ctr" | "position") {
    return dates.map((date) => {
      const row: Record<string, number | string | null> = { date: date.slice(5) };
      for (const q of queryNames) {
        const match = analytics.queryTrend.find(
          (r) => r.date === date && r.query === q,
        );
        row[q] = match
          ? metric === "ctr"
            ? +(match.ctr * 100).toFixed(2)
            : metric === "position"
              ? +match.position.toFixed(1)
              : match[metric]
          : null;
      }
      return row;
    });
  }

  const clicksData = pivot("clicks");
  const imprData = pivot("impressions");
  const ctrData = pivot("ctr");
  const posData = pivot("position");

  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
      <div className="mb-2 text-sm font-semibold text-th-text">
        Top {queryNames.length} 쿼리 트렌드 (클릭 · 노출 · CTR · 순위)
      </div>
      {/* 공유 범례: 각 라인이 어떤 쿼리인지 색상으로 구분 */}
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-th-border bg-th-card px-2.5 py-1.5 text-[11px] text-th-text-secondary">
        {queryNames.map((q, i) => (
          <div key={q} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-5 rounded-sm"
              style={{ background: QUERY_LINE_COLORS[i % QUERY_LINE_COLORS.length] }}
            />
            <span className="max-w-[220px] truncate" title={q}>{q}</span>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <TinyLine title="클릭" data={clicksData} queries={queryNames} />
        <TinyLine title="노출" data={imprData} queries={queryNames} />
        <TinyLine title="CTR (%)" data={ctrData} queries={queryNames} valueSuffix="%" />
        <TinyLine title="평균 순위 (낮을수록 좋음)" data={posData} queries={queryNames} reverseY />
      </div>
      <p className="mt-2 text-[10px] text-th-text-muted">
        상단 색상 바가 각 쿼리를 나타냅니다. 4개 차트 모두 동일한 색상 매핑을 사용합니다. 선 위로 마우스를 올리면 쿼리별 값이 표시됩니다.
      </p>
    </div>
  );
}

function TinyLine({
  title,
  data,
  queries,
  valueSuffix,
  reverseY,
}: {
  title: string;
  data: Array<Record<string, number | string | null>>;
  queries: string[];
  valueSuffix?: string;
  reverseY?: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-2">
      <div className="mb-1 text-xs font-semibold text-th-text-secondary">{title}</div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
            <XAxis dataKey="date" stroke="var(--th-text-muted)" fontSize={9} />
            <YAxis
              stroke="var(--th-text-muted)"
              fontSize={9}
              reversed={reverseY}
              allowDecimals
            />
            <Tooltip
              contentStyle={{
                background: "var(--th-card)",
                border: "1px solid var(--th-border)",
                fontSize: 11,
              }}
              formatter={(v: number | string | undefined) =>
                valueSuffix ? `${v ?? ""}${valueSuffix}` : (v ?? "")
              }
            />
            {queries.map((q, i) => (
              <Line
                key={q}
                type="monotone"
                dataKey={q}
                stroke={QUERY_LINE_COLORS[i % QUERY_LINE_COLORS.length]}
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** 포지션 히트맵 — Top 쿼리 × 날짜 */
function PositionHeatmap({ analytics }: { analytics: GscAnalytics }) {
  const dates = Array.from(new Set(analytics.queryTrend.map((r) => r.date))).sort();
  const queries = analytics.topQueries.map((q) => q.query);

  function cellColor(position: number | null): string {
    if (position === null || position <= 0) return "var(--th-card-alt)";
    // 낮은 순위(=상위노출)일수록 진한 녹색
    if (position <= 3) return "rgba(16,163,127,0.95)";
    if (position <= 5) return "rgba(16,163,127,0.75)";
    if (position <= 10) return "rgba(16,163,127,0.55)";
    if (position <= 20) return "rgba(245,158,11,0.55)";
    if (position <= 50) return "rgba(245,158,11,0.3)";
    return "rgba(234,67,53,0.35)";
  }

  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
      <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-th-text">포지션 히트맵 (쿼리 × 날짜)</div>
        <div className="flex items-center gap-1 text-[10px] text-th-text-muted">
          상위 <span className="h-3 w-3 rounded-sm" style={{ background: "rgba(16,163,127,0.95)" }} />
          <span className="h-3 w-3 rounded-sm" style={{ background: "rgba(16,163,127,0.55)" }} />
          <span className="h-3 w-3 rounded-sm" style={{ background: "rgba(245,158,11,0.5)" }} />
          <span className="h-3 w-3 rounded-sm" style={{ background: "rgba(234,67,53,0.4)" }} />
          하위
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-[2px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-th-card-alt px-2 py-1 text-left text-[10px] text-th-text-muted">쿼리</th>
              {dates.map((d) => (
                <th key={d} className="px-1 py-1 text-[9px] text-th-text-muted">
                  {d.slice(5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {queries.map((q) => (
              <tr key={q}>
                <td
                  className="sticky left-0 max-w-[200px] truncate bg-th-card-alt px-2 py-1 text-xs text-th-text"
                  title={q}
                >
                  {q}
                </td>
                {dates.map((d) => {
                  const m = analytics.queryTrend.find(
                    (r) => r.date === d && r.query === q,
                  );
                  const pos = m ? m.position : null;
                  return (
                    <td
                      key={`${q}-${d}`}
                      className="h-6 w-6 rounded-sm text-center text-[9px] text-th-text"
                      style={{ backgroundColor: cellColor(pos) }}
                      title={`${q} · ${d} · 순위 ${pos !== null ? pos.toFixed(1) : "-"}`}
                    >
                      {pos !== null && pos > 0 ? Math.round(pos) : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QueryDeltaTable({
  deltas,
}: {
  deltas: GscAnalytics["queryDelta"];
}) {
  const sorted = [...deltas].sort((a, b) => b.delta - a.delta);
  const top = sorted.slice(0, 10);
  const bottom = sorted.slice(-10).reverse();

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <DeltaList title="클릭 증가 Top 10" rows={top} positive />
      <DeltaList title="클릭 감소 Top 10" rows={bottom} positive={false} />
    </div>
  );
}

function DeltaList({
  title,
  rows,
  positive,
}: {
  title: string;
  rows: GscAnalytics["queryDelta"];
  positive: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
      <div className="mb-2 text-sm font-semibold text-th-text">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-th-text-muted">해당 데이터 없음.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const color = r.delta >= 0 ? "text-th-success" : "text-th-danger";
            const pctText =
              r.deltaPct === null
                ? "신규"
                : `${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%`;
            const posDelta = r.currentPosition - r.previousPosition;
            const posArrow = posDelta < 0 ? "↑" : posDelta > 0 ? "↓" : "=";
            return (
              <div
                key={r.query}
                className="flex items-center gap-2 rounded-md border border-th-border bg-th-card px-2.5 py-1.5 text-xs"
              >
                <span
                  className="min-w-0 flex-1 truncate text-th-text-secondary"
                  title={r.query}
                >
                  {r.query}
                </span>
                <span className={`w-20 text-right font-semibold ${color}`}>
                  {formatDelta(r.delta)}
                </span>
                <span className={`w-16 text-right text-[10px] ${color}`}>{pctText}</span>
                <span className="w-20 text-right text-[10px] text-th-text-muted">
                  순위 {r.currentPosition.toFixed(1)} {posArrow}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 text-[10px] text-th-text-muted">
        {positive
          ? "→ 클릭이 늘어난 쿼리 — 현재 페이지/스니펫이 유효한 중, 추가 콘텐츠 확장 대상"
          : "→ 클릭이 줄어든 쿼리 — 랭킹 하락·AI Overview 대체 의심. 콘텐츠 재작성 후보"}
      </div>
    </div>
  );
}
