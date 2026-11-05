/**
 * citation-first-seen.ts — 인용 URL 의 「전체 기간 최초 인용 시점」 서버 메모리 캐시
 * (2026-11-05 — 인용 출처 「신규」 표시).
 *
 * 무엇을 담나:
 *   key(집계와 같은 canonicalUrlKey, 또는 전체 출처 표의 원본 URL) → AI 모델별 최초 인용 시각(ms).
 *   한 항목(entry)은 「워크스페이스 + 덩어리 종류(owned/mention/sources) + 보기(자동조사·브랜드 구분) +
 *   key 계산에 쓰는 브랜드 설정 지문」 하나에 대응한다. **AI 모델은 항목 안에서 나눠 담는다** —
 *   모델별로 항목을 따로 두면 같은 무거운 전체 기간 조회를 모델 수만큼 반복하게 되므로, 한 번 계산해
 *   모든 모델(과 "전체" = 모델별 값 중 최솟값)에 쓴다.
 *
 * 무효화 — 데이터 지문(값싼 조회, 운영 실측 약 50ms):
 *   지문 = 그 워크스페이스 runs 의 (보관 제외 건수, 가장 늦은 created_at).
 *   - 지문이 같으면 그대로 쓴다.
 *   - 건수·최댓값이 **새 행이 붙은 만큼만** 늘었으면(이전 최댓값 이후 행 수 = 건수 증가분) 그 뒤 행만
 *     다시 읽어 최솟값을 합친다(증분). 수집기가 주기적으로 행을 넣어도 전체 재계산을 하지 않게.
 *   - 그 밖의 변화(삭제·보관·되돌리기·과거 시각 삽입)는 전체 재계산.
 *   - 재채점처럼 행을 제자리에서 고치는 변경은 지문에 안 잡히므로 MAX_AGE(30분) 가 지나면 **뒤에서** 전체를
 *     새로 만든다(그동안 요청은 기존 값을 쓴다 — 화면이 수 초짜리 전체 계산을 기다리지 않게).
 *   지문 조회도 워크스페이스별로 짧게(15초) 기억하고 동시 요청은 한 번만 조회한다.
 *
 * 동시 요청: 같은 항목을 계산 중이면 기다렸다가 같은 결과를 쓴다(single-flight).
 * 메모리 상한: 항목 수 MAX_ENTRIES 를 넘으면 가장 오래 안 쓴 항목부터 버린다.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { runStatsQuery, schema } from "@/lib/server/db";
import { notArchivedRunCondition } from "@/lib/server/run-archive";

/** key → provider → 최초 인용 시각(ms) */
export type FirstSeenIndex = Map<string, Map<string, number>>;

/** 로더가 돌려주는 한 줄 — key 가 null 이면(정규화 실패·판정 탈락) 버린다 */
export type FirstSeenRow = { key: string | null; provider: string; ms: number };

/** 데이터 지문 */
export type RunsFingerprint = {
  /** 보관 제외 건수 */
  total: number;
  /** 가장 늦은 created_at (ms) — 없으면 0 */
  maxMs: number;
  /** 가장 늦은 created_at 의 DB 원문(마이크로초까지) — 증분 조회 경계에 그대로 쓴다 */
  maxText: string | null;
};

export function emptyFirstSeenIndex(): FirstSeenIndex {
  return new Map();
}

/** 최솟값으로 합친다 (멱등 — 같은 행을 두 번 넣어도 결과 같음) */
export function mergeFirstSeenRows(index: FirstSeenIndex, rows: Iterable<FirstSeenRow>): FirstSeenIndex {
  for (const r of rows) {
    if (!r.key || !Number.isFinite(r.ms)) continue;
    let byProvider = index.get(r.key);
    if (!byProvider) {
      byProvider = new Map();
      index.set(r.key, byProvider);
    }
    const prev = byProvider.get(r.provider);
    if (prev === undefined || r.ms < prev) byProvider.set(r.provider, r.ms);
  }
  return index;
}

/**
 * 최초 인용 시각 조회. provider 가 null 이면 모든 모델 중 가장 이른 값.
 * @returns 모르면 null (호출부는 "캐시 이후 처음 인용" 으로 보고 신규 처리)
 */
export function lookupFirstSeen(index: FirstSeenIndex, key: string, provider: string | null): number | null {
  const byProvider = index.get(key);
  if (!byProvider) return null;
  if (provider) return byProvider.get(provider) ?? null;
  let min: number | null = null;
  for (const v of byProvider.values()) if (min === null || v < min) min = v;
  return min;
}

/** 캐시 키 보조 — key 계산에 쓰이는 브랜드 설정이 바뀌면 다른 항목이 되게 짧은 지문을 만든다 */
export function configDigest(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export type FirstSeenCacheDeps = {
  fingerprint: (workspaceId: string) => Promise<RunsFingerprint>;
  /** maxText 이후(초과) 보관 제외 행 수 */
  countSince: (workspaceId: string, sinceText: string) => Promise<number>;
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
  fingerprintTtlMs?: number;
};

/**
 * 「runs 데이터에서 만든 값」 캐시 공통 틀 (2026-11-06 일반화 — 최초 인용 캐시와 인용 후보 행 캐시가 함께 쓴다).
 * 지문 무효화·증분·뒤에서 갱신·동시 요청 1회·항목 상한 규칙은 파일 머리말 그대로다.
 * V = 담아 두는 값, Row = 로더가 돌려주는 행. empty 로 빈 값을 만들고 merge 로 행을 합친다.
 */
export type RunsDerivedGetSpec<Row> = {
  /** 항목 키 — 워크스페이스·덩어리·보기·브랜드 설정 지문을 모두 담아야 한다 */
  cacheKey: string;
  workspaceId: string;
  /** since=null 이면 전체 기간, 아니면 그 시각(DB 원문) 초과 행만 */
  load: (since: string | null) => Promise<Row[]>;
};

export type RunsDerivedGetResult<V> = {
  index: V;
  /** 이번 요청에서 한 일 — 실측·관측용 */
  /** hit = 그대로 / stale = 오래돼 뒤에서 새로 만드는 중(이번엔 기존 값) / topup = 증분 / full = 전체 계산 */
  action: "hit" | "stale" | "topup" | "full";
};

type Entry<V> = {
  index: V;
  fp: RunsFingerprint;
  builtAt: number;
  lastUsed: number;
};

export function createRunsDerivedCache<V, Row>(
  deps: FirstSeenCacheDeps & { empty: () => V; merge: (value: V, rows: Row[]) => V },
) {
  const now = deps.now ?? (() => Date.now());
  const maxEntries = deps.maxEntries ?? 24;
  const maxAgeMs = deps.maxAgeMs ?? 30 * 60 * 1000;
  const fpTtlMs = deps.fingerprintTtlMs ?? 15 * 1000;

  const entries = new Map<string, Entry<V>>();
  const inflight = new Map<string, Promise<RunsDerivedGetResult<V>>>();
  /** 전체 계산 진행 중 — 뒤에서 갱신과 앞단 전체 계산이 같은 항목을 동시에 두 번 돌리지 않게 함께 쓴다 */
  const fullInflight = new Map<string, Promise<V>>();
  const fpMemo = new Map<string, { at: number; p: Promise<RunsFingerprint> }>();

  function getFingerprint(workspaceId: string): Promise<RunsFingerprint> {
    const m = fpMemo.get(workspaceId);
    if (m && now() - m.at < fpTtlMs) return m.p;
    const p = deps.fingerprint(workspaceId);
    fpMemo.set(workspaceId, { at: now(), p });
    // 실패한 지문은 기억하지 않는다 — 다음 요청이 다시 묻게
    p.catch(() => {
      if (fpMemo.get(workspaceId)?.p === p) fpMemo.delete(workspaceId);
    });
    return p;
  }

  function sameFp(a: RunsFingerprint, b: RunsFingerprint): boolean {
    return a.total === b.total && a.maxMs === b.maxMs && a.maxText === b.maxText;
  }

  function evict() {
    while (entries.size > maxEntries) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, e] of entries) {
        if (e.lastUsed < oldest) {
          oldest = e.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      entries.delete(oldestKey);
    }
  }

  /**
   * 오래된 항목을 뒤에서 새로 만든다 — 그동안 요청은 기존 항목(+증분)을 그대로 쓴다.
   * 전체 다시 만들기(운영 실측 수 초)를 화면 요청이 기다리지 않게 하려는 것이다. 같은 항목은 한 번만 돈다.
   */
  function runFull(spec: RunsDerivedGetSpec<Row>, fp: RunsFingerprint): Promise<V> {
    const running = fullInflight.get(spec.cacheKey);
    if (running) return running;
    const p = spec
      .load(null)
      .then((rows) => {
        const index = deps.merge(deps.empty(), rows);
        const at = now();
        // 그 사이 새 행이 붙었으면 다음 요청이 이 fp 기준으로 증분해 채운다(합치기는 멱등)
        entries.set(spec.cacheKey, { index, fp, builtAt: at, lastUsed: at });
        evict();
        return index;
      })
      .finally(() => {
        if (fullInflight.get(spec.cacheKey) === p) fullInflight.delete(spec.cacheKey);
      });
    fullInflight.set(spec.cacheKey, p);
    return p;
  }

  function refreshInBackground(spec: RunsDerivedGetSpec<Row>, fp: RunsFingerprint) {
    if (fullInflight.has(spec.cacheKey)) return;
    runFull(spec, fp).catch((err) => {
      console.error("[citation-first-seen] 뒤에서 새로 만들기 실패 — 기존 값을 계속 씀:", err);
    });
  }

  async function compute(spec: RunsDerivedGetSpec<Row>, fp: RunsFingerprint): Promise<RunsDerivedGetResult<V>> {
    const prev = entries.get(spec.cacheKey);
    const t = now();
    // 최대 보관 시간이 지났으면 뒤에서 새로 만들고, 이번 요청은 기존 값으로 진행한다
    const expired = !!prev && t - prev.builtAt >= maxAgeMs;
    if (prev && expired) refreshInBackground(spec, fp);
    if (prev && sameFp(prev.fp, fp)) {
      prev.lastUsed = t;
      return { index: prev.index, action: expired ? "stale" : "hit" };
    }
    // 증분 — 새 행이 뒤에 붙기만 했는지 건수로 확인한 뒤 그 뒤 행만 합친다
    if (prev && prev.fp.maxText && fp.maxMs > prev.fp.maxMs && fp.total > prev.fp.total) {
      const added = await deps.countSince(spec.workspaceId, prev.fp.maxText);
      if (prev.fp.total + added === fp.total) {
        const rows = await spec.load(prev.fp.maxText);
        prev.index = deps.merge(prev.index, rows);
        prev.fp = fp;
        prev.lastUsed = now();
        return { index: prev.index, action: "topup" };
      }
    }
    // 전체 계산 — 뒤에서 갱신이 이미 돌고 있으면 그 결과를 함께 기다린다
    const index = await runFull(spec, fp);
    return { index, action: "full" };
  }

  async function get(spec: RunsDerivedGetSpec<Row>): Promise<RunsDerivedGetResult<V>> {
    const fp = await getFingerprint(spec.workspaceId);
    const existing = inflight.get(spec.cacheKey);
    if (existing) return existing;
    const p = compute(spec, fp).finally(() => {
      if (inflight.get(spec.cacheKey) === p) inflight.delete(spec.cacheKey);
    });
    inflight.set(spec.cacheKey, p);
    return p;
  }

  return {
    get,
    /** 테스트·관측용 */
    size: () => entries.size,
    clear: () => {
      entries.clear();
      inflight.clear();
      fullInflight.clear();
      fpMemo.clear();
    },
  };
}

export type FirstSeenGetSpec = RunsDerivedGetSpec<FirstSeenRow>;
export type FirstSeenGetResult = RunsDerivedGetResult<FirstSeenIndex>;

/** 전체 기간 최초 인용 시점 캐시 — 공통 틀에 최솟값 합치기를 끼운 것 */
export function createFirstSeenCache(deps: FirstSeenCacheDeps) {
  return createRunsDerivedCache<FirstSeenIndex, FirstSeenRow>({
    ...deps,
    empty: emptyFirstSeenIndex,
    merge: mergeFirstSeenRows,
  });
}

export type FirstSeenCache = ReturnType<typeof createFirstSeenCache>;

/* ── DB 연결 ─────────────────────────────────────────────────────────────── */

type FpRow = { n: number | string; m: string | Date | null; mt: string | null };

/** 운영 지문 조회 — idx_runs_workspace_created 를 탄다 (운영 실측 약 50ms, 4.9만 행) */
export async function dbRunsFingerprint(workspaceId: string): Promise<RunsFingerprint> {
  const rows = (await runStatsQuery((q) =>
    q.execute<FpRow>(sql`
      SELECT count(*) FILTER (WHERE ${notArchivedRunCondition()})::int AS n,
             max(${schema.runs.createdAt}) AS m,
             max(${schema.runs.createdAt})::text AS mt
      FROM ${schema.runs}
      WHERE ${schema.runs.workspaceId} = ${workspaceId}
    `),
  )) as unknown as FpRow[];
  const r = rows[0];
  const m = r?.m ? new Date(r.m) : null;
  return {
    total: Number(r?.n ?? 0),
    maxMs: m && !Number.isNaN(m.getTime()) ? m.getTime() : 0,
    maxText: r?.mt ?? null,
  };
}

export async function dbCountSince(workspaceId: string, sinceText: string): Promise<number> {
  const rows = (await runStatsQuery((q) =>
    q.execute<{ n: number | string }>(sql`
      SELECT count(*)::int AS n
      FROM ${schema.runs}
      WHERE ${schema.runs.workspaceId} = ${workspaceId}
        AND ${notArchivedRunCondition()}
        AND ${schema.runs.createdAt} > ${sinceText}::timestamptz
    `),
  )) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

type GlobalWithFirstSeen = typeof globalThis & { __geotracker_first_seen_cache?: FirstSeenCache };

/** 서버 전역 캐시 하나 (개발 서버 HMR 에서도 유지) */
export function getFirstSeenCache(): FirstSeenCache {
  const g = globalThis as GlobalWithFirstSeen;
  if (!g.__geotracker_first_seen_cache) {
    g.__geotracker_first_seen_cache = createFirstSeenCache({
      fingerprint: dbRunsFingerprint,
      countSince: dbCountSince,
    });
  }
  return g.__geotracker_first_seen_cache;
}
