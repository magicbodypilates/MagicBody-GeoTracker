/**
 * collector-engine.ts — 자동 수집 엔진: DB 대기열 + 1분마다 도는 짧은 두 줄기(보내기·거두기).
 * 계획 geotracker-collect-speed-260924 §2 · §7-5.
 *
 * 예전 엔진(automation-runner.ts runTick)은 틱 하나가 모든 질문 × AI 를 메모리 반복문으로 몇 시간씩
 * 붙잡았다. 새 엔진은 회차(collection_rounds)와 회차별 항목(collection_items)을 DB 에 두고,
 *   - 보내기 줄기(runDispatchPass): 재시작 감지 → 끊긴 "보내는 중" 복구 → 회차 만들기 → 멈춘 회차 정리 → 제출
 *   - 거두기 줄기(runHarvestPass): 하루 집계(날짜 바뀐 뒤 1회) → 진행 확인 → 내려받기·저장 → 회차 마감
 * 가 항목 상태를 한 단계씩 옮긴다. Bright Data 요청 번호를 DB 에 남겨 재시작·배포 뒤에도 같은 번호로
 * 이어서 받는다.
 *
 * 항목 상태: queued → submitting → submitted → saved / duplicate / failed / cancelled
 *   (submitting 에서 200 을 받으면 바로 saved/duplicate · 거절이면 queued/failed · 끊기면 복구가 queued 로)
 *
 * 규칙 (계획 v2 §2-3):
 *   - 모든 상태 변경은 기대 상태를 조건으로 건다(where id = ? and status = ?). 바뀐 행이 없으면 건너뛴다.
 *   - 돈이 드는 요청 전에 항목을 "보내는 중"으로 먼저 표시한다 — 끊기면 복구가 다시 보낸다(결과 손실 0,
 *     중복 과금은 AI별 상한 합계 이하).
 *   - 재시도 예산 판정·회차 마감·항목 추가는 회차 행을 잠근(select … for update) 한 트랜잭션에서 한다.
 *   - 트랜잭션 안에서는 tx 만 쓴다. 감성 분류(LLM) 같은 외부 호출은 트랜잭션 밖에서 한다.
 *   - 엔진 안의 현재 시각은 인자 now 만 쓴다(예산 측정·소요 시간만 performance.now()).
 *
 * 제출은 한 프로세스의 보내기 줄기 하나만 한다(tick 라우트의 줄기 플래그 + 앱 컨테이너 1개).
 * 테스트는 deps 로 Bright Data 4개 함수·감성 분류·저장 함수를 가짜로 바꾼다.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db, schema } from "@/lib/server/db";
import type {
  CollectionAttempt,
  CollectionItem,
  CollectionRound,
  CollectionRoundSummary,
  Schedule,
  ScoringSnapshot,
} from "@/drizzle/schema";
import {
  cancelSnapshot,
  downloadSnapshotPayload,
  getSnapshotProgress,
  isCrawlerCode,
  isKnownProvider,
  normalizeScrapePayload,
  redactErrorText,
  ScrapeFailure,
  submitScrape,
  type NormalizedScrapeResult,
  type Provider,
} from "@/lib/server/brightdata-scraper";
import {
  buildAutoRunValues,
  buildScoringContext,
  findAutoRunId,
  insertAutoRun,
  loadScoringSnapshot,
  recordDriftAfterInsert,
  runDailyRollup,
  type AutoRunTarget,
  type DbOrTx,
  type ProviderFailure,
} from "@/lib/server/automation-runner";
import { classifySentiment } from "@/lib/server/llm-sentiment";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";
import {
  AUTH_PAUSE_MS,
  CANDIDATE_MULTIPLIER,
  CRON_PARSE_FAILURE_BACKOFF_MS,
  DOWNLOAD_CONCURRENCY,
  FIRST_POLL_DELAY_MS,
  HARVEST_SOFT_BUDGET_MS,
  IN_FLIGHT_DEFER_MS,
  MAX_DOWNLOAD_ERRORS,
  MAX_FREE_REQUEUES,
  MAX_PERSIST_ERRORS,
  MAX_POLL_ERRORS,
  MAX_UNKNOWN_SUBMITS,
  NOT_READY_RETRY_MS,
  POLL_BATCH_LIMIT,
  POLL_CONCURRENCY,
  ROUND_MAX_AGE_MS,
  STALE_SUBMITTING_MS,
  TRANSIENT_RETRY_MS,
  getPollDeadlineMs,
  getProviderCap,
  getRetryRatio,
} from "@/lib/server/collector-config";
import {
  decideAfterFailure,
  freeRequeueDelayMs,
  limitReached,
  nextPollDelayMs,
  retryBudget,
  shouldSkipPerplexityCountry,
  type CollectorErrorCode,
} from "@/lib/server/collector-policy";
import { computeRoundTiming, formatIntervalSlot, kstDateString } from "@/lib/server/collector-schedule";

/* ============================================================
 * 공개 타입
 * ============================================================ */

export type DispatchStats = {
  recovered: number;
  dueSchedules: number;
  roundsCreated: number;
  roundsSkippedOverlap: number;
  cancelled: number;
  submitted: number;
  savedInline: number;
  duplicates: number;
  requeued: number;
  retried: number;
  failed: number;
  durationMs: number;
};

export type HarvestStats = {
  polled: number;
  saved: number;
  duplicates: number;
  retried: number;
  failed: number;
  timeouts: number;
  roundsCompleted: number;
  dailyRollup: { date: string; rows: number } | null;
  durationMs: number;
};

export type PassResult<S> = {
  stats: S;
  providerFailures: ProviderFailure[];
  errors: { scheduleId: string; message: string }[];
};

export type BdClient = {
  submitScrape: typeof submitScrape;
  getSnapshotProgress: typeof getSnapshotProgress;
  downloadSnapshotPayload: typeof downloadSnapshotPayload;
  cancelSnapshot: typeof cancelSnapshot;
};

/** 테스트용 교체 지점 — 기본값은 실제 함수. */
export type EngineDeps = {
  bd?: Partial<BdClient>;
  classifySentiment?: typeof classifySentiment;
  insertAutoRun?: typeof insertAutoRun;
};

type ResolvedDeps = {
  bd: BdClient;
  classifySentiment: typeof classifySentiment;
  insertAutoRun: typeof insertAutoRun;
};

export type CreateRoundResult =
  | { status: "created"; round: CollectionRound; newItems: number }
  /** 진행 중 회차가 있어 만들지 않음. closing=true 면 5시간 넘은 회차를 마무리하는 중이라 합류도 못 했다. */
  | { status: "running_skipped"; round: CollectionRound; closing?: boolean }
  | { status: "topped_up"; round: CollectionRound; addedItems: number; addedPrompts: number; newItems: number };

export type RoundOverview = {
  id: string;
  scheduleId: string | null;
  scheduleName: string | null;
  trigger: string;
  status: string;
  priority: number;
  scheduledFor: string;
  intervalSlot: string;
  createdAt: string;
  finishedAt: string | null;
  expected: number;
  counts: Record<ItemStatus, number>;
  byProvider: Record<string, { saved: number; duplicate: number; failed: number; cancelled: number; pending: number }>;
  topErrors: { provider: string; code: string; count: number }[];
};

type ItemStatus = "queued" | "submitting" | "submitted" | "saved" | "duplicate" | "failed" | "cancelled";
const ITEM_STATUSES: ItemStatus[] = ["queued", "submitting", "submitted", "saved", "duplicate", "failed", "cancelled"];
const PENDING_STATUSES: ItemStatus[] = ["queued", "submitting", "submitted"];
const IN_FLIGHT_STATUSES: ItemStatus[] = ["submitting", "submitted"];

const rounds = schema.collectionRounds;
const items = schema.collectionItems;
const state = schema.collectorState;

/* ============================================================
 * 줄기 문맥·공통 도우미
 * ============================================================ */

type PassCtx = {
  now: Date;
  deps: ResolvedDeps;
  providerFailures: ProviderFailure[];
  errors: { scheduleId: string; message: string }[];
  roundCache: Map<string, CollectionRound>;
  ownedCache: Map<string, Set<string>>;
  /** 인증 실패 오류는 줄기당 한 번만 남긴다 */
  authReported: boolean;
};

function resolveDeps(deps?: EngineDeps): ResolvedDeps {
  return {
    bd: {
      submitScrape: deps?.bd?.submitScrape ?? submitScrape,
      getSnapshotProgress: deps?.bd?.getSnapshotProgress ?? getSnapshotProgress,
      downloadSnapshotPayload: deps?.bd?.downloadSnapshotPayload ?? downloadSnapshotPayload,
      cancelSnapshot: deps?.bd?.cancelSnapshot ?? cancelSnapshot,
    },
    classifySentiment: deps?.classifySentiment ?? classifySentiment,
    insertAutoRun: deps?.insertAutoRun ?? insertAutoRun,
  };
}

function newPass(now: Date, deps?: EngineDeps): PassCtx {
  return {
    now,
    deps: resolveDeps(deps),
    providerFailures: [],
    errors: [],
    roundCache: new Map(),
    ownedCache: new Map(),
    authReported: false,
  };
}

/**
 * 오류 → 저장·로그용 짧은 문구. drizzle 0.45 의 DrizzleQueryError 는 message 에 SQL 전문과
 * 파라미터(질문·답변 문구)를 담으므로 원인(postgres 오류) 문구만 쓴다.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? err.cause : null;
    if (cause) return redactErrorText(`${cause.name}: ${cause.message}`);
    if (err.message.startsWith("Failed query")) return "DB 쿼리 실패";
    return redactErrorText(`${err.name}: ${err.message}`);
  }
  return redactErrorText(String(err));
}

/** postgres 오류 코드(예: 23505) — drizzle 이 감싼 원인까지 따라가 찾는다. */
function pgErrorCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** 줄기의 한 단계 — 실패해도 다음 단계는 돈다. 오류는 errors[collector:<단계>] 로 남긴다. */
async function runStep(pass: PassCtx, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    pass.errors.push({ scheduleId: `collector:${name}`, message: errorMessage(err) });
  }
}

/** 동시 개수를 제한해 목록을 처리한다. 한 건의 예외가 나머지를 막지 않는다(오류는 onError 로). */
async function mapPool<T>(
  list: T[],
  limit: number,
  fn: (x: T) => Promise<void>,
  onError: (err: unknown) => void,
  shouldStart?: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      if (shouldStart && !shouldStart()) return;
      const x = list[next++];
      try {
        await fn(x);
      } catch (err) {
        onError(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

function lastAttempt(item: Pick<CollectionItem, "attempts">): CollectionAttempt | undefined {
  const list = Array.isArray(item.attempts) ? item.attempts : [];
  return list[list.length - 1];
}

/** attempts 배열 끝에 새 시도 칸을 붙인다 — n = 길이 + 1 (DB 에서 계산해 경쟁에도 안전). */
function appendAttemptSql(attempt: Omit<CollectionAttempt, "n">) {
  return sql`${items.attempts} || jsonb_build_array(jsonb_build_object('n', jsonb_array_length(${items.attempts}) + 1) || ${JSON.stringify(attempt)}::jsonb)`;
}

/** attempts 배열의 마지막 칸에 필드를 덧붙인다(비어 있으면 그대로). */
function patchLastAttemptSql(patch: Partial<CollectionAttempt>) {
  return sql`case when jsonb_array_length(${items.attempts}) = 0 then ${items.attempts}
    else jsonb_set(${items.attempts}, array[(jsonb_array_length(${items.attempts}) - 1)::text],
                   (${items.attempts} -> -1) || ${JSON.stringify(patch)}::jsonb) end`;
}

function isExpired(round: Pick<CollectionRound, "createdAt">, now: Date): boolean {
  return now.getTime() - new Date(round.createdAt).getTime() > ROUND_MAX_AGE_MS;
}

/* ============================================================
 * collector_state — 재시작에도 유지되는 작은 상태
 * ============================================================ */

async function getStateValue<T extends Record<string, unknown>>(key: string, dbOrTx: DbOrTx = db): Promise<T | null> {
  const [row] = await dbOrTx.select({ value: state.value }).from(state).where(eq(state.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

async function setStateValue(key: string, value: Record<string, unknown>, now: Date, dbOrTx: DbOrTx = db): Promise<void> {
  await dbOrTx
    .insert(state)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: state.key, set: { value, updatedAt: now } });
}

async function getUntil(key: string): Promise<Date | null> {
  const v = await getStateValue<{ until?: string }>(key);
  if (!v?.until) return null;
  const d = new Date(v.until);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 멈춤 시각을 늘리기만 한다(이미 더 늦은 시각이면 그대로). */
async function extendUntil(key: string, until: Date, now: Date): Promise<void> {
  const cur = await getUntil(key);
  if (cur && cur.getTime() >= until.getTime()) return;
  await setStateValue(key, { until: until.toISOString() }, now);
}

async function pauseAuth(pass: PassCtx, message: string): Promise<void> {
  await extendUntil("auth_pause_until", addMs(pass.now, AUTH_PAUSE_MS), pass.now);
  if (!pass.authReported) {
    pass.authReported = true;
    pass.errors.push({
      scheduleId: "collector:auth",
      message: `Bright Data 인증 실패 — 제출을 ${AUTH_PAUSE_MS / 60_000}분 멈춘다: ${redactErrorText(message, 120)}`,
    });
  }
}

/* ============================================================
 * 회차·점수 기준 캐시 (줄기 안에서만)
 * ============================================================ */

async function getRound(pass: PassCtx, roundId: string): Promise<CollectionRound | null> {
  const cached = pass.roundCache.get(roundId);
  if (cached) return cached;
  const [row] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
  if (row) pass.roundCache.set(roundId, row);
  return row ?? null;
}

async function getOwned(pass: PassCtx, workspaceId: string): Promise<Set<string>> {
  const cached = pass.ownedCache.get(workspaceId);
  if (cached) return cached;
  const set = await getOwnedYoutubeVideoIds(workspaceId);
  pass.ownedCache.set(workspaceId, set);
  return set;
}

/** 회차 점수 기준 — 없으면(예외적) 지금 값으로 채워 회차에 저장한다. */
async function getRoundSnapshot(pass: PassCtx, round: CollectionRound): Promise<ScoringSnapshot> {
  if (round.scoringSnapshot) return round.scoringSnapshot;
  const snap = await loadScoringSnapshot(round.workspaceId);
  await db
    .update(rounds)
    .set({ scoringSnapshot: snap })
    .where(and(eq(rounds.id, round.id), isNull(rounds.scoringSnapshot)));
  const updated = { ...round, scoringSnapshot: snap };
  pass.roundCache.set(round.id, updated);
  return snap;
}

/* ============================================================
 * 항목 실패 처리 — 회차 행 잠금 트랜잭션에서 재시도 예산을 판정한다
 * ============================================================ */

type FailOptions = {
  /** 같은 갱신에 함께 넣을 칸(예: 카운터 증가분) */
  extraSet?: PgUpdateSetSource<typeof items>;
  /** 시도 칸 결과 — 기본은 재시도면 "retry", 아니면 "failed" */
  attemptOutcome?: CollectionAttempt["outcome"];
  /** 시도 칸 원인 코드 — 기본은 code */
  attemptErrorCode?: string;
};

type FailOutcome = "retry" | "failed" | "skipped";

async function failItem(
  pass: PassCtx,
  item: CollectionItem,
  code: CollectorErrorCode,
  message: string,
  expectedStatus: ItemStatus,
  opts: FailOptions = {},
): Promise<FailOutcome> {
  const { now } = pass;
  const redacted = redactErrorText(message);
  const decided = await db.transaction(async (tx) => {
    const [round] = await tx.select().from(rounds).where(eq(rounds.id, item.roundId)).for("update");
    if (!round) return null;
    const [cur] = await tx.select().from(items).where(eq(items.id, item.id)).limit(1);
    if (!cur || cur.status !== expectedStatus) return null;
    const [agg] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        used: sql<number>`coalesce(sum(${items.paidRetries}), 0)::int`,
      })
      .from(items)
      .where(and(eq(items.roundId, round.id), eq(items.provider, cur.provider)));
    const d = decideAfterFailure({
      code,
      provider: cur.provider,
      countrySent: lastAttempt(cur)?.country != null,
      countryFallbacks: cur.countryFallbacks,
      paidRetries: cur.paidRetries,
      usedRetries: Number(agg?.used ?? 0),
      budget: retryBudget(Number(agg?.n ?? 0), getRetryRatio()),
      roundExpired: isExpired(round, now),
    });
    const outcome = opts.attemptOutcome ?? (d.action === "retry" ? "retry" : "failed");
    const set: PgUpdateSetSource<typeof items> = {
      lastErrorCode: code,
      lastError: redacted,
      updatedAt: now,
      attempts: patchLastAttemptSql({
        finishedAt: now.toISOString(),
        errorCode: opts.attemptErrorCode ?? code,
        error: redacted,
        outcome,
      }),
      ...opts.extraSet,
    };
    if (d.action === "retry" && d.kind === "country_fallback") {
      Object.assign(set, {
        status: "queued",
        countryFallbacks: cur.countryFallbacks + 1,
        dropCountry: true,
        snapshotId: null,
        nextPollAt: null,
        pollDeadlineAt: null,
        nextAttemptAt: now,
      });
    } else if (d.action === "retry") {
      Object.assign(set, {
        status: "queued",
        paidRetries: cur.paidRetries + 1,
        snapshotId: null,
        nextPollAt: null,
        pollDeadlineAt: null,
        nextAttemptAt: addMs(now, d.delayMs),
      });
    } else {
      Object.assign(set, { status: "failed", nextPollAt: null });
    }
    const updated = await tx
      .update(items)
      .set(set)
      .where(and(eq(items.id, cur.id), eq(items.status, expectedStatus)))
      .returning({ id: items.id });
    if (updated.length === 0) return null;
    return { d, scheduleId: round.scheduleId };
  });
  if (!decided) return "skipped";
  if (decided.d.action === "fail") {
    pass.providerFailures.push({
      scheduleId: decided.scheduleId ?? "",
      workspaceId: item.workspaceId,
      provider: item.provider,
      prompt: item.promptText,
      reason: `${code}: ${redactErrorText(redacted, 120)}`,
    });
    return "failed";
  }
  return "retry";
}

/* ============================================================
 * 결과 저장 — 보내기(200 바로 결과)와 거두기(내려받기)가 함께 쓴다
 * ============================================================ */

type FinalizeOutcome = "saved" | "duplicate" | "retry" | "failed" | "requeued" | "later" | "skipped";

/** 저장 트랜잭션 안에서 항목 상태가 이미 바뀐 것을 알리는 표식(롤백용) */
class ItemMovedError extends Error {
  constructor() {
    super("item status changed");
    this.name = "ItemMovedError";
  }
}

async function finalizeWithPayload(
  pass: PassCtx,
  item: CollectionItem,
  payload: unknown,
  progress: { records?: number; errors?: number } | undefined,
  expectedStatus: "submitting" | "submitted",
  durationMs: number,
): Promise<FinalizeOutcome> {
  const { now } = pass;
  const round = await getRound(pass, item.roundId);
  if (!round) return "skipped";

  let result: NormalizedScrapeResult;
  try {
    result = normalizeScrapePayload({
      provider: item.provider as Provider,
      prompt: item.promptText,
      payload,
      progress,
    });
  } catch (err) {
    if (err instanceof ScrapeFailure) {
      // "준비됨" 뒤에 내려받은 결과가 아직 자리표시자면 요청 번호로 다시 내려받는다(추가 과금 없음).
      // 5회 넘게 이어지면 그때 원인 코드(NOT_READY)로 실패 처리한다 — 재시도 규칙이 적용된다.
      if (err.code === "NOT_READY" && expectedStatus === "submitted" && item.snapshotId) {
        return retryDownloadLater(pass, item, "NOT_READY", err.message, NOT_READY_RETRY_MS);
      }
      const countrySent = lastAttempt(item)?.country != null;
      if (item.provider === "perplexity" && isCrawlerCode(err.code) && countrySent) {
        await setStateValue("perplexity_country_failed_at", { at: now.toISOString() }, now);
      }
      return failItem(pass, item, err.code, err.message, expectedStatus);
    }
    return failItem(pass, item, "UNKNOWN", errorMessage(err), expectedStatus);
  }

  const target: AutoRunTarget = {
    workspaceId: item.workspaceId,
    scheduleId: round.scheduleId,
    promptText: item.promptText,
    provider: item.provider,
    intervalSlot: item.intervalSlot,
    geolocation: round.geolocation ?? null,
  };
  const duration = Math.max(0, Math.round(durationMs));

  try {
    const snapshot = await getRoundSnapshot(pass, round);
    const owned = await getOwned(pass, item.workspaceId);
    const ctx = buildScoringContext(item.workspaceId, snapshot, owned);
    // 감성 분류(LLM)는 트랜잭션 밖에서 — 계획 v2 §2-3
    const values = await buildAutoRunValues(ctx, target, result, duration, {
      classifySentiment: pass.deps.classifySentiment,
    });
    const saved = await db.transaction(async (tx) => {
      const r = await pass.deps.insertAutoRun(values, tx);
      const runId = r.inserted ? r.runId : await findAutoRunId(target, tx);
      const status = r.inserted ? "saved" : "duplicate";
      const updated = await tx
        .update(items)
        .set({
          status,
          runId,
          durationMs: duration,
          nextPollAt: null,
          updatedAt: now,
          attempts: patchLastAttemptSql({
            outcome: status,
            finishedAt: now.toISOString(),
            durationMs: duration,
            ...(progress ? { progress } : {}),
          }),
        })
        .where(and(eq(items.id, item.id), eq(items.status, expectedStatus)))
        .returning({ id: items.id });
      if (updated.length === 0) throw new ItemMovedError();
      return { inserted: r.inserted, status } as const;
    });
    if (saved.inserted) await recordDriftAfterInsert(values);
    return saved.status;
  } catch (err) {
    if (err instanceof ItemMovedError) return "skipped";
    return handlePersistError(pass, item, expectedStatus, err);
  }
}

/** 저장 실패 — 요청 번호가 있으면 다시 내려받고, 없으면(200 경로) 다시 수집한다(유료 1건). */
async function handlePersistError(
  pass: PassCtx,
  item: CollectionItem,
  expectedStatus: "submitting" | "submitted",
  err: unknown,
): Promise<FinalizeOutcome> {
  const { now } = pass;
  const message = errorMessage(err);
  const nextPersist = item.persistErrors + 1;
  if (limitReached(nextPersist, MAX_PERSIST_ERRORS)) {
    return failItem(pass, item, "PERSIST_FAILED", message, expectedStatus, {
      extraSet: { persistErrors: nextPersist },
    });
  }
  if (expectedStatus === "submitted" && item.snapshotId) {
    await db
      .update(items)
      .set({
        persistErrors: nextPersist,
        nextPollAt: addMs(now, TRANSIENT_RETRY_MS),
        lastErrorCode: "PERSIST_FAILED",
        lastError: message,
        updatedAt: now,
      })
      .where(and(eq(items.id, item.id), eq(items.status, expectedStatus)));
    return "later";
  }
  await db
    .update(items)
    .set({
      status: "queued",
      persistErrors: nextPersist,
      snapshotId: null,
      nextAttemptAt: addMs(now, TRANSIENT_RETRY_MS),
      lastErrorCode: "PERSIST_FAILED",
      lastError: message,
      updatedAt: now,
      attempts: patchLastAttemptSql({
        finishedAt: now.toISOString(),
        outcome: "requeued",
        errorCode: "PERSIST_FAILED",
        error: message,
      }),
    })
    .where(and(eq(items.id, item.id), eq(items.status, expectedStatus)));
  return "requeued";
}

/** 내려받기 일시 실패 — download_errors+1, 한도에 닿으면 code 로 실패 처리. */
async function retryDownloadLater(
  pass: PassCtx,
  item: CollectionItem,
  code: CollectorErrorCode,
  message: string,
  delayMs: number,
): Promise<FinalizeOutcome> {
  const nextErr = item.downloadErrors + 1;
  if (limitReached(nextErr, MAX_DOWNLOAD_ERRORS)) {
    return failItem(pass, item, code, message, "submitted", { extraSet: { downloadErrors: nextErr } });
  }
  await db
    .update(items)
    .set({
      downloadErrors: nextErr,
      nextPollAt: addMs(pass.now, delayMs),
      updatedAt: pass.now,
    })
    .where(and(eq(items.id, item.id), eq(items.status, "submitted")));
  return "later";
}

/* ============================================================
 * 회차 만들기 — 정기·첫 회차(보내기 줄기)와 즉시 실행(라우트)이 함께 쓴다
 * ============================================================ */

/** 스케줄이 모을 질문·AI — executeSchedule 과 같은 조건(비었으면 워크스페이스 활성 질문 전체). */
async function resolveTargets(
  sched: Schedule,
  tx: DbOrTx,
): Promise<{ promptTexts: string[]; providers: Provider[] }> {
  const where =
    sched.promptIds && sched.promptIds.length > 0
      ? and(
          eq(schema.prompts.workspaceId, sched.workspaceId),
          inArray(schema.prompts.id, sched.promptIds),
          eq(schema.prompts.active, true),
        )
      : and(eq(schema.prompts.workspaceId, sched.workspaceId), eq(schema.prompts.active, true));
  const promptRows = await tx
    .select({ text: schema.prompts.text })
    .from(schema.prompts)
    .where(where)
    .orderBy(asc(schema.prompts.createdAt), asc(schema.prompts.id));
  const providers: Provider[] = [];
  for (const p of sched.providers ?? []) {
    if (!isKnownProvider(p)) {
      console.warn(`[collector] 모르는 AI 이름은 제외한다 (scheduleId=${sched.id})`);
      continue;
    }
    if (!providers.includes(p)) providers.push(p);
  }
  return { promptTexts: promptRows.map((r) => r.text), providers };
}

function emptySummary(): CollectionRoundSummary {
  return {
    saved: 0,
    duplicate: 0,
    failed: 0,
    cancelled: 0,
    paidAttempts: 0,
    unknownSubmits: 0,
    paidRetries: 0,
    countryFallbacks: 0,
    byProvider: {},
  };
}

/** 이 회차 항목 중 같은 (workspace, slot, prompt, provider) 결과가 아직 없는 수 (응답 안내용). */
async function countNewItems(tx: DbOrTx, roundId: string, onlyIds?: string[]): Promise<number> {
  if (onlyIds && onlyIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        eq(items.roundId, roundId),
        onlyIds ? inArray(items.id, onlyIds) : undefined,
        sql`not exists (select 1 from ${schema.runs} r where r.workspace_id = ${items.workspaceId}
              and r.interval_slot = ${items.intervalSlot} and r.prompt_text = ${items.promptText}
              and r.provider = ${items.provider})`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** 회차 요약 — 상태·원인 코드·과금 칸을 AI별로 모은다. */
async function computeRoundSummary(tx: DbOrTx, roundId: string): Promise<CollectionRoundSummary> {
  const rows = await tx
    .select({
      provider: items.provider,
      status: items.status,
      code: items.lastErrorCode,
      n: sql<number>`count(*)::int`,
      paidAttempts: sql<number>`coalesce(sum(${items.paidAttempts}), 0)::int`,
      unknownSubmits: sql<number>`coalesce(sum(${items.unknownSubmits}), 0)::int`,
      paidRetries: sql<number>`coalesce(sum(${items.paidRetries}), 0)::int`,
      countryFallbacks: sql<number>`coalesce(sum(${items.countryFallbacks}), 0)::int`,
    })
    .from(items)
    .where(eq(items.roundId, roundId))
    .groupBy(items.provider, items.status, items.lastErrorCode);
  const s = emptySummary();
  for (const r of rows) {
    const n = Number(r.n);
    s.paidAttempts += Number(r.paidAttempts);
    s.unknownSubmits += Number(r.unknownSubmits);
    s.paidRetries += Number(r.paidRetries);
    s.countryFallbacks += Number(r.countryFallbacks);
    const bp = (s.byProvider[r.provider] ??= { saved: 0, duplicate: 0, failed: 0, cancelled: 0, failedByCode: {} });
    if (r.status === "saved") {
      s.saved += n;
      bp.saved += n;
    } else if (r.status === "duplicate") {
      s.duplicate += n;
      bp.duplicate += n;
    } else if (r.status === "failed") {
      s.failed += n;
      bp.failed += n;
      const code = r.code ?? "UNKNOWN";
      bp.failedByCode[code] = (bp.failedByCode[code] ?? 0) + n;
    } else if (r.status === "cancelled") {
      s.cancelled += n;
      bp.cancelled += n;
    }
  }
  return s;
}

/**
 * 회차가 끝났으면(대기·보내는 중·진행 중 0) 요약을 저장하고 닫는다. 회차 행을 잠근 채 확인한다 —
 * 즉시 실행이 같은 회차에 항목을 더하는 것과 겹쳐도 더해진 항목을 두고 닫지 않는다.
 */
async function completeRoundIfDoneTx(
  tx: DbOrTx,
  roundId: string,
  now: Date,
): Promise<{ round: CollectionRound; summary: CollectionRoundSummary } | null> {
  const [round] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for("update");
  if (!round || round.status !== "running") return null;
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.roundId, roundId), inArray(items.status, PENDING_STATUSES)));
  if (Number(pending?.n ?? 0) > 0) return null;
  const summary = await computeRoundSummary(tx, roundId);
  const [closed] = await tx
    .update(rounds)
    .set({ status: "completed", finishedAt: now, summary })
    .where(and(eq(rounds.id, roundId), eq(rounds.status, "running")))
    .returning();
  return closed ? { round: closed, summary } : null;
}

/**
 * 5시간 넘은 진행 중 회차 정리 — 대기 항목을 취소(ROUND_EXPIRED)하고, 보내는 중·진행 중이 없으면
 * 바로 닫는다. 남아 있으면 "busy" — 그 항목은 대기 한도까지 받은 뒤 거두기 줄기가 닫는다.
 * (tx 안에서 회차 행을 잠근 뒤 부른다)
 */
async function retireExpiredRoundTx(
  tx: DbOrTx,
  round: CollectionRound,
  now: Date,
): Promise<"closed" | "busy"> {
  await tx
    .update(items)
    .set({
      status: "cancelled",
      lastErrorCode: "ROUND_EXPIRED",
      lastError: "회차가 5시간을 넘겨 대기 항목을 취소했다",
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(items.roundId, round.id), eq(items.status, "queued")));
  const closed = await completeRoundIfDoneTx(tx, round.id, now);
  if (closed) {
    logRoundCompleted(closed.round, closed.summary, null, now);
    return "closed";
  }
  return "busy";
}

type CreateRoundOpts = {
  trigger: "cron" | "manual" | "first_run";
  scheduledFor: Date;
  priority: number;
  onRunning: "skip" | "top_up";
};

/**
 * 스케줄 1개의 회차를 만든다. tx 가 없으면 스스로 트랜잭션을 연다.
 *   - 진행 중 회차가 있으면: skip → running_skipped · top_up → 그 회차에 빠진 (질문 × AI)만 더하고
 *     우선순위를 올린다(topped_up)
 *   - 없으면: 질문·AI·슬롯을 정하고 점수 기준을 복사해 회차 + 항목(질문 × AI)을 만든다(created)
 *   - 질문 0개면 회차를 바로 completed 로 남긴다(요약 0)
 *   - created 면 같은 트랜잭션에서 schedules.last_run_at = now
 */
export async function createRoundForSchedule(
  sched: Schedule,
  opts: CreateRoundOpts,
  now: Date,
  tx?: DbOrTx,
): Promise<CreateRoundResult> {
  if (tx) return createRoundInTx(sched, opts, now, tx);
  // 드물게 동시 생성이 고유 인덱스에 걸리면(23505) 새 트랜잭션에서 한 번만 다시 부른다 —
  // 두 번째에는 먼저 만들어진 진행 중 회차가 보인다.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction((t) => createRoundInTx(sched, opts, now, t));
    } catch (err) {
      if (attempt === 0 && pgErrorCode(err) === "23505") continue;
      throw err;
    }
  }
}

async function createRoundInTx(
  sched: Schedule,
  opts: CreateRoundOpts,
  now: Date,
  tx: DbOrTx,
): Promise<CreateRoundResult> {
  let running: CollectionRound | undefined = (
    await tx
      .select()
      .from(rounds)
      .where(and(eq(rounds.scheduleId, sched.id), eq(rounds.status, "running")))
      .limit(1)
      .for("update")
  )[0];

  // 즉시 실행이 5시간 넘은 회차에 합류하면 더한 항목이 바로 취소된다 — 먼저 정리한다.
  if (running && opts.onRunning === "top_up" && isExpired(running, now)) {
    const retired = await retireExpiredRoundTx(tx, running, now);
    if (retired === "busy") return { status: "running_skipped", round: running, closing: true };
    running = undefined;
  }

  if (running) {
    if (opts.onRunning === "skip") return { status: "running_skipped", round: running };
    return topUpRunningRound(sched, running, opts, now, tx);
  }

  const { promptTexts, providers } = await resolveTargets(sched, tx);
  const expected = promptTexts.length * providers.length;
  const snapshot = await loadScoringSnapshot(sched.workspaceId, tx);
  const slot = formatIntervalSlot(opts.scheduledFor);
  const inserted = await tx
    .insert(rounds)
    .values({
      workspaceId: sched.workspaceId,
      scheduleId: sched.id,
      trigger: opts.trigger,
      priority: opts.priority,
      status: expected === 0 ? "completed" : "running",
      scheduledFor: opts.scheduledFor,
      intervalSlot: slot,
      geolocation: sched.geolocation ?? null,
      scoringSnapshot: snapshot,
      expectedItems: expected,
      summary: expected === 0 ? emptySummary() : null,
      createdAt: now,
      finishedAt: expected === 0 ? now : null,
    })
    // 스케줄당 진행 중 1개(부분 고유)·같은 예정 시각(고유)에 걸리면 새로 만들지 않는다 — 같은 트랜잭션에서
    // 다시 조회해 진행 중 회차로 처리한다(롤백·재호출 없이 계획 v2 의 23505 재시도와 같은 효과).
    .onConflictDoNothing()
    .returning();
  const round = inserted[0];
  if (!round) {
    const [nowRunning] = await tx
      .select()
      .from(rounds)
      .where(and(eq(rounds.scheduleId, sched.id), eq(rounds.status, "running")))
      .limit(1)
      .for("update");
    if (nowRunning) {
      if (opts.onRunning === "skip") return { status: "running_skipped", round: nowRunning };
      return topUpRunningRound(sched, nowRunning, opts, now, tx);
    }
    const [sameOccurrence] = await tx
      .select()
      .from(rounds)
      .where(and(eq(rounds.scheduleId, sched.id), eq(rounds.scheduledFor, opts.scheduledFor)))
      .limit(1);
    if (!sameOccurrence) throw new Error("회차를 만들지 못했다(원인 불명)");
    return { status: "running_skipped", round: sameOccurrence };
  }

  if (expected > 0) {
    const rows: (typeof items.$inferInsert)[] = [];
    promptTexts.forEach((promptText, qi) => {
      providers.forEach((provider, pi) => {
        rows.push({
          roundId: round.id,
          workspaceId: sched.workspaceId,
          intervalSlot: slot,
          promptText,
          provider,
          seq: qi * providers.length + pi,
          countryRequested: sched.geolocation ?? "KR",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        });
      });
    });
    await tx.insert(items).values(rows).onConflictDoNothing();
  }

  await tx.update(schema.schedules).set({ lastRunAt: now }).where(eq(schema.schedules.id, sched.id));
  const newItems = expected > 0 ? await countNewItems(tx, round.id) : 0;
  return { status: "created", round, newItems };
}

async function topUpRunningRound(
  sched: Schedule,
  running: CollectionRound,
  opts: CreateRoundOpts,
  now: Date,
  tx: DbOrTx,
): Promise<CreateRoundResult> {
  const { promptTexts, providers } = await resolveTargets(sched, tx);
  const existing = await tx
    .select({ promptText: items.promptText, provider: items.provider, seq: items.seq })
    .from(items)
    .where(eq(items.roundId, running.id));
  const have = new Set(existing.map((e) => `${e.provider}\u0000${e.promptText}`));
  const promptsBefore = new Set(existing.map((e) => e.promptText));
  let seq = existing.reduce((m, e) => Math.max(m, e.seq), -1) + 1;
  const rows: (typeof items.$inferInsert)[] = [];
  for (const promptText of promptTexts) {
    for (const provider of providers) {
      if (have.has(`${provider}\u0000${promptText}`)) continue;
      rows.push({
        roundId: running.id,
        workspaceId: running.workspaceId,
        intervalSlot: running.intervalSlot,
        promptText,
        provider,
        seq: seq++,
        countryRequested: sched.geolocation ?? "KR",
        status: "queued",
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  const added =
    rows.length > 0
      ? await tx
          .insert(items)
          .values(rows)
          .onConflictDoNothing({ target: [items.roundId, items.promptText, items.provider] })
          .returning({ id: items.id, promptText: items.promptText })
      : [];
  const [updatedRound] = await tx
    .update(rounds)
    .set({
      priority: sql`greatest(${rounds.priority}, ${opts.priority})`,
      expectedItems: sql`${rounds.expectedItems} + ${added.length}`,
    })
    .where(eq(rounds.id, running.id))
    .returning();
  const newItems = await countNewItems(tx, running.id, added.map((a) => a.id));
  return {
    status: "topped_up",
    round: updatedRound ?? running,
    addedItems: added.length,
    // 회차에 아예 없던 질문 수 — "새 질문 N개" 안내용(기존 질문에 AI 만 더해진 경우와 구분)
    addedPrompts: new Set(added.map((a) => a.promptText).filter((t) => !promptsBefore.has(t))).size,
    newItems,
  };
}

/* ============================================================
 * 보내기 줄기
 * ============================================================ */

/**
 * 이 프로세스의 식별 — 처음 부를 때 무작위 bootId 를 만들어 globalThis 에 둔다(Next.js 개발 모드의
 * 모듈 재평가에도 유지). DB 의 기록과 bootId 가 다르면 프로세스가 새로 뜬 것이다.
 */
type ProcessIdentity = { bootId: string; startedAt: string; pid: number; recorded: boolean };
const globalForCollector = globalThis as unknown as { __collectorProcess?: ProcessIdentity };

function processIdentity(): ProcessIdentity {
  if (!globalForCollector.__collectorProcess) {
    globalForCollector.__collectorProcess = {
      bootId: randomUUID(),
      startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
      pid: process.pid,
      recorded: false,
    };
  }
  return globalForCollector.__collectorProcess;
}

/** 테스트 전용 — 프로세스 메모리 상태를 비운다(재시작 흉내). 운영 코드에서는 부르지 않는다. */
export function _resetCollectorMemoryForTest(): void {
  delete globalForCollector.__collectorProcess;
}

/** 0. 재시작 감지 — 이 프로세스에서 처음 도는 줄기면 로그 1줄 + 기록 */
async function detectProcessRestart(pass: PassCtx): Promise<void> {
  const me = processIdentity();
  if (me.recorded) return;
  const prev = await getStateValue<{ bootId?: string }>("process");
  if (!prev || prev.bootId !== me.bootId) {
    const [open] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rounds)
      .where(eq(rounds.status, "running"));
    const [inflight] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(inArray(items.status, IN_FLIGHT_STATUSES));
    console.log(
      `[collector] 재시작 감지 — 열린 회차 ${Number(open?.n ?? 0)} · 진행 중 항목 ${Number(inflight?.n ?? 0)} 이어서 진행`,
    );
    await setStateValue("process", { bootId: me.bootId, startedAt: me.startedAt, pid: me.pid }, pass.now);
  }
  me.recorded = true;
}

/** 1. 끊긴 "보내는 중" 복구 — 접수 여부를 모르니 unknown_submits+1 하고 다시 보낸다(3회째면 실패). */
async function recoverStaleSubmitting(pass: PassCtx, stats: DispatchStats): Promise<void> {
  const { now } = pass;
  const stale = await db
    .select()
    .from(items)
    .where(and(eq(items.status, "submitting"), lt(items.submitStartedAt, addMs(now, -STALE_SUBMITTING_MS))));
  for (const item of stale) {
    const nextUnknown = item.unknownSubmits + 1;
    if (limitReached(nextUnknown, MAX_UNKNOWN_SUBMITS)) {
      const out = await failItem(pass, item, "SUBMIT_FAILED", `보내는 중 끊김 ${nextUnknown}회 — 접수 여부 불명`, "submitting", {
        extraSet: { unknownSubmits: nextUnknown },
        attemptOutcome: "unknown",
        attemptErrorCode: "SUBMIT_UNKNOWN",
      });
      if (out === "failed") stats.failed++;
      continue;
    }
    const updated = await db
      .update(items)
      .set({
        status: "queued",
        unknownSubmits: nextUnknown,
        nextAttemptAt: now,
        lastErrorCode: "SUBMIT_UNKNOWN",
        lastError: "보내는 중 끊김 — 접수 여부 불명, 다시 보낸다",
        updatedAt: now,
        attempts: patchLastAttemptSql({
          finishedAt: now.toISOString(),
          outcome: "unknown",
          errorCode: "SUBMIT_UNKNOWN",
        }),
      })
      .where(and(eq(items.id, item.id), eq(items.status, "submitting")))
      .returning({ id: items.id });
    if (updated.length > 0) stats.recovered++;
  }
}

function nextRunAtMatches(value: Date | null) {
  // 밀리초 단위로 비교한다 — JS 로 읽은 값은 밀리초까지라, DB 에 마이크로초가 들어 있어도 맞춘다.
  return value === null
    ? isNull(schema.schedules.nextRunAt)
    : sql`date_trunc('milliseconds', ${schema.schedules.nextRunAt}) = ${value.toISOString()}::timestamptz`;
}

/** 5시간 넘은 진행 중 회차를 먼저 정리 — "busy" 면 이번엔 이 스케줄을 건드리지 않는다. */
async function retireExpiredForSchedule(scheduleId: string, now: Date): Promise<"none" | "closed" | "busy"> {
  return db.transaction(async (tx) => {
    const [running] = await tx
      .select()
      .from(rounds)
      .where(and(eq(rounds.scheduleId, scheduleId), eq(rounds.status, "running")))
      .limit(1)
      .for("update");
    if (!running || !isExpired(running, now)) return "none";
    return retireExpiredRoundTx(tx, running, now);
  });
}

/** 2. 때가 된 스케줄 → 회차 만들기 (클레임 UPDATE 는 next_run_at 만 바꾼다) */
async function createDueRounds(pass: PassCtx, stats: DispatchStats): Promise<void> {
  const { now } = pass;
  const due = await db
    .select()
    .from(schema.schedules)
    .where(
      and(
        eq(schema.schedules.active, true),
        or(isNull(schema.schedules.nextRunAt), lte(schema.schedules.nextRunAt, now)),
      ),
    );
  stats.dueSchedules = due.length;
  for (const s of due) {
    try {
      await createDueRoundForSchedule(pass, stats, s);
    } catch (err) {
      pass.errors.push({ scheduleId: s.id, message: errorMessage(err) });
    }
  }
}

async function createDueRoundForSchedule(pass: PassCtx, stats: DispatchStats, s: Schedule): Promise<void> {
  const { now } = pass;
  const timing = computeRoundTiming(s.cronExpression, s.nextRunAt, now);
  if (!timing.ok) {
    // 예전 엔진은 next_run_at 이 null 이 되어 매 틱 다시 돌았다 — 24시간 뒤로 미루고 오류를 남긴다.
    await db
      .update(schema.schedules)
      .set({ nextRunAt: addMs(now, CRON_PARSE_FAILURE_BACKOFF_MS) })
      .where(and(eq(schema.schedules.id, s.id), nextRunAtMatches(s.nextRunAt)));
    pass.errors.push({
      scheduleId: s.id,
      message: `cron 해석 실패 — 24시간 뒤 다시 확인: ${redactErrorText(timing.error, 120)}`,
    });
    return;
  }

  // 되돌림 뒤 재가동 등으로 5시간 넘은 회차가 남아 있으면 먼저 정리한다. 아직 받을 항목이 있으면
  // 이번엔 클레임하지 않는다 — 여기서 건너뛰기(skipped_overlap)로 처리하면 다음 정기 시각까지 새 회차가
  // 안 생기기 때문이다. 다음 줄기에서 다시 본다.
  const expired = await retireExpiredForSchedule(s.id, now);
  if (expired === "busy") return;

  for (let attempt = 0; ; attempt++) {
    try {
      const out = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(schema.schedules)
          .set({ nextRunAt: timing.nextRunAt })
          .where(and(eq(schema.schedules.id, s.id), nextRunAtMatches(s.nextRunAt)))
          .returning();
        if (!claimed) return "not_claimed" as const;
        const r = await createRoundForSchedule(
          claimed,
          {
            trigger: timing.trigger,
            scheduledFor: timing.scheduledFor,
            priority: timing.trigger === "first_run" ? 1 : 0,
            onRunning: "skip",
          },
          now,
          tx,
        );
        if (r.status === "running_skipped") {
          // 겹친 회차 — 표시 행만 남기고 last_run_at 은 그대로 둔다(계획 v2 §2-3).
          await tx
            .insert(rounds)
            .values({
              workspaceId: claimed.workspaceId,
              scheduleId: claimed.id,
              trigger: timing.trigger,
              priority: 0,
              status: "skipped_overlap",
              scheduledFor: timing.scheduledFor,
              intervalSlot: formatIntervalSlot(timing.scheduledFor),
              geolocation: claimed.geolocation ?? null,
              expectedItems: 0,
              createdAt: now,
              finishedAt: now,
            })
            .onConflictDoNothing();
          return "skipped" as const;
        }
        return "created" as const;
      });
      if (out === "created") stats.roundsCreated++;
      else if (out === "skipped") stats.roundsSkippedOverlap++;
      return;
    } catch (err) {
      if (attempt === 0 && pgErrorCode(err) === "23505") continue;
      throw err;
    }
  }
}

/** 3. 멈춘 회차 정리 — 스케줄 꺼짐·삭제, 회차 5시간 초과 → 대기 항목만 취소(보내는 중·진행 중은 끝까지) */
async function cancelStoppedRounds(pass: PassCtx, stats: DispatchStats): Promise<void> {
  const { now } = pass;
  const pausedRounds = db
    .select({ id: rounds.id })
    .from(rounds)
    .leftJoin(schema.schedules, eq(schema.schedules.id, rounds.scheduleId))
    .where(
      and(
        eq(rounds.status, "running"),
        or(isNull(rounds.scheduleId), eq(schema.schedules.active, false)),
      ),
    );
  const paused = await db
    .update(items)
    .set({
      status: "cancelled",
      lastErrorCode: "SCHEDULE_PAUSED",
      lastError: "스케줄이 꺼지거나 삭제돼 대기 항목을 취소했다",
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(items.status, "queued"), inArray(items.roundId, pausedRounds)))
    .returning({ id: items.id });

  const expiredRounds = db
    .select({ id: rounds.id })
    .from(rounds)
    .where(and(eq(rounds.status, "running"), lt(rounds.createdAt, addMs(now, -ROUND_MAX_AGE_MS))));
  const expired = await db
    .update(items)
    .set({
      status: "cancelled",
      lastErrorCode: "ROUND_EXPIRED",
      lastError: "회차가 5시간을 넘겨 대기 항목을 취소했다",
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(items.status, "queued"), inArray(items.roundId, expiredRounds)))
    .returning({ id: items.id });

  stats.cancelled += paused.length + expired.length;
}

/** 4. 제출 — AI별로 빈자리만큼 대기 항목을 "보내는 중"으로 먼저 표시한 뒤 동시에 보낸다 */
async function submitQueuedItems(pass: PassCtx, stats: DispatchStats): Promise<void> {
  const { now } = pass;
  const authUntil = await getUntil("auth_pause_until");
  if (authUntil && authUntil.getTime() > now.getTime()) return;
  const countryState = await getStateValue<{ at?: string }>("perplexity_country_failed_at");
  const skipCountry = shouldSkipPerplexityCountry(countryState?.at ? new Date(countryState.at) : null, now);

  const providerRows = await db
    .selectDistinct({ provider: items.provider })
    .from(items)
    .innerJoin(rounds, eq(rounds.id, items.roundId))
    .where(
      and(
        eq(items.status, "queued"),
        or(isNull(items.nextAttemptAt), lte(items.nextAttemptAt, now)),
        eq(rounds.status, "running"),
      ),
    );
  const providers = providerRows.map((r) => r.provider).filter(isKnownProvider);
  const settled = await Promise.allSettled(
    providers.map((p) => submitForProvider(pass, stats, p, skipCountry)),
  );
  for (const r of settled) {
    if (r.status === "rejected") pass.errors.push({ scheduleId: "collector:submit", message: errorMessage(r.reason) });
  }
}

async function submitForProvider(
  pass: PassCtx,
  stats: DispatchStats,
  p: Provider,
  skipCountry: boolean,
): Promise<void> {
  const { now } = pass;
  const rateUntil = await getUntil(`rate_pause:${p}`);
  if (rateUntil && rateUntil.getTime() > now.getTime()) return;

  const [inflight] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.provider, p), inArray(items.status, IN_FLIGHT_STATUSES)));
  const free = getProviderCap(p) - Number(inflight?.n ?? 0);
  if (free <= 0) return;

  const cands = await db
    .select({ item: items })
    .from(items)
    .innerJoin(rounds, eq(rounds.id, items.roundId))
    .where(
      and(
        eq(items.status, "queued"),
        eq(items.provider, p),
        or(isNull(items.nextAttemptAt), lte(items.nextAttemptAt, now)),
        eq(rounds.status, "running"),
      ),
    )
    // 즉시 실행·첫 회차 먼저 → 첫 시도 먼저 → 먼저 만든 회차 → 질문 순서
    .orderBy(desc(rounds.priority), asc(items.paidRetries), asc(rounds.createdAt), asc(items.seq))
    .limit(free * CANDIDATE_MULTIPLIER);

  const seen = new Set<string>();
  const claimed: CollectionItem[] = [];
  for (const { item: c } of cands) {
    if (claimed.length >= free) break;
    const comboKey = `${c.workspaceId}\u0000${c.intervalSlot}\u0000${c.promptText}`;
    if (seen.has(comboKey)) continue;
    seen.add(comboKey);

    // ① 같은 시간대·질문·AI 결과가 이미 있으면 보내지 않는다(무료) — 그 결과를 가리킨다
    const existingRunId = await findAutoRunId(c);
    if (existingRunId) {
      const dup = await db
        .update(items)
        .set({ status: "duplicate", runId: existingRunId, updatedAt: now })
        .where(and(eq(items.id, c.id), eq(items.status, "queued")))
        .returning({ id: items.id });
      if (dup.length > 0) stats.duplicates++;
      continue;
    }
    // ② 다른 회차 항목이 같은 조합을 보내는 중·진행 중이면 1분 뒤로 — 끝나면 ①로 duplicate 가 된다
    const [busy] = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.workspaceId, c.workspaceId),
          eq(items.intervalSlot, c.intervalSlot),
          eq(items.promptText, c.promptText),
          eq(items.provider, c.provider),
          inArray(items.status, IN_FLIGHT_STATUSES),
          ne(items.id, c.id),
        ),
      )
      .limit(1);
    if (busy) {
      await db
        .update(items)
        .set({ nextAttemptAt: addMs(now, IN_FLIGHT_DEFER_MS), updatedAt: now })
        .where(and(eq(items.id, c.id), eq(items.status, "queued")));
      continue;
    }
    // ③ 돈이 드는 요청 전에 "보내는 중"으로 먼저 표시한다(끊기면 복구가 다시 보낸다)
    const country = p === "perplexity" && (skipCountry || c.dropCountry) ? null : c.countryRequested ?? null;
    const [row] = await db
      .update(items)
      .set({
        status: "submitting",
        submitStartedAt: now,
        updatedAt: now,
        attempts: appendAttemptSql({ country, startedAt: now.toISOString() }),
      })
      .where(and(eq(items.id, c.id), eq(items.status, "queued")))
      .returning();
    if (row) claimed.push(row);
  }
  if (claimed.length === 0) return;

  const settled = await Promise.allSettled(claimed.map((item) => submitOne(pass, stats, item)));
  for (const r of settled) {
    if (r.status === "rejected") pass.errors.push({ scheduleId: "collector:submit", message: errorMessage(r.reason) });
  }
}

async function submitOne(pass: PassCtx, stats: DispatchStats, item: CollectionItem): Promise<void> {
  const { now } = pass;
  const p = item.provider as Provider;
  const country = lastAttempt(item)?.country ?? undefined;
  const t0 = performance.now();
  const res = await pass.deps.bd.submitScrape({ provider: p, prompt: item.promptText, country });
  stats.submitted++;

  if (res.ok && res.kind === "snapshot") {
    const startedAt = item.submitStartedAt ?? now;
    await db
      .update(items)
      .set({
        status: "submitted",
        snapshotId: res.snapshotId,
        paidAttempts: sql`${items.paidAttempts} + 1`,
        submittedAt: now,
        firstSubmittedAt: sql`coalesce(${items.firstSubmittedAt}, ${now.toISOString()}::timestamptz)`,
        nextPollAt: addMs(now, FIRST_POLL_DELAY_MS),
        pollDeadlineAt: addMs(startedAt, getPollDeadlineMs(p)),
        pollErrors: 0,
        downloadErrors: 0,
        updatedAt: now,
        attempts: patchLastAttemptSql({ snapshotId: res.snapshotId, accepted: true }),
      })
      .where(and(eq(items.id, item.id), eq(items.status, "submitting")));
    return;
  }

  if (res.ok && res.kind === "payload") {
    // 200 — 요청 번호가 없어 다시 받을 수 없다. 메모리에 쌓지 않고 이 자리에서 저장까지 끝낸다.
    const [row] = await db
      .update(items)
      .set({
        paidAttempts: sql`${items.paidAttempts} + 1`,
        submittedAt: now,
        firstSubmittedAt: sql`coalesce(${items.firstSubmittedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
        attempts: patchLastAttemptSql({ accepted: true }),
      })
      .where(and(eq(items.id, item.id), eq(items.status, "submitting")))
      .returning();
    if (!row) return;
    const outcome = await finalizeWithPayload(pass, row, res.payload, undefined, "submitting", performance.now() - t0);
    countDispatchOutcome(stats, outcome, true);
    return;
  }

  if (res.ok) return; // (형식상 도달하지 않음)
  const message = redactErrorText(res.message);

  if (res.code === "RATE_LIMITED") {
    // 작업이 생기지 않았다(과금 없음). 그 AI 제출을 Retry-After 까지 멈추고 무료로 다시 기다린다.
    const nextFree = item.freeRequeues + 1;
    if (limitReached(nextFree, MAX_FREE_REQUEUES)) {
      const out = await failItem(pass, item, "SUBMIT_FAILED", `요청 몰림 ${nextFree}회 — ${message}`, "submitting", {
        extraSet: { freeRequeues: nextFree },
        attemptOutcome: "failed",
        attemptErrorCode: "RATE_LIMITED",
      });
      countDispatchOutcome(stats, out, false);
      return;
    }
    const delay = Math.max(res.retryAfterMs ?? 0, freeRequeueDelayMs(nextFree));
    const until = addMs(now, delay);
    await db
      .update(items)
      .set({
        status: "queued",
        freeRequeues: nextFree,
        nextAttemptAt: until,
        lastErrorCode: "RATE_LIMITED",
        lastError: message,
        updatedAt: now,
        attempts: patchLastAttemptSql({
          finishedAt: now.toISOString(),
          outcome: "requeued",
          errorCode: "RATE_LIMITED",
          error: message,
        }),
      })
      .where(and(eq(items.id, item.id), eq(items.status, "submitting")));
    await extendUntil(`rate_pause:${p}`, until, now);
    stats.requeued++;
    return;
  }

  if (res.code === "AUTH_ERROR") {
    // 작업이 생기지 않았다. 전체 제출을 10분 멈추고 항목은 그대로 둔다.
    await pauseAuth(pass, message);
    await db
      .update(items)
      .set({
        status: "queued",
        nextAttemptAt: null,
        lastErrorCode: "AUTH_ERROR",
        lastError: message,
        updatedAt: now,
        attempts: patchLastAttemptSql({
          finishedAt: now.toISOString(),
          outcome: "requeued",
          errorCode: "AUTH_ERROR",
          error: message,
        }),
      })
      .where(and(eq(items.id, item.id), eq(items.status, "submitting")));
    stats.requeued++;
    return;
  }

  if (res.code === "HTTP_4XX") {
    // 입력 거절 — 작업이 생기지 않았다. 다시 보내도 같다.
    const out = await failItem(pass, item, "HTTP_4XX", message, "submitting");
    countDispatchOutcome(stats, out, false);
    return;
  }

  // SUBMIT_UNKNOWN — 5xx·네트워크·시간 초과. 작업이 생겼을 수 있다(과금 여부 모름) → 불명으로 세고 다시 보낸다.
  const nextUnknown = item.unknownSubmits + 1;
  if (limitReached(nextUnknown, MAX_UNKNOWN_SUBMITS)) {
    const out = await failItem(pass, item, "SUBMIT_FAILED", `접수 여부 불명 ${nextUnknown}회 — ${message}`, "submitting", {
      extraSet: { unknownSubmits: nextUnknown },
      attemptOutcome: "unknown",
      attemptErrorCode: "SUBMIT_UNKNOWN",
    });
    countDispatchOutcome(stats, out, false);
    return;
  }
  await db
    .update(items)
    .set({
      status: "queued",
      unknownSubmits: nextUnknown,
      nextAttemptAt: addMs(now, freeRequeueDelayMs(nextUnknown)),
      lastErrorCode: "SUBMIT_UNKNOWN",
      lastError: message,
      updatedAt: now,
      attempts: patchLastAttemptSql({
        finishedAt: now.toISOString(),
        outcome: "unknown",
        errorCode: "SUBMIT_UNKNOWN",
        error: message,
      }),
    })
    .where(and(eq(items.id, item.id), eq(items.status, "submitting")));
  stats.requeued++;
}

function countDispatchOutcome(stats: DispatchStats, outcome: FinalizeOutcome | FailOutcome, inline: boolean): void {
  if (outcome === "saved" && inline) stats.savedInline++;
  else if (outcome === "duplicate") stats.duplicates++;
  else if (outcome === "retry") stats.retried++;
  else if (outcome === "failed") stats.failed++;
  else if (outcome === "requeued") stats.requeued++;
}

/**
 * 보내기 줄기 — 재시작 감지 → 끊긴 "보내는 중" 복구 → 회차 만들기 → 멈춘 회차 정리 → 제출.
 * 동기 제출 때문에 한 번에 최대 약 1분 30초 걸린다.
 */
export async function runDispatchPass(now: Date = new Date(), deps?: EngineDeps): Promise<PassResult<DispatchStats>> {
  const t0 = performance.now();
  const pass = newPass(now, deps);
  const stats: DispatchStats = {
    recovered: 0,
    dueSchedules: 0,
    roundsCreated: 0,
    roundsSkippedOverlap: 0,
    cancelled: 0,
    submitted: 0,
    savedInline: 0,
    duplicates: 0,
    requeued: 0,
    retried: 0,
    failed: 0,
    durationMs: 0,
  };
  await runStep(pass, "restart", () => detectProcessRestart(pass));
  await runStep(pass, "recover", () => recoverStaleSubmitting(pass, stats));
  await runStep(pass, "rounds", () => createDueRounds(pass, stats));
  await runStep(pass, "cancel", () => cancelStoppedRounds(pass, stats));
  await runStep(pass, "submit", () => submitQueuedItems(pass, stats));
  stats.durationMs = Math.round(performance.now() - t0);
  return { stats, providerFailures: pass.providerFailures, errors: pass.errors };
}

/* ============================================================
 * 거두기 줄기
 * ============================================================ */

/**
 * 0. 하루 집계 — KST 날짜가 바뀐 뒤 1회.
 *
 * 실패해도 "오늘 시도했다"는 기록을 먼저 남기고 나서 오류를 다시 던진다 — 틱은 1분마다
 * 도니, 기록 없이 실패만 하면 다음 틱이 같은 실패를 또 반복해 [cron/tick] 오류 로그가
 * 매분 쌓인다(2026-09-25 결함 수정). 하루 1회 시도 원칙은 유지 — 다음 날 date 가 바뀌면
 * 다시 시도한다.
 */
async function maybeRunDailyRollup(pass: PassCtx, stats: HarvestStats): Promise<void> {
  const today = kstDateString(pass.now);
  const st = await getStateValue<{ date?: string; error?: string }>("daily_rollup");
  if (st?.date === today) return;
  try {
    const r = await runDailyRollup(pass.now);
    await setStateValue("daily_rollup", { date: today, rolledUp: r.date, rows: r.rows }, pass.now);
    stats.dailyRollup = r;
  } catch (err) {
    await setStateValue("daily_rollup", { date: today, error: errorMessage(err) }, pass.now);
    throw err; // runStep 이 잡아 pass.errors 에 담는다 — 오늘은 이걸로 끝, 로그도 한 번만.
  }
}

type ReadyEntry = { item: CollectionItem; priority: number; progress: { records?: number; errors?: number } };

function countHarvestOutcome(stats: HarvestStats, outcome: FinalizeOutcome | FailOutcome, timeout = false): void {
  if (outcome === "saved") stats.saved++;
  else if (outcome === "duplicate") stats.duplicates++;
  else if (outcome === "retry") stats.retried++;
  else if (outcome === "failed") {
    if (timeout) stats.timeouts++;
    else stats.failed++;
  }
}

/** 1. 진행 확인 — 다음 확인 시각이 된 진행 중 항목을 동시 8개로 확인한다 */
async function pollSubmitted(pass: PassCtx, stats: HarvestStats): Promise<ReadyEntry[]> {
  const { now } = pass;
  const due = await db
    .select({ item: items, priority: rounds.priority })
    .from(items)
    .innerJoin(rounds, eq(rounds.id, items.roundId))
    .where(and(eq(items.status, "submitted"), or(isNull(items.nextPollAt), lte(items.nextPollAt, now))))
    .orderBy(asc(items.nextPollAt))
    .limit(POLL_BATCH_LIMIT);
  const ready: ReadyEntry[] = [];
  await mapPool(
    due,
    POLL_CONCURRENCY,
    async ({ item, priority }) => {
      stats.polled++;
      if (!item.snapshotId) {
        countHarvestOutcome(stats, await failItem(pass, item, "SNAPSHOT_MISSING", "요청 번호 없음", "submitted"));
        return;
      }
      const r = await pass.deps.bd.getSnapshotProgress(item.snapshotId);
      if (r.ok) {
        if (r.status === "ready") {
          ready.push({ item, priority, progress: { records: r.records, errors: r.errors } });
          return;
        }
        if (r.status === "failed") {
          countHarvestOutcome(stats, await failItem(pass, item, "SNAPSHOT_FAILED", "Bright Data 작업 실패", "submitted"));
          return;
        }
        if (r.status === "canceled") {
          countHarvestOutcome(stats, await failItem(pass, item, "SNAPSHOT_CANCELED", "Bright Data 작업 취소됨", "submitted"));
          return;
        }
        // starting · running
        if (item.pollDeadlineAt && now.getTime() >= new Date(item.pollDeadlineAt).getTime()) {
          await pass.deps.bd.cancelSnapshot(item.snapshotId);
          const minutes = Math.round(getPollDeadlineMs(item.provider) / 60_000);
          countHarvestOutcome(
            stats,
            await failItem(pass, item, "TIMEOUT", `대기 한도 ${minutes}분 초과 — 작업 취소 요청`, "submitted"),
            true,
          );
          return;
        }
        const startedAt = item.submitStartedAt ?? item.submittedAt ?? now;
        await db
          .update(items)
          .set({
            nextPollAt: addMs(now, nextPollDelayMs(item.provider, now.getTime() - new Date(startedAt).getTime())),
            updatedAt: now,
          })
          .where(and(eq(items.id, item.id), eq(items.status, "submitted")));
        return;
      }
      if (r.code === "SNAPSHOT_MISSING") {
        countHarvestOutcome(stats, await failItem(pass, item, "SNAPSHOT_MISSING", r.message, "submitted"));
        return;
      }
      if (r.code === "AUTH_ERROR") {
        await pauseAuth(pass, r.message);
        await db
          .update(items)
          .set({ nextPollAt: addMs(now, TRANSIENT_RETRY_MS), updatedAt: now })
          .where(and(eq(items.id, item.id), eq(items.status, "submitted")));
        return;
      }
      // NETWORK · HTTP_4XX — 확인 일시 오류(과금 없음)
      const nextErr = item.pollErrors + 1;
      if (
        limitReached(nextErr, MAX_POLL_ERRORS) &&
        item.pollDeadlineAt &&
        now.getTime() > new Date(item.pollDeadlineAt).getTime()
      ) {
        await pass.deps.bd.cancelSnapshot(item.snapshotId);
        countHarvestOutcome(
          stats,
          await failItem(pass, item, "TIMEOUT", `확인 실패 ${nextErr}회 + 대기 한도 초과 — ${r.message}`, "submitted", {
            extraSet: { pollErrors: nextErr },
          }),
          true,
        );
        return;
      }
      await db
        .update(items)
        .set({ pollErrors: nextErr, nextPollAt: addMs(now, TRANSIENT_RETRY_MS), updatedAt: now })
        .where(and(eq(items.id, item.id), eq(items.status, "submitted")));
    },
    (err) => pass.errors.push({ scheduleId: "collector:poll", message: errorMessage(err) }),
  );
  return ready;
}

/** 2. 내려받기·저장 — 회차 우선순위 → 제출 시각 순, 동시 3. 새 항목 전에 45초 소프트 예산 확인 */
async function downloadReady(
  pass: PassCtx,
  stats: HarvestStats,
  ready: ReadyEntry[],
  passStartedPerf: number,
): Promise<void> {
  const { now } = pass;
  const sorted = [...ready].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const at = a.item.submittedAt ? new Date(a.item.submittedAt).getTime() : 0;
    const bt = b.item.submittedAt ? new Date(b.item.submittedAt).getTime() : 0;
    return at - bt;
  });
  await mapPool(
    sorted,
    DOWNLOAD_CONCURRENCY,
    async ({ item, progress }) => {
      const d = await pass.deps.bd.downloadSnapshotPayload(item.snapshotId!);
      if (d.ok) {
        const startedAt = item.submitStartedAt ?? item.submittedAt ?? now;
        const outcome = await finalizeWithPayload(
          pass,
          item,
          d.payload,
          progress,
          "submitted",
          now.getTime() - new Date(startedAt).getTime(),
        );
        countHarvestOutcome(stats, outcome);
        return;
      }
      if (d.code === "NOT_READY") {
        await db
          .update(items)
          .set({ nextPollAt: addMs(now, NOT_READY_RETRY_MS), updatedAt: now })
          .where(and(eq(items.id, item.id), eq(items.status, "submitted")));
        return;
      }
      if (d.code === "AUTH_ERROR") {
        await pauseAuth(pass, d.message);
        await db
          .update(items)
          .set({ nextPollAt: addMs(now, TRANSIENT_RETRY_MS), updatedAt: now })
          .where(and(eq(items.id, item.id), eq(items.status, "submitted")));
        return;
      }
      // DOWNLOAD_FAILED · NETWORK
      countHarvestOutcome(
        stats,
        await retryDownloadLater(pass, item, "DOWNLOAD_FAILED", d.message, TRANSIENT_RETRY_MS),
      );
    },
    (err) => pass.errors.push({ scheduleId: "collector:download", message: errorMessage(err) }),
    // 소프트 예산 — 넘으면 남은 것은 다음 줄기의 진행 확인이 다시 잡는다
    () => performance.now() - passStartedPerf < HARVEST_SOFT_BUDGET_MS,
  );
}

function formatTopCodes(summary: CollectionRoundSummary, limit = 3): string {
  const entries: { provider: string; code: string; n: number }[] = [];
  for (const [provider, bp] of Object.entries(summary.byProvider)) {
    for (const [code, n] of Object.entries(bp.failedByCode)) entries.push({ provider, code, n });
  }
  entries.sort((a, b) => b.n - a.n || a.provider.localeCompare(b.provider) || a.code.localeCompare(b.code));
  return entries
    .slice(0, limit)
    .map((e) => `${e.provider} ${e.code} ${e.n}`)
    .join(" · ");
}

function logRoundCompleted(
  round: CollectionRound,
  summary: CollectionRoundSummary,
  scheduleName: string | null,
  now: Date,
): void {
  const minutes = Math.round((now.getTime() - new Date(round.createdAt).getTime()) / 60_000);
  const codes = formatTopCodes(summary);
  console.log(
    `[collector] 회차 완료 ${scheduleName ?? round.scheduleId ?? "(삭제된 스케줄)"} slot=${round.intervalSlot} ` +
      `저장 ${summary.saved}/${round.expectedItems} · 중복 ${summary.duplicate} · 실패 ${summary.failed} · 취소 ${summary.cancelled}` +
      `${codes ? ` (${codes})` : ""} · ${minutes}분`,
  );
}

/** 3. 회차 마감 — 남은 항목(대기·보내는 중·진행 중)이 0 인 진행 중 회차를 닫고 요약을 남긴다 */
async function completeFinishedRounds(pass: PassCtx, stats: HarvestStats): Promise<void> {
  const { now } = pass;
  const candidates = await db
    .select({ id: rounds.id, scheduleName: schema.schedules.name })
    .from(rounds)
    .leftJoin(schema.schedules, eq(schema.schedules.id, rounds.scheduleId))
    .where(
      and(
        eq(rounds.status, "running"),
        sql`not exists (select 1 from ${items} where ${items.roundId} = ${rounds.id}
              and ${items.status} in ('queued', 'submitting', 'submitted'))`,
      ),
    );
  for (const c of candidates) {
    try {
      const done = await db.transaction((tx) => completeRoundIfDoneTx(tx, c.id, now));
      if (done) {
        stats.roundsCompleted++;
        logRoundCompleted(done.round, done.summary, c.scheduleName ?? null, now);
      }
    } catch (err) {
      pass.errors.push({ scheduleId: "collector:complete", message: errorMessage(err) });
    }
  }
}

/**
 * 거두기 줄기 — 하루 집계(날짜 바뀐 뒤 1회) → 진행 확인 → 내려받기·저장 → 회차 마감.
 * 보통 몇 초～1분.
 */
export async function runHarvestPass(now: Date = new Date(), deps?: EngineDeps): Promise<PassResult<HarvestStats>> {
  const t0 = performance.now();
  const pass = newPass(now, deps);
  const stats: HarvestStats = {
    polled: 0,
    saved: 0,
    duplicates: 0,
    retried: 0,
    failed: 0,
    timeouts: 0,
    roundsCompleted: 0,
    dailyRollup: null,
    durationMs: 0,
  };
  await runStep(pass, "rollup", () => maybeRunDailyRollup(pass, stats));
  let ready: ReadyEntry[] = [];
  await runStep(pass, "poll", async () => {
    ready = await pollSubmitted(pass, stats);
  });
  await runStep(pass, "download", () => downloadReady(pass, stats, ready, t0));
  await runStep(pass, "complete", () => completeFinishedRounds(pass, stats));
  stats.durationMs = Math.round(performance.now() - t0);
  return { stats, providerFailures: pass.providerFailures, errors: pass.errors };
}

/* ============================================================
 * 상태 조회 — 화면 진행 한 줄·상태 API 용
 * ============================================================ */

/**
 * 회차별 상태 개수·AI별 개수·상위 오류 코드. 요청 번호·Bright Data 원문 오류는 내보내지 않는다(코드만).
 */
export async function getRoundsOverview(
  workspaceId: string,
  opts: { limit: number; scheduleId?: string },
): Promise<RoundOverview[]> {
  const roundRows = await db
    .select({ round: rounds, scheduleName: schema.schedules.name })
    .from(rounds)
    .leftJoin(schema.schedules, eq(schema.schedules.id, rounds.scheduleId))
    .where(
      and(
        eq(rounds.workspaceId, workspaceId),
        opts.scheduleId ? eq(rounds.scheduleId, opts.scheduleId) : undefined,
      ),
    )
    .orderBy(desc(rounds.createdAt))
    .limit(opts.limit);
  if (roundRows.length === 0) return [];
  const ids = roundRows.map((r) => r.round.id);
  const countRows = await db
    .select({
      roundId: items.roundId,
      provider: items.provider,
      status: items.status,
      code: items.lastErrorCode,
      n: sql<number>`count(*)::int`,
    })
    .from(items)
    .where(inArray(items.roundId, ids))
    .groupBy(items.roundId, items.provider, items.status, items.lastErrorCode);

  const byRound = new Map<string, typeof countRows>();
  for (const r of countRows) {
    const list = byRound.get(r.roundId) ?? [];
    list.push(r);
    byRound.set(r.roundId, list);
  }

  return roundRows.map(({ round, scheduleName }) => {
    const counts = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
    const byProvider: RoundOverview["byProvider"] = {};
    const errorCounts = new Map<string, { provider: string; code: string; count: number }>();
    for (const r of byRound.get(round.id) ?? []) {
      const n = Number(r.n);
      const status = r.status as ItemStatus;
      if (status in counts) counts[status] += n;
      const bp = (byProvider[r.provider] ??= { saved: 0, duplicate: 0, failed: 0, cancelled: 0, pending: 0 });
      if (status === "saved") bp.saved += n;
      else if (status === "duplicate") bp.duplicate += n;
      else if (status === "failed") bp.failed += n;
      else if (status === "cancelled") bp.cancelled += n;
      else if (PENDING_STATUSES.includes(status)) bp.pending += n;
      if (status === "failed") {
        const code = r.code ?? "UNKNOWN";
        const key = `${r.provider}\u0000${code}`;
        const cur = errorCounts.get(key) ?? { provider: r.provider, code, count: 0 };
        cur.count += n;
        errorCounts.set(key, cur);
      }
    }
    const topErrors = [...errorCounts.values()]
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
      .slice(0, 5);
    return {
      id: round.id,
      scheduleId: round.scheduleId,
      scheduleName: scheduleName ?? null,
      trigger: round.trigger,
      status: round.status,
      priority: round.priority,
      scheduledFor: new Date(round.scheduledFor).toISOString(),
      intervalSlot: round.intervalSlot,
      createdAt: new Date(round.createdAt).toISOString(),
      finishedAt: round.finishedAt ? new Date(round.finishedAt).toISOString() : null,
      expected: round.expectedItems,
      counts,
      byProvider,
      topErrors,
    };
  });
}
