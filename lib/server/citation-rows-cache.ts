/**
 * citation-rows-cache.ts — 「내 사이트 인용 URL」·「브랜드 언급 출처」의 **인용 후보 행** 서버 메모리 캐시
 * (2026-11-06 — 90일·전체 기간 속도).
 *
 * 왜: 두 목록은 요청마다 기간 안 모든 인용을 펼쳐 패턴과 비교한다. 패턴 비교를 줄여도(빠른 사전 필터)
 * 운영 DB 에서 펼치기 자체가 90일 약 1초·전체 약 1.5～2.5초 걸린다(실측). 그래서 보기(자동조사·질문 유형)별
 * **전체 이력의 후보 행**을 한 번 읽어 두고, 기간·AI 모델은 메모리에서 거른다. 7·30·90일·전체·직접 선택·
 * 모델을 오가도 DB 를 다시 펼치지 않는다.
 *
 * 무효화·증분·뒤에서 갱신·동시 요청 1회·항목 상한: 최초 인용 캐시와 같은 공통 틀(createRunsDerivedCache)과
 * 같은 데이터 지문(보관 제외 건수 + 최신 created_at)을 쓴다. 새 행만 붙었으면 그 뒤 행만 읽어 뒤에 붙인다.
 *
 * 결과가 SQL 경로와 같은 이유:
 *   - 캐시 행은 SQL 경로와 같은 조건(buildRunStatsWhereClause — 보기·저품질·보관 제외, 같은 사전 필터)으로 읽되
 *     기간만 넓게(전체 이력) 읽는다. 기간·모델 거름은 SQL 의 `created_at >= from AND < to` · `provider =` 와 같다.
 *   - 행 상한이 없으므로 SQL 경로의 「5만 줄 상한」으로 빠지던 인용도 들어간다(개선).
 *   - 집계는 기존 순수함수 그대로 — 집계는 행 순서와 무관하다.
 * 캐시를 못 쓰면(로더 실패·행이 너무 많음) 라우트가 기존 SQL 경로로 답한다.
 */

import { sql, type SQL } from "drizzle-orm";
import { runStatsQuery, schema } from "@/lib/server/db";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import {
  configDigest,
  createRunsDerivedCache,
  dbCountSince,
  dbRunsFingerprint,
  type FirstSeenCacheDeps,
  type RunsDerivedGetSpec,
} from "@/lib/server/citation-first-seen";
import { FIRST_SEEN_HISTORY_START } from "@/lib/server/citation-first-seen-loaders";

/** 캐시에 담는 인용 후보 한 줄 (라우트의 ExpandedRow 와 같은 모양) */
export type CandidateRow = {
  run_id: string;
  url: string | null;
  domain: string | null;
  title?: string | null;
  description?: string | null;
  prompt_text: string | null;
  provider: string | null;
  created_at: string | Date;
};

/** 한 항목이 담을 수 있는 최대 행 수 — 넘으면 캐시하지 않고 SQL 경로로 답한다(메모리 상한) */
export const CANDIDATE_CACHE_MAX_ROWS = 300_000;

export class CandidateCacheTooLargeError extends Error {
  constructor(rows: number) {
    super(`인용 후보 행 ${rows}줄 — 캐시 상한 초과`);
  }
}

function toMs(v: string | Date): number {
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 캐시 행을 기간·AI 모델로 거른다 — SQL 의 `created_at >= from AND created_at < to [AND provider = p]` 와 같다.
 */
export function filterCandidateRows(
  rows: readonly CandidateRow[],
  from: Date,
  to: Date,
  provider: string | null,
): CandidateRow[] {
  const f = from.getTime();
  const t = to.getTime();
  const out: CandidateRow[] = [];
  for (const r of rows) {
    const ms = toMs(r.created_at);
    if (ms < f || ms >= t) continue;
    if (provider && r.provider !== provider) continue;
    out.push(r);
  }
  return out;
}

/** (run_id, url, domain) 단위 중복 제거 — 내 사이트 브랜드·유튜브 두 조회가 겹칠 때(라우트 규칙과 같음) */
export function dedupCandidateRows(rows: readonly CandidateRow[]): CandidateRow[] {
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const r of rows) {
    const k = `${r.run_id}\u0000${r.url ?? ""}\u0000${r.domain ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** 캐시 값(행 배열)마다 이미 담긴 응답(run) id — 증분 합치기를 멱등으로 만든다 (검수 S3) */
const runIdsOf = new WeakMap<CandidateRow[], Set<string>>();

function emptyRows(): CandidateRow[] {
  const v: CandidateRow[] = [];
  runIdsOf.set(v, new Set());
  return v;
}

/**
 * 행 합치기 — **이미 담긴 응답(run)의 행은 다시 붙이지 않는다**(검수 S3). 응답의 인용은 늘 응답 단위로 한꺼번에
 * 읽히므로, 전체 읽기 도중 들어온 응답이 다음 증분에 또 와도 한 번만 남는다. 같은 응답 안의 여러 줄(같은 주소를
 * 두 번 인용 등)은 SQL 경로와 같게 그대로 둔다.
 */
export function appendCandidateRows(value: CandidateRow[], rows: CandidateRow[]): CandidateRow[] {
  let ids = runIdsOf.get(value);
  if (!ids) {
    ids = new Set(value.map((r) => r.run_id));
    runIdsOf.set(value, ids);
  }
  const fresh = rows.filter((r) => !ids!.has(r.run_id));
  if (value.length + fresh.length > CANDIDATE_CACHE_MAX_ROWS) {
    throw new CandidateCacheTooLargeError(value.length + fresh.length);
  }
  for (const r of fresh) value.push(r);
  for (const r of fresh) ids.add(r.run_id);
  return value;
}

/** 상한 초과 판정을 기억하는 시간 — 그동안은 전량 조회를 다시 시도하지 않고 바로 SQL 경로로 답한다 (검수 S4) */
export const TOO_LARGE_RETRY_MS = 10 * 60 * 1000;

type GlobalWithRowsCache = typeof globalThis & {
  __geotracker_citation_rows_cache?: ReturnType<typeof withTooLargeMemory>;
};

export function createCandidateRowsCache(deps: FirstSeenCacheDeps) {
  return createRunsDerivedCache<CandidateRow[], CandidateRow>({
    maxEntries: 8,
    ...deps,
    empty: emptyRows,
    merge: appendCandidateRows,
  });
}

/**
 * 상한 초과를 기억하는 포장 (검수 S4). 한 번 넘친 항목은 TOO_LARGE_RETRY_MS 동안 곧바로 거부해, 요청마다
 * 전량을 다시 읽어 메모리·DB 를 쓰지 않게 한다. 조회 자체도 SQL 에서 상한+1 줄로 끊는다(아래 로더).
 */
export function withTooLargeMemory(
  inner: ReturnType<typeof createCandidateRowsCache>,
  now: () => number = () => Date.now(),
) {
  const until = new Map<string, number>();
  return {
    async get(spec: RunsDerivedGetSpec<CandidateRow>) {
      const t = until.get(spec.cacheKey);
      if (t !== undefined && now() < t) throw new CandidateCacheTooLargeError(CANDIDATE_CACHE_MAX_ROWS + 1);
      try {
        return await inner.get(spec);
      } catch (err) {
        if (err instanceof CandidateCacheTooLargeError) until.set(spec.cacheKey, now() + TOO_LARGE_RETRY_MS);
        throw err;
      }
    },
    size: inner.size,
    clear: () => {
      until.clear();
      inner.clear();
    },
  };
}

/** SQL 결과가 상한을 넘었는지 — 조회는 상한+1 줄로 끊으므로 그 줄이 있으면 넘친 것 */
function assertWithinCap(rows: CandidateRow[]): CandidateRow[] {
  if (rows.length > CANDIDATE_CACHE_MAX_ROWS) throw new CandidateCacheTooLargeError(rows.length);
  return rows;
}

export function getCitationRowsCache() {
  const g = globalThis as GlobalWithRowsCache;
  if (!g.__geotracker_citation_rows_cache) {
    g.__geotracker_citation_rows_cache = withTooLargeMemory(
      createCandidateRowsCache({ fingerprint: dbRunsFingerprint, countSince: dbCountSince }),
    );
  }
  return g.__geotracker_citation_rows_cache;
}

type ViewArgs = {
  workspaceId: string;
  autoOnly: boolean;
  branded: boolean;
  brandTerms: string[];
};

function viewWhere(args: ViewArgs): SQL {
  return buildRunStatsWhereClause({
    workspaceId: args.workspaceId,
    fromDate: FIRST_SEEN_HISTORY_START,
    toDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    autoOnly: args.autoOnly,
    brandTerms: args.brandTerms,
    branded: args.branded,
  });
}

function sinceCond(since: string | null): SQL {
  return since ? sql`AND ${schema.runs.createdAt} > ${since}::timestamptz` : sql``;
}

/**
 * 내 사이트 인용 URL 후보 — 브랜드 사이트 사전 필터 + (소유 영상이 있으면) 유튜브 사전 필터, 두 조회를 합쳐
 * 중복 제거. key 에는 사전 필터를 정하는 브랜드 키·소유 영상 여부를 넣는다.
 */
export function ownedCandidateSpec(
  args: ViewArgs & {
    brandKeys: string[];
    brandKeyPrefilter: SQL;
    youtubeVideoPrefilter: SQL | null;
  },
): RunsDerivedGetSpec<CandidateRow> {
  const one = (prefilter: SQL, since: string | null) =>
    runStatsQuery((q) =>
      q.execute<CandidateRow>(sql`
        SELECT ${schema.runs.id} AS run_id, cite->>'url' AS url, cite->>'domain' AS domain,
               ${schema.runs.promptText} AS prompt_text, ${schema.runs.provider} AS provider,
               ${schema.runs.createdAt} AS created_at
        FROM ${schema.runs}
        CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
        WHERE ${viewWhere(args)}
          AND jsonb_typeof(${schema.runs.citations}) = 'array'
          AND ${prefilter}
          ${sinceCond(since)}
        LIMIT ${CANDIDATE_CACHE_MAX_ROWS + 1}
      `),
    ).then((rows) => assertWithinCap(rows as unknown as CandidateRow[]));
  return {
    cacheKey: `rows-owned|${args.workspaceId}|${args.autoOnly}|${args.branded}|${configDigest([
      args.brandTerms,
      [...args.brandKeys].sort(),
      args.youtubeVideoPrefilter ? "yt" : "no-yt",
    ])}`,
    workspaceId: args.workspaceId,
    load: async (since) => {
      const [brand, yt] = await Promise.all([
        one(args.brandKeyPrefilter, since),
        args.youtubeVideoPrefilter ? one(args.youtubeVideoPrefilter, since) : Promise.resolve([] as CandidateRow[]),
      ]);
      return args.youtubeVideoPrefilter ? dedupCandidateRows([...brand, ...yt]) : brand;
    },
  };
}

/** 브랜드 언급 출처 후보 — 언급 사전 필터 한 조회 */
export function mentionCandidateSpec(
  args: ViewArgs & { brandMentionPrefilter: SQL },
): RunsDerivedGetSpec<CandidateRow> {
  return {
    cacheKey: `rows-mention|${args.workspaceId}|${args.autoOnly}|${args.branded}|${configDigest(args.brandTerms)}`,
    workspaceId: args.workspaceId,
    load: (since) =>
      runStatsQuery((q) =>
        q.execute<CandidateRow>(sql`
          SELECT ${schema.runs.id} AS run_id, cite->>'url' AS url, cite->>'domain' AS domain,
                 cite->>'title' AS title, cite->>'description' AS description,
                 ${schema.runs.promptText} AS prompt_text, ${schema.runs.provider} AS provider,
                 ${schema.runs.createdAt} AS created_at
          FROM ${schema.runs}
          CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
          WHERE ${viewWhere(args)}
            AND jsonb_typeof(${schema.runs.citations}) = 'array'
            AND ${args.brandMentionPrefilter}
            ${sinceCond(since)}
          LIMIT ${CANDIDATE_CACHE_MAX_ROWS + 1}
        `),
      ).then((rows) => assertWithinCap(rows as unknown as CandidateRow[])),
  };
}

/* ── 응답 결과 캐시 (전체 출처 표용) ──────────────────────────────────────────────────────────────
 * 전체 출처 표가 느린 원인은 다른 두 목록과 다르다 — 패턴 비교가 아니라 기간 안 모든 응답의 출처 문자열을
 * 펼쳐 주소별로 묶는 비용이다(전체 기간 약 2.2초 · 패턴 없음). 행 단위 캐시는 문자열 수십만 개라 메모리가 커서
 * 대신 **같은 조건의 결과**를 데이터 지문이 같은 동안 재사용한다. 새 응답이 들어오면(지문 변경) 다시 계산한다.
 */
export function createResultCache<T>(opts: { maxEntries?: number; maxAgeMs?: number; now?: () => number } = {}) {
  const maxEntries = opts.maxEntries ?? 32;
  const maxAgeMs = opts.maxAgeMs ?? 30 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, { fp: string; at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  return {
    async get(key: string, fp: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
      const e = map.get(key);
      if (e && e.fp === fp && now() - e.at < maxAgeMs) {
        map.delete(key);
        map.set(key, e); // 최근 사용으로 옮김
        return { value: e.value, hit: true };
      }
      const flightKey = `${key}#${fp}`;
      let p = inflight.get(flightKey);
      if (!p) {
        p = compute().finally(() => inflight.delete(flightKey));
        inflight.set(flightKey, p);
      }
      const value = await p;
      map.set(key, { fp, at: now(), value });
      while (map.size > maxEntries) map.delete(map.keys().next().value as string);
      return { value, hit: false };
    },
    size: () => map.size,
  };
}

type GlobalWithResultCache = typeof globalThis & { __geotracker_sources_result_cache?: ReturnType<typeof createResultCache> };

export function getSourcesResultCache<T>() {
  const g = globalThis as GlobalWithResultCache;
  if (!g.__geotracker_sources_result_cache) g.__geotracker_sources_result_cache = createResultCache<unknown>();
  return g.__geotracker_sources_result_cache as unknown as ReturnType<typeof createResultCache<T>>;
}

/** 지문 → 비교용 문자열 */
export function fingerprintKey(fp: { total: number; maxMs: number; maxText: string | null }): string {
  return `${fp.total}|${fp.maxText ?? fp.maxMs}`;
}

/**
 * 전체 출처 결과 캐시 키 (검수 S6) — 실제 기간(KST 날짜)을 넣는다. 「전체 기간」은 시작일이 매일 앞으로 움직여
 * 쿼리 문자열이 같아도 날이 바뀌면 다른 결과다. 하루 안의 시작 시각 이동은 2년 전 경계의 행에만 영향을 주고
 * 결과 캐시의 최대 보관 시간(30분)이 한 번 더 막는다.
 */
export function sourcesResultKey(workspaceId: string, from: Date, to: Date, search: string): string {
  const kst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `${workspaceId}|${kst(from)}|${kst(to)}|${search}`;
}
