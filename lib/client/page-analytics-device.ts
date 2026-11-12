/**
 * page-analytics-device.ts — 페이지·클릭 통계 「어떤 기기로 보나」 화면 계산 (순수 함수 · 화면 전용)
 *   task_id: device-tracking_261112 (plan-v2 §5-2)
 *
 * 규칙:
 *   · 우리 통계 비율의 분모는 기기 정보가 있는 방문(모바일·태블릿·PC·알 수 없음)이다. 「기기 정보 없음」은 분모에서 뺀다.
 *   · 서버가 알 수 없는 개수(null)를 주면 0 으로 바꾸지 않는다 — 그 칸과, 분모가 흔들리는 비율은 「—」다.
 *   · 구글 애널리틱스 비율은 세션 하나로만 낸다.
 *   · 섹션·소개영상 단계의 기기별 비율 = 그 대표 기기로 그 섹션을 본 방문 ÷ 그 대표 기기로 그 화면을 본 방문.
 *   · 백분율 ×100 은 화면의 fmtPct 한 곳에서만 한다 — 여기서는 0～1 을 돌려준다.
 */

export type DeviceCode = "m" | "t" | "d" | "x" | "-";

export type DeviceRow = { device: DeviceCode; visitCount: number | null; viewCount: number | null };

export type DeviceVisits = {
  m: number | null;
  t: number | null;
  d: number | null;
  x: number | null;
  none: number | null;
};

export type ItemDeviceRow = {
  clickTarget: string;
  clickKind: string;
  device: DeviceCode;
  clickedVisitCount: number | null;
  clickCount: number | null;
};

export const DEVICE_LABEL: Record<Exclude<DeviceCode, "-">, string> = {
  m: "모바일",
  t: "태블릿",
  d: "PC",
  x: "알 수 없음",
};

/** 기기 4색 — 탭의 색 변수 안에서 고른다. */
export const DEVICE_COLOR: Record<Exclude<DeviceCode, "-">, string> = {
  m: "var(--th-accent)",
  t: "var(--th-success)",
  d: "var(--th-warning)",
  x: "var(--th-text-muted)",
};

const KNOWN: Exclude<DeviceCode, "-">[] = ["m", "t", "d", "x"];

/** 쓸 수 있는 개수인가(0 이상 유한수). null·음수·숫자 아님은 「알 수 없음」. */
export const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export type DeviceSlice = {
  key: string;
  label: string;
  color: string;
  /** 방문 수(우리) 또는 세션 수(구글). null = 알 수 없음. */
  count: number | null;
  /** 조회 수(우리) 또는 화면 조회 수(구글). null = 알 수 없음. */
  views: number | null;
  /** 0～1. 분모가 0 이거나 알 수 없으면 null. */
  share: number | null;
};

/**
 * 우리 통계 — 기기별 조각(모바일·태블릿·PC·알 수 없음)과 기기 정보 없는 방문 수.
 * complete=false 면 기기 정보가 있는 방문 중 알 수 없는 칸이 있어 비율을 낼 수 없다(전부 null).
 */
export function ourDeviceSlices(devices: DeviceRow[] | null | undefined): {
  slices: DeviceSlice[];
  knownVisits: number;
  noneVisits: number | null;
  complete: boolean;
} {
  const by = new Map<DeviceCode, DeviceRow>();
  for (const r of devices ?? []) by.set(r.device, r);
  const complete = KNOWN.every((k) => !by.has(k) || isCount(by.get(k)!.visitCount));
  const knownVisits = KNOWN.reduce((s, k) => {
    const v = by.get(k)?.visitCount;
    return s + (isCount(v) ? v : 0);
  }, 0);
  const slices: DeviceSlice[] = [];
  for (const k of KNOWN) {
    const r = by.get(k);
    if (!r) continue;
    const count = isCount(r.visitCount) ? r.visitCount : null;
    const views = isCount(r.viewCount) ? r.viewCount : null;
    if (count === 0 && views === 0) continue;
    slices.push({
      key: k,
      label: DEVICE_LABEL[k],
      color: DEVICE_COLOR[k],
      count,
      views,
      share: complete && count !== null && knownVisits > 0 ? count / knownVisits : null,
    });
  }
  const none = by.get("-");
  return { slices, knownVisits, noneVisits: none ? (isCount(none.visitCount) ? none.visitCount : null) : 0, complete };
}

export type Ga4Row = { category: string; label: string; sessions: number; screenPageViews: number };

const GA_COLOR: Record<string, string> = {
  mobile: DEVICE_COLOR.m,
  tablet: DEVICE_COLOR.t,
  desktop: DEVICE_COLOR.d,
};

/** 구글 애널리틱스 — 세션 기준 조각. 행은 parseGa4Response 를 지난 값이라 개수가 모두 숫자다. */
export function gaDeviceSlices(rows: Ga4Row[] | null | undefined): { slices: DeviceSlice[]; totalSessions: number } {
  const list = rows ?? [];
  const totalSessions = list.reduce((s, r) => s + r.sessions, 0);
  const slices = list
    .filter((r) => r.sessions > 0 || r.screenPageViews > 0)
    .map((r) => ({
      key: r.category,
      label: r.label,
      color: GA_COLOR[r.category] ?? DEVICE_COLOR.x,
      count: r.sessions,
      views: r.screenPageViews,
      share: totalSessions > 0 ? r.sessions / totalSessions : null,
    }));
  return { slices, totalSessions };
}

/** 화면 줄의 모바일 비율(0～1) — 분모는 그 화면에서 기기 정보가 있는 방문. 알 수 없는 칸이 있거나 정보가 없으면 null. */
export function mobileShare(dv: DeviceVisits | null | undefined): number | null {
  if (!dv) return null;
  if (!KNOWN.every((k) => isCount(dv[k]))) return null;
  const known = (dv.m as number) + (dv.t as number) + (dv.d as number) + (dv.x as number);
  return known > 0 ? (dv.m as number) / known : null;
}

/** 화면 펼침 한 줄용 조각 — 비율 큰 순. 비율을 낼 수 없으면 빈 배열. */
export function deviceVisitParts(devices: DeviceRow[] | null | undefined): { label: string; share: number }[] {
  const { slices } = ourDeviceSlices(devices);
  return slices
    .filter((s) => s.share !== null && (s.count ?? 0) > 0)
    .map((s) => ({ label: s.label, share: s.share as number }))
    .sort((a, b) => b.share - a.share);
}

export type DeviceFilter = "all" | "m" | "d";

/** 그 화면을 그 대표 기기로 본 방문 수. 기기 칸이 없거나 그 기기 개수를 알 수 없으면 null, 줄이 없으면 0. */
export function pageVisitsForDevice(devices: DeviceRow[] | null | undefined, filter: Exclude<DeviceFilter, "all">): number | null {
  if (!devices) return null;
  const row = devices.find((r) => r.device === filter);
  if (!row) return 0;
  return isCount(row.visitCount) ? row.visitCount : null;
}

/**
 * 섹션·소개영상 줄을 그 기기만의 숫자로 바꾼다 — 기존 표 계산을 그대로 쓰게 같은 모양으로 돌려준다.
 * clickVisitCount = 그 대표 기기로 누른(본) 방문, clickRate = ÷ 그 대표 기기로 그 화면을 본 방문(0 이면 null).
 * 분모나 필요한 개수를 알 수 없으면 null(호출부는 기기별 보기를 쓰지 않는다).
 */
export function rowsForDevice<T extends { clickTarget: string; clickKind: string; clickVisitCount: number; clickCount: number; clickRate: number | null }>(
  rows: T[],
  itemDevices: ItemDeviceRow[] | null | undefined,
  filter: Exclude<DeviceFilter, "all">,
  pageVisits: number | null,
): T[] | null {
  if (pageVisits === null || !itemDevices) return null;
  const out: T[] = [];
  for (const r of rows) {
    const hit = itemDevices.find((x) => x.clickTarget === r.clickTarget && x.clickKind === r.clickKind && x.device === filter);
    if (!hit) continue;
    if (!isCount(hit.clickedVisitCount) || !isCount(hit.clickCount)) return null;
    if (hit.clickedVisitCount === 0 && hit.clickCount === 0) continue;
    out.push({
      ...r,
      clickVisitCount: hit.clickedVisitCount,
      clickCount: hit.clickCount,
      clickRate: pageVisits > 0 ? hit.clickedVisitCount / pageVisits : null,
    });
  }
  return out;
}

/* ── 구글 애널리틱스 칸 ─────────────────────────────────────────────────── */

export type Ga4Response =
  | { status: "ok"; startDate: string; endDate: string; rows: Ga4Row[]; timeZone?: string }
  | { status: "not_connected" }
  | { status: "unavailable" };

/** 우리 앱 쪽에서 난 실패 — 구글 오류와 섞지 않는다. */
export type Ga4ClientFailure = "app_login" | "app_forbidden" | "rate_limited";

export type Ga4PanelState = "loading" | "ok" | "empty" | "not_connected" | "unavailable" | Ga4ClientFailure;

/** 구글 칸의 화면 상태. 우리 앱 쪽 실패가 먼저다. 응답이 계약과 다르면 「불러오지 못함」. */
export function ga4PanelState(
  res: Ga4Response | null | undefined,
  loading: boolean,
  failure: Ga4ClientFailure | null = null,
): Ga4PanelState {
  if (loading) return "loading";
  if (failure) return failure;
  if (!res || typeof res !== "object") return "unavailable";
  if (res.status === "not_connected") return "not_connected";
  if (res.status !== "ok" || !Array.isArray(res.rows)) return "unavailable";
  return gaDeviceSlices(res.rows).totalSessions > 0 ? "ok" : "empty";
}

/** 응답 원문을 화면 계약으로 좁힌다(모르는 모양·잘못된 개수는 unavailable — 0 으로 바꾸지 않는다). */
export function parseGa4Response(body: unknown): Ga4Response {
  if (!body || typeof body !== "object") return { status: "unavailable" };
  const b = body as { status?: unknown; rows?: unknown; startDate?: unknown; endDate?: unknown };
  if (b.status === "not_connected") return { status: "not_connected" };
  if (b.status !== "ok" || !Array.isArray(b.rows)) return { status: "unavailable" };
  const rows: Ga4Row[] = [];
  for (const r of b.rows as unknown[]) {
    if (!r || typeof r !== "object") continue;
    const x = r as { category?: unknown; label?: unknown; sessions?: unknown; screenPageViews?: unknown };
    const category = typeof x.category === "string" ? x.category : "";
    if (!category) continue;
    const sessions = Number(x.sessions);
    const screenPageViews = Number(x.screenPageViews);
    if (!isCount(sessions) || !isCount(screenPageViews)) return { status: "unavailable" };
    rows.push({ category, label: typeof x.label === "string" && x.label ? x.label : `기타(${category})`, sessions, screenPageViews });
  }
  return {
    status: "ok",
    startDate: typeof b.startDate === "string" ? b.startDate : "",
    endDate: typeof b.endDate === "string" ? b.endDate : "",
    rows,
  };
}

/** 지금 보고 있는 구글 칸 — 어느 기간의 결과인지 함께 들고 있다. */
export type Ga4View = {
  key: string;
  loading: boolean;
  res: Ga4Response | null;
  failure: Ga4ClientFailure | null;
};

export const ga4RangeKey = (fromKst: string, toKst: string): string => `${fromKst}|${toKst}`;

/**
 * 지금 기간에 그려도 되는 구글 칸. 저장된 결과가 다른 기간 것이면 「불러오는 중」으로 본다(옛 기간 숫자를 그리지 않는다).
 * 정상 응답의 날짜가 지금 기간과 다르면 「불러오지 못함」으로 본다.
 */
export function ga4ViewFor(
  view: Ga4View | null,
  fromKst: string,
  toKst: string,
): { res: Ga4Response | null; loading: boolean; failure: Ga4ClientFailure | null } {
  if (!view || view.key !== ga4RangeKey(fromKst, toKst) || view.loading) return { res: null, loading: true, failure: null };
  if (view.res && view.res.status === "ok" && (view.res.startDate !== fromKst || view.res.endDate !== toKst))
    return { res: { status: "unavailable" }, loading: false, failure: null };
  return { res: view.res, loading: false, failure: view.failure };
}

type FetchLike = (input: string, init: { credentials: "include"; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * 구글 칸 불러오기 — 기간이 바뀌면 진행 중 요청을 취소하고, 마지막 요청의 응답만 알린다.
 * 시작할 때 그 기간의 「불러오는 중」을 먼저 알린다. 401·403·429 는 우리 앱 쪽 실패로 따로 알린다.
 */
export function createGa4Loader(deps: { fetchImpl: FetchLike; basePath: string; onChange: (v: Ga4View) => void }): {
  load: (fromKst: string, toKst: string) => Promise<void>;
  dispose: () => void;
} {
  let seq = 0;
  let current: AbortController | null = null;
  let disposed = false;

  async function load(fromKst: string, toKst: string): Promise<void> {
    if (disposed) return;
    current?.abort();
    const ac = new AbortController();
    current = ac;
    const ticket = ++seq;
    const key = ga4RangeKey(fromKst, toKst);
    deps.onChange({ key, loading: true, res: null, failure: null });

    let res: Ga4Response = { status: "unavailable" };
    let failure: Ga4ClientFailure | null = null;
    try {
      const qs = new URLSearchParams({ fromKst, toKst }).toString();
      const r = await deps.fetchImpl(`${deps.basePath}/api/admin/page-analytics/ga4-device?${qs}`, {
        credentials: "include",
        signal: ac.signal,
      });
      if (r.status === 401) failure = "app_login";
      else if (r.status === 403) failure = "app_forbidden";
      else if (r.status === 429) failure = "rate_limited";
      else if (r.ok) res = parseGa4Response(await r.json().catch(() => null));
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
    }
    if (disposed || ticket !== seq) return;
    deps.onChange({ key, loading: false, res: failure ? null : res, failure });
  }

  return {
    load,
    dispose: () => {
      disposed = true;
      seq++;
      current?.abort();
    },
  };
}
