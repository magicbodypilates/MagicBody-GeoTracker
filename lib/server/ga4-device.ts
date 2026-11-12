/**
 * ga4-device.ts — 구글 애널리틱스 「기기 구분(deviceCategory)」 사이트 전체 조회 (서버 전용)
 *   task_id: device-tracking_261112 (plan-v2 §2-D6)
 *
 * 계약:
 *   · 지표는 sessions·screenPageViews. 비율은 화면이 sessions 하나로만 낸다(사용자 수는 쓰지 않는다).
 *   · 기간은 화면이 고른 KST 날짜 그대로(속성 시간대 Asia/Seoul).
 *   · 토큰 갱신을 포함한 전체 10초 기한. 구글 요청 자체도 8초 제한·자동 재시도 끔.
 *   · 결과 상태: ok / not_connected(토큰 없음·invalid_grant) / unavailable(할당량·시간 초과·그 밖).
 *   · 서버 기록에는 오류 분류 이름·HTTP 상태만 남긴다. 구글 오류 원문은 남기지 않는다.
 *   · 성공 결과만 10분 보관(열쇠 = 속성 ID + 시작일 + 종료일). 같은 열쇠의 동시 요청은 하나로 합친다.
 *   · 권한 검사는 호출하는 경로가 먼저 한다 — 이 모듈은 권한을 모른다.
 */

import { google } from "googleapis";
import { getAuthedClient } from "./gsc-client";
import { rowValue, rowMetric, type RunReportRow } from "./ga4-report-utils";

export const GA4_DEVICE_DEADLINE_MS = 10_000;
export const GA4_DEVICE_REQUEST_TIMEOUT_MS = 8_000;
export const GA4_DEVICE_CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 64;

export type Ga4DeviceRow = {
  /** 구글 분류 원문(소문자). */
  category: string;
  /** 화면 이름 — 모바일 · 태블릿 · PC · 기타(TV) · 알 수 없음 · 기타(원래 이름). */
  label: string;
  sessions: number;
  screenPageViews: number;
};

export type Ga4DeviceResult =
  | { status: "ok"; startDate: string; endDate: string; rows: Ga4DeviceRow[]; timeZone: "Asia/Seoul" }
  | { status: "not_connected" }
  | { status: "unavailable" };

export type Ga4ErrorClass = {
  status: "not_connected" | "unavailable";
  /** 서버 기록용 분류 이름. */
  kind: "no_token" | "invalid_grant" | "quota" | "permission" | "upstream" | "timeout" | "other";
  httpStatus: number | null;
};

const KNOWN_CATEGORIES: Record<string, { label: string; order: number }> = {
  mobile: { label: "모바일", order: 0 },
  tablet: { label: "태블릿", order: 1 },
  desktop: { label: "PC", order: 2 },
  "smart tv": { label: "기타(TV)", order: 3 },
  "(not set)": { label: "알 수 없음", order: 5 },
};

/** 우리 기한을 넘겼다는 표식 오류. */
export class Ga4DeadlineError extends Error {
  constructor() {
    super("ga4_device_deadline");
    this.name = "Ga4DeadlineError";
  }
}

function httpStatusOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e.response?.status, e.status, e.code]) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  return null;
}

function textOf(err: unknown): string {
  if (!err || typeof err !== "object") return typeof err === "string" ? err : "";
  const e = err as { message?: unknown; code?: unknown; name?: unknown; response?: { data?: unknown } };
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.code === "string") parts.push(e.code);
  if (typeof e.name === "string") parts.push(e.name);
  const data = e.response?.data;
  if (typeof data === "string") parts.push(data);
  else if (data && typeof data === "object") {
    const d = data as { error?: unknown; error_description?: unknown };
    if (typeof d.error === "string") parts.push(d.error);
    else if (d.error && typeof d.error === "object") {
      const inner = d.error as { status?: unknown; message?: unknown };
      if (typeof inner.status === "string") parts.push(inner.status);
      if (typeof inner.message === "string") parts.push(inner.message);
    }
  }
  return parts.join(" ").toLowerCase();
}

/** 구글 쪽 실패를 화면 상태로 나눈다. 원문은 돌려주지 않는다. */
export function classifyGa4Error(err: unknown): Ga4ErrorClass {
  const httpStatus = httpStatusOf(err);
  const text = textOf(err);

  if (err instanceof Ga4DeadlineError || /timeout|timed out|etimedout|econnaborted|aborterror|aborted/.test(text))
    return { status: "unavailable", kind: "timeout", httpStatus };
  if (text.includes("invalid_grant")) return { status: "not_connected", kind: "invalid_grant", httpStatus };
  if (text.includes("인증이 필요") || text.includes("refresh_token") || text.includes("no refresh token"))
    return { status: "not_connected", kind: "no_token", httpStatus };
  if (httpStatus === 429 || text.includes("resource_exhausted") || text.includes("quota"))
    return { status: "unavailable", kind: "quota", httpStatus };
  if (httpStatus === 403) return { status: "unavailable", kind: "permission", httpStatus };
  if (httpStatus !== null && httpStatus >= 500) return { status: "unavailable", kind: "upstream", httpStatus };
  return { status: "unavailable", kind: "other", httpStatus };
}

/** 구글 응답 행 → 화면 행. 같은 분류는 합치고, 정해진 순서(모바일·태블릿·PC·TV·처음 보는 값·알 수 없음)로 둔다. */
export function normalizeGa4DeviceRows(rows: ReadonlyArray<RunReportRow> | null | undefined): Ga4DeviceRow[] {
  const byCategory = new Map<string, Ga4DeviceRow>();
  for (const r of rows ?? []) {
    const raw = rowValue(r, 0).trim();
    const category = raw.toLowerCase() || "(not set)";
    const sessions = Math.max(0, Math.round(rowMetric(r, 0)));
    const screenPageViews = Math.max(0, Math.round(rowMetric(r, 1)));
    const known = KNOWN_CATEGORIES[category];
    const prev = byCategory.get(category);
    if (prev) {
      prev.sessions += sessions;
      prev.screenPageViews += screenPageViews;
    } else {
      byCategory.set(category, {
        category,
        label: known ? known.label : `기타(${raw || category})`,
        sessions,
        screenPageViews,
      });
    }
  }
  const order = (c: string) => KNOWN_CATEGORIES[c]?.order ?? 4;
  return [...byCategory.values()].sort((a, b) => order(a.category) - order(b.category) || b.sessions - a.sessions);
}

/* ── 조회 ─────────────────────────────────────────────────────────────── */

type RunReportFn = (args: {
  propertyId: string;
  startDate: string;
  endDate: string;
  signal: AbortSignal;
}) => Promise<ReadonlyArray<RunReportRow> | null | undefined>;

export type Ga4DeviceDeps = {
  runReport?: RunReportFn;
  now?: () => number;
  deadlineMs?: number;
  log?: (line: string) => void;
};

/** 실제 구글 호출 — 토큰 갱신 + runReport. 요청마다 8초 제한·재시도 끔·취소 신호. */
const defaultRunReport: RunReportFn = async ({ propertyId, startDate, endDate, signal }) => {
  const auth = await getAuthedClient();
  const analytics = google.analyticsdata({ version: "v1beta", auth });
  const res = await analytics.properties.runReport(
    {
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "deviceCategory" }],
        metrics: [{ name: "sessions" }, { name: "screenPageViews" }],
        keepEmptyRows: false,
      },
    },
    { timeout: GA4_DEVICE_REQUEST_TIMEOUT_MS, retry: false, signal },
  );
  return (res.data.rows ?? []) as ReadonlyArray<RunReportRow>;
};

const cache = new Map<string, { expiresAt: number; value: Ga4DeviceResult }>();
const inflight = new Map<string, Promise<Ga4DeviceResult>>();

/** 시험 전용 — 보관·진행 중 요청을 비운다. */
export function resetGa4DeviceCacheForTest(): void {
  cache.clear();
  inflight.clear();
}

function cacheKey(propertyId: string, startDate: string, endDate: string): string {
  return `${propertyId}|${startDate}|${endDate}`;
}

function pruneCache(now: number): void {
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

async function runWithDeadline(
  deps: Required<Pick<Ga4DeviceDeps, "runReport" | "deadlineMs">>,
  propertyId: string,
  startDate: string,
  endDate: string,
): Promise<ReadonlyArray<RunReportRow> | null | undefined> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Ga4DeadlineError());
    }, deps.deadlineMs);
  });
  try {
    return await Promise.race([deps.runReport({ propertyId, startDate, endDate, signal: ac.signal }), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 사이트 전체 기기 구분 조회. 실패는 예외가 아니라 상태로 돌려준다.
 * 성공만 보관하고, 같은 열쇠의 동시 요청은 하나의 구글 호출로 합친다.
 */
export async function fetchDeviceCategoryReport(
  params: { propertyId: string; startDate: string; endDate: string },
  deps: Ga4DeviceDeps = {},
): Promise<Ga4DeviceResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const key = cacheKey(params.propertyId, params.startDate, params.endDate);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<Ga4DeviceResult> => {
    try {
      const rows = await runWithDeadline(
        { runReport: deps.runReport ?? defaultRunReport, deadlineMs: deps.deadlineMs ?? GA4_DEVICE_DEADLINE_MS },
        params.propertyId,
        params.startDate,
        params.endDate,
      );
      const value: Ga4DeviceResult = {
        status: "ok",
        startDate: params.startDate,
        endDate: params.endDate,
        rows: normalizeGa4DeviceRows(rows),
        timeZone: "Asia/Seoul",
      };
      pruneCache(now());
      cache.set(key, { expiresAt: now() + GA4_DEVICE_CACHE_TTL_MS, value });
      return value;
    } catch (err) {
      const c = classifyGa4Error(err);
      log(`[ga4-device] ${c.status} kind=${c.kind} http=${c.httpStatus ?? "-"}`);
      return { status: c.status };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}
