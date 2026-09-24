/**
 * collector-engine.int.test.ts — 새 수집 엔진 통합 테스트 (로컬 DB · 가짜 Bright Data).
 * 계획 geotracker-collect-speed-260924 §11 시나리오 a～s + 88항목 성능 확인.
 *
 * 실행: GEO_TEST_POSTGRES_URL=<로컬 시험 DB> GEO_REQUIRE_DB_TESTS=1 npx vitest run lib/server/collector-engine.int.test.ts
 *   - URL 이 없으면 건너뛴다. GEO_REQUIRE_DB_TESTS=1 이면 URL 이 없을 때 실패한다.
 *   - 호스트가 로컬이 아니거나 DB 이름에 "test" 가 없으면 즉시 중단한다(test-support/int-db.ts).
 *
 * Bright Data 4개 함수는 가짜(FakeBd), normalizeScrapePayload 는 실제, 감성 분류는 가짜다.
 * 전역 fetch 도 가짜로 바꿔 두어, 실수로 실제 네트워크를 부르면 즉시 실패한다(수집 1건마다 과금).
 * ⚠️ PUBLIC 저장소 — 질문·브랜드·도메인은 전부 가짜 값이다.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { BrandConfig, CollectionItem, CollectionRound, Schedule } from "@/drizzle/schema";
import type { SubmitResult, SnapshotProgressStatus } from "./brightdata-scraper";
import {
  TEST_WORKSPACE_PREFIX,
  assertOnlyTestData,
  ensureTestDatabase,
  migrateTestDatabase,
  readIntDbConfig,
} from "./test-support/int-db";

// 감성 분류(LLM)는 가짜 — 예전 엔진(runTick)과 새 엔진이 같은 가짜를 쓴다.
vi.mock("@/lib/server/llm-sentiment", () => ({
  classifySentiment: vi.fn(async () => null),
}));

const CFG = readIntDbConfig();
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url; // db 모듈은 첫 쿼리 때 이 값을 읽는다

type Engine = typeof import("./collector-engine");
type Runner = typeof import("./automation-runner");
type DbMod = typeof import("./db");

let engine: Engine;
let runner: Runner;
let dbm: DbMod;
let savedState: { key: string; value: Record<string, unknown>; updatedAt: Date }[] = [];

/* ------------------------------------------------------------------
 * 전역 fetch 가드 — 가짜 Bright Data 를 거치지 않은 네트워크 호출은 전부 실패
 * ------------------------------------------------------------------ */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
const unexpectedFetch: FetchHandler = async (url) => {
  throw new Error(`통합 테스트에서 예상하지 못한 네트워크 호출: ${String(url).slice(0, 60)}`);
};
let fetchHandler: FetchHandler = unexpectedFetch;

/* ------------------------------------------------------------------
 * 가짜 Bright Data
 * ------------------------------------------------------------------ */
type Job = {
  id: string;
  provider: string;
  prompt: string;
  country?: string;
  status: SnapshotProgressStatus;
  payload: unknown;
  records?: number;
  errors?: number;
};
type SubmitReq = { provider: string; prompt: string; country?: string };

function answerPayload(req: { provider: string; prompt: string }): unknown {
  return [{ answer_text: `가짜 응답입니다 — ${req.provider} 가 "${req.prompt}" 질문에 답한 시험용 문장입니다.` }];
}

class FakeBd {
  jobs = new Map<string, Job>();
  submits: SubmitReq[] = [];
  progressCalls: string[] = [];
  downloadCalls: string[] = [];
  cancelCalls: string[] = [];
  private seq = 0;
  /** 기본: 요청 번호를 주고 작업은 곧바로 준비됨 */
  onSubmit: (req: SubmitReq) => SubmitResult | Promise<SubmitResult> = (req) => this.snapshot(req, "ready");

  snapshot(req: SubmitReq, status: SnapshotProgressStatus, payload?: unknown): SubmitResult {
    const id = `snap-${++this.seq}`;
    this.jobs.set(id, { id, ...req, status, payload: payload ?? answerPayload(req) });
    return { ok: true, kind: "snapshot", snapshotId: id };
  }

  inline(req: SubmitReq, payload?: unknown): SubmitResult {
    return { ok: true, kind: "payload", payload: payload ?? answerPayload(req) };
  }

  setStatus(pred: (j: Job) => boolean, status: SnapshotProgressStatus): void {
    for (const j of this.jobs.values()) if (pred(j)) j.status = status;
  }

  submitCount(pred: (s: SubmitReq) => boolean = () => true): number {
    return this.submits.filter(pred).length;
  }

  client() {
    return {
      submitScrape: async (req: { provider: string; prompt: string; country?: string }) => {
        const r: SubmitReq = { provider: req.provider, prompt: req.prompt, country: req.country };
        this.submits.push(r);
        return this.onSubmit(r);
      },
      getSnapshotProgress: async (id: string) => {
        this.progressCalls.push(id);
        const j = this.jobs.get(id);
        if (!j) return { ok: false as const, code: "SNAPSHOT_MISSING" as const, message: "404" };
        return { ok: true as const, status: j.status, records: j.records, errors: j.errors };
      },
      downloadSnapshotPayload: async (id: string) => {
        this.downloadCalls.push(id);
        const j = this.jobs.get(id);
        if (!j) return { ok: false as const, code: "DOWNLOAD_FAILED" as const, message: "404" };
        return { ok: true as const, payload: j.payload };
      },
      cancelSnapshot: async (id: string) => {
        this.cancelCalls.push(id);
        const j = this.jobs.get(id);
        if (j && j.status !== "ready") j.status = "canceled";
      },
    };
  }
}

const nullClassifier = async () => null;
function deps(fake: FakeBd, extra: Record<string, unknown> = {}) {
  return { bd: fake.client(), classifySentiment: nullClassifier, ...extra } as Parameters<Engine["runDispatchPass"]>[1];
}

/* ------------------------------------------------------------------
 * 시험 데이터 도우미
 * ------------------------------------------------------------------ */
const T0 = new Date("2031-05-05T03:00:30.000Z"); // UTC·KST 어느 쪽이든 6시간 cron 경계 직후
const at = (secs: number, base: Date = T0) => new Date(base.getTime() + secs * 1000);
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");

const BRAND: BrandConfig = {
  brandName: "시험브랜드",
  brandAliases: "TestBrand",
  websites: ["https://brand.example"],
  industry: "",
  keywords: "",
  description: "",
};

let wsCounter = 0;
async function makeWorkspace(label: string) {
  const { db, schema } = dbm;
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ name: `${TEST_WORKSPACE_PREFIX}${label}-${++wsCounter}`, brandConfig: BRAND, isProduction: false })
    .returning();
  return ws;
}

async function makePrompts(wsId: string, texts: string[]) {
  const { db, schema } = dbm;
  const out: { id: string; text: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const [p] = await db
      .insert(schema.prompts)
      .values({ workspaceId: wsId, text: texts[i], createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)) })
      .returning({ id: schema.prompts.id, text: schema.prompts.text });
    out.push(p);
  }
  return out;
}

function promptTexts(label: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `시험 질문 ${label} ${String(i + 1).padStart(2, "0")}`);
}

async function makeSchedule(
  wsId: string,
  o: { providers: string[]; nextRunAt: Date | null; promptIds?: string[]; cron?: string; name?: string; active?: boolean },
): Promise<Schedule> {
  const { db, schema } = dbm;
  const [s] = await db
    .insert(schema.schedules)
    .values({
      workspaceId: wsId,
      name: o.name ?? "시험 스케줄",
      cronExpression: o.cron ?? "0 */6 * * *",
      providers: o.providers,
      promptIds: o.promptIds ?? [],
      active: o.active ?? true,
      nextRunAt: o.nextRunAt,
    })
    .returning();
  return s;
}

async function roundsOf(scheduleId: string): Promise<CollectionRound[]> {
  const { db, schema } = dbm;
  return db
    .select()
    .from(schema.collectionRounds)
    .where(eq(schema.collectionRounds.scheduleId, scheduleId))
    .orderBy(schema.collectionRounds.createdAt);
}

async function itemsOfRound(roundId: string): Promise<CollectionItem[]> {
  const { db, schema } = dbm;
  return db
    .select()
    .from(schema.collectionItems)
    .where(eq(schema.collectionItems.roundId, roundId))
    .orderBy(schema.collectionItems.seq);
}

async function itemsOfWorkspace(wsId: string): Promise<CollectionItem[]> {
  const { db, schema } = dbm;
  return db.select().from(schema.collectionItems).where(eq(schema.collectionItems.workspaceId, wsId));
}

async function runsOf(wsId: string) {
  const { db, schema } = dbm;
  return db.select().from(schema.runs).where(eq(schema.runs.workspaceId, wsId));
}

async function scheduleRow(id: string): Promise<Schedule> {
  const { db, schema } = dbm;
  const [s] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, id));
  return s;
}

async function stateRow(key: string) {
  const { db, schema } = dbm;
  const [r] = await db.select().from(schema.collectorState).where(eq(schema.collectorState.key, key));
  return r ?? null;
}

async function pendingCount(wsId: string): Promise<number> {
  const { db, schema } = dbm;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.collectionItems)
    .where(
      and(
        eq(schema.collectionItems.workspaceId, wsId),
        inArray(schema.collectionItems.status, ["queued", "submitting", "submitted"]),
      ),
    );
  return Number(r?.n ?? 0);
}

async function runningRounds(wsId: string): Promise<number> {
  const { db, schema } = dbm;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.collectionRounds)
    .where(and(eq(schema.collectionRounds.workspaceId, wsId), eq(schema.collectionRounds.status, "running")));
  return Number(r?.n ?? 0);
}

/** 거두기·보내기를 번갈아 돌려 워크스페이스의 대기 항목·진행 중 회차가 0 이 될 때까지. 마지막 시각을 돌려준다. */
async function runUntilIdle(wsId: string, d: ReturnType<typeof deps>, start: Date, stepSecs = 61, maxSteps = 40): Promise<Date> {
  let t = start;
  for (let i = 0; i < maxSteps; i++) {
    await engine.runHarvestPass(t, d);
    await engine.runDispatchPass(t, d);
    await engine.runHarvestPass(t, d);
    if ((await pendingCount(wsId)) === 0 && (await runningRounds(wsId)) === 0) return t;
    t = at(stepSecs, t);
  }
  throw new Error("대기 항목이 끝나지 않았다");
}

async function cleanAll() {
  const { db, schema } = dbm;
  await db.delete(schema.workspaces).where(like(schema.workspaces.name, `${TEST_WORKSPACE_PREFIX}%`));
  await db.delete(schema.collectorState);
  engine._resetCollectorMemoryForTest();
  fetchHandler = unexpectedFetch;
  vi.unstubAllEnvs();
}

/* ------------------------------------------------------------------ */

if (!CFG.enabled && CFG.mustFail) {
  describe("collector-engine 통합 테스트", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("collector-engine 통합 (로컬 DB · 가짜 Bright Data)", () => {
  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => fetchHandler(String(url), init));
    dbm = await import("./db");
    engine = await import("./collector-engine");
    runner = await import("./automation-runner");
    savedState = await dbm.db.select().from(dbm.schema.collectorState);
    await cleanAll();
  }, 120_000);

  afterEach(async () => {
    await cleanAll();
  });

  afterAll(async () => {
    if (!dbm) return;
    await cleanAll();
    if (savedState.length > 0) await dbm.db.insert(dbm.schema.collectorState).values(savedState).onConflictDoNothing();
    const g = globalThis as unknown as { __geotracker_pg_client?: { end: () => Promise<void> } };
    await g.__geotracker_pg_client?.end();
    vi.unstubAllGlobals();
  });

  it("a · 때가 된 스케줄 → 회차 1 + 항목 = 질문 × AI · 다음 시각 전진 · last_run_at · 점수 기준 저장", async () => {
    const ws = await makeWorkspace("a");
    await makePrompts(ws.id, promptTexts("a", 3));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt", "perplexity"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    const res = await engine.runDispatchPass(T0, deps(fake));
    expect(res.errors).toEqual([]);
    expect(res.stats.roundsCreated).toBe(1);

    const rs = await roundsOf(s.id);
    expect(rs).toHaveLength(1);
    const r = rs[0];
    expect(r.status).toBe("running");
    expect(r.trigger).toBe("cron");
    expect(r.priority).toBe(0);
    expect(r.expectedItems).toBe(6);
    expect(r.intervalSlot).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    expect(r.scoringSnapshot?.brandConfig.brandName).toBe("시험브랜드");
    expect(r.scoringSnapshot?.competitors).toEqual([]);

    const its = await itemsOfRound(r.id);
    expect(its).toHaveLength(6);
    expect(new Set(its.map((i) => i.seq))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(its.every((i) => i.countryRequested === "KR" && i.intervalSlot === r.intervalSlot)).toBe(true);
    expect(its.filter((i) => i.status === "submitted")).toHaveLength(6); // 상한 4 안쪽이라 전부 제출

    const after = await scheduleRow(s.id);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(T0.getTime());
    expect(after.lastRunAt!.toISOString()).toBe(T0.toISOString());
  }, 60_000);

  it("b · 상한 — 22 × 4 에서 첫 보내기 줄기는 AI별 4개 · 88항목 보내기·거두기 각 10초 이내", async () => {
    const ws = await makeWorkspace("b");
    await makePrompts(ws.id, promptTexts("b", 22));
    const providers = ["chatgpt", "gemini", "google_ai", "perplexity"];
    await makeSchedule(ws.id, { providers, nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    const d = await engine.runDispatchPass(T0, deps(fake));
    expect(d.errors).toEqual([]);
    const its = await itemsOfWorkspace(ws.id);
    expect(its).toHaveLength(88);
    for (const p of providers) {
      const inflight = its.filter((i) => i.provider === p && (i.status === "submitting" || i.status === "submitted"));
      expect(inflight, p).toHaveLength(4);
    }
    expect(its.filter((i) => i.status === "queued")).toHaveLength(72);
    expect(d.stats.durationMs).toBeLessThan(10_000);

    fake.setStatus(() => true, "ready");
    const h = await engine.runHarvestPass(at(31), deps(fake));
    expect(h.errors).toEqual([]);
    expect(h.stats.saved).toBe(16);
    expect(h.stats.durationMs).toBeLessThan(10_000);
    console.log(`[perf] 88항목 — 보내기 ${d.stats.durationMs}ms · 거두기 ${h.stats.durationMs}ms`);
  }, 60_000);

  it("c · 느린 AI 비차단 — perplexity 진행 중에도 chatgpt 는 빈자리마다 다음 항목이 제출된다", async () => {
    const ws = await makeWorkspace("c");
    await makePrompts(ws.id, promptTexts("c", 6));
    await makeSchedule(ws.id, { providers: ["chatgpt", "perplexity"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, req.provider === "chatgpt" ? "ready" : "running");

    await engine.runDispatchPass(T0, deps(fake));
    expect(fake.submitCount((s) => s.provider === "chatgpt")).toBe(4);
    expect(fake.submitCount((s) => s.provider === "perplexity")).toBe(4);

    const h = await engine.runHarvestPass(at(31), deps(fake));
    expect(h.stats.saved).toBe(4); // chatgpt 4건 저장, perplexity 는 아직 진행 중

    await engine.runDispatchPass(at(61), deps(fake));
    expect(fake.submitCount((s) => s.provider === "chatgpt")).toBe(6); // 남은 2건이 바로 제출
    expect(fake.submitCount((s) => s.provider === "perplexity")).toBe(4); // 상한이 차 있어 그대로
  }, 60_000);

  it("d · 이어받기 — 프로세스 메모리를 비운 뒤 거두기 줄기가 같은 요청 번호로 확인 · 제출 수 = 항목 수", async () => {
    const ws = await makeWorkspace("d");
    await makePrompts(ws.id, promptTexts("d", 3));
    await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    await engine.runDispatchPass(T0, deps(fake));
    const submittedIds = new Set((await itemsOfWorkspace(ws.id)).map((i) => i.snapshotId));
    expect(submittedIds.size).toBe(3);

    // 재시작 흉내 — 메모리 상태를 비우고 새 가짜 클라이언트(같은 Bright Data 작업)로 이어서 받는다
    engine._resetCollectorMemoryForTest();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fake.setStatus(() => true, "ready");
    const h = await engine.runHarvestPass(at(31), deps(fake));
    await engine.runDispatchPass(at(32), deps(fake));
    expect(h.stats.saved).toBe(3);
    expect(new Set(fake.progressCalls)).toEqual(submittedIds);
    expect(log.mock.calls.some((c) => String(c[0]).includes("[collector] 재시작 감지"))).toBe(true);
    log.mockRestore();

    await runUntilIdle(ws.id, deps(fake), at(40));
    expect(fake.submitCount()).toBe(3);
    expect((await runsOf(ws.id)).length).toBe(3);
  }, 60_000);

  it("e · 접수 뒤 응답 유실 — '보내는 중'으로 끊긴 항목을 150초 뒤 되돌려 다시 제출 · unknown_submits 1 · 최종 saved", async () => {
    const ws = await makeWorkspace("e");
    await makePrompts(ws.id, promptTexts("e", 1));
    await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    let release: (r: SubmitResult) => void = () => {};
    let first = true;
    fake.onSubmit = (req) => {
      if (first) {
        first = false;
        // 첫 요청은 Bright Data 가 받았지만 응답이 오지 않는 상황 — 끝나지 않는 요청으로 흉내 낸다
        return new Promise<SubmitResult>((resolve) => {
          release = resolve;
        });
      }
      return fake.snapshot(req, "ready");
    };

    const hanging = engine.runDispatchPass(T0, deps(fake));
    for (let i = 0; i < 100 && fake.submitCount() < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fake.submitCount()).toBe(1);
    const [stuck] = await itemsOfWorkspace(ws.id);
    expect(stuck.status).toBe("submitting");

    // 151초 뒤 다른 보내기 줄기가 끊긴 항목을 되돌려 다시 보낸다
    const d2 = await engine.runDispatchPass(at(151), deps(fake));
    expect(d2.stats.recovered).toBe(1);
    expect(fake.submitCount()).toBe(2);
    await engine.runHarvestPass(at(182), deps(fake));

    // 첫 요청의 응답이 뒤늦게 와도 이미 다른 상태라 아무것도 바꾸지 않는다
    release({ ok: true, kind: "snapshot", snapshotId: "snap-late" });
    await hanging;

    const [it1] = await itemsOfWorkspace(ws.id);
    expect(it1.status).toBe("saved");
    expect(it1.unknownSubmits).toBe(1);
    expect(it1.paidAttempts).toBe(1);
    expect(it1.attempts).toHaveLength(2);
    expect(it1.attempts[0].outcome).toBe("unknown");
    expect(it1.attempts[1].outcome).toBe("saved");
    expect(fake.submitCount()).toBe(2);
    expect((await runsOf(ws.id)).length).toBe(1);
  }, 60_000);

  it("f · 200 받은 뒤 저장 실패 → queued 로 돌아가 다시 수집 → saved · persist_errors 1 · runs 1건", async () => {
    const ws = await makeWorkspace("f");
    await makePrompts(ws.id, promptTexts("f", 1));
    await makeSchedule(ws.id, { providers: ["gemini"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.inline(req);
    let failOnce = true;
    const insertAutoRun: Runner["insertAutoRun"] = async (values, tx) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("가짜 저장 실패");
      }
      return runner.insertAutoRun(values, tx);
    };

    const d1 = await engine.runDispatchPass(T0, deps(fake, { insertAutoRun }));
    expect(d1.stats.requeued).toBe(1);
    let [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("queued");
    expect(item.persistErrors).toBe(1);
    expect(item.lastErrorCode).toBe("PERSIST_FAILED");

    const d2 = await engine.runDispatchPass(at(61), deps(fake, { insertAutoRun }));
    expect(d2.stats.savedInline).toBe(1);
    [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("saved");
    expect(item.persistErrors).toBe(1);
    expect(item.paidAttempts).toBe(2);
    expect(item.runId).not.toBeNull();
    expect(fake.submitCount()).toBe(2);
    expect((await runsOf(ws.id)).length).toBe(1);
  }, 60_000);

  it("g · 겹치는 두 스케줄 같은 시간대 — 겹친 항목은 먼저 보낸 쪽을 기다렸다가 duplicate · runs 중복 0 · 요약 합 = expected", async () => {
    const ws = await makeWorkspace("g");
    const [p1, p2, p3] = await makePrompts(ws.id, promptTexts("g", 3));
    const sA = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60), promptIds: [p1.id, p2.id], name: "A" });
    const sB = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60), promptIds: [p2.id, p3.id], name: "B" });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    await engine.runDispatchPass(T0, deps(fake));
    expect(fake.submitCount((s) => s.prompt === p2.text)).toBe(1); // 같은 조합은 한 번만
    await engine.runHarvestPass(at(31), deps(fake));
    await engine.runDispatchPass(at(40), deps(fake)); // 겹친 항목은 1분 뒤로 미뤄진다
    expect(fake.submitCount((s) => s.prompt === p2.text)).toBe(1);

    fake.setStatus(() => true, "ready");
    await runUntilIdle(ws.id, deps(fake), at(95));

    expect(fake.submitCount((s) => s.prompt === p2.text)).toBe(1);
    const runs = await runsOf(ws.id);
    expect(runs).toHaveLength(3);
    const p2Items = (await itemsOfWorkspace(ws.id)).filter((i) => i.promptText === p2.text);
    expect(p2Items.map((i) => i.status).sort()).toEqual(["duplicate", "saved"]);
    expect(new Set(p2Items.map((i) => i.runId)).size).toBe(1);
    expect(p2Items[0].runId).not.toBeNull();

    for (const s of [sA, sB]) {
      const [r] = await roundsOf(s.id);
      expect(r.status).toBe("completed");
      const sum = r.summary!;
      expect(sum.saved + sum.duplicate + sum.failed + sum.cancelled).toBe(r.expectedItems);
      expect(r.expectedItems).toBe(2);
    }
  }, 60_000);

  it("h · 먼저 실패한 조합은 두 번째 회차가 자기 첫 시도로 제출한다", async () => {
    const ws = await makeWorkspace("h");
    const [p1] = await makePrompts(ws.id, promptTexts("h", 1));
    await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60), promptIds: [p1.id], name: "A" });
    await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60), promptIds: [p1.id], name: "B" });
    const fake = new FakeBd();
    let n = 0;
    fake.onSubmit = (req) =>
      ++n === 1 ? { ok: false, code: "HTTP_4XX", message: "400 입력 거절(시험)" } : fake.inline(req);

    await engine.runDispatchPass(T0, deps(fake));
    await engine.runDispatchPass(at(1), deps(fake));
    const its = await itemsOfWorkspace(ws.id);
    const failed = its.find((i) => i.status === "failed");
    const saved = its.find((i) => i.status === "saved");
    expect(failed?.lastErrorCode).toBe("HTTP_4XX");
    expect(saved?.paidRetries).toBe(0);
    expect(saved?.paidAttempts).toBe(1);
    expect(fake.submitCount()).toBe(2);
  }, 60_000);

  it("i · 순서 — 우선순위 1 회차가 정기 회차보다 먼저 · 첫 시도가 재시도보다 먼저", async () => {
    vi.stubEnv("GEO_COLLECTOR_CAP_CHATGPT", "2");
    const ws = await makeWorkspace("i");
    const ps = await makePrompts(ws.id, promptTexts("i", 6));
    const regular = await makeSchedule(ws.id, {
      providers: ["chatgpt"],
      nextRunAt: at(-60),
      promptIds: ps.slice(0, 4).map((p) => p.id),
      name: "정기",
    });
    const manual = await makeSchedule(ws.id, {
      providers: ["chatgpt"],
      nextRunAt: FAR_FUTURE,
      promptIds: ps.slice(4).map((p) => p.id),
      name: "즉시",
    });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    await engine.runDispatchPass(T0, deps(fake));
    expect(fake.submits.map((s) => s.prompt)).toEqual([ps[0].text, ps[1].text]);

    // 정기 회차의 3번째 질문은 재시도 대기 상태로 만든다(첫 시도가 먼저여야 한다)
    const [rr] = await roundsOf(regular.id);
    await dbm.db
      .update(dbm.schema.collectionItems)
      .set({ paidRetries: 1 })
      .where(and(eq(dbm.schema.collectionItems.roundId, rr.id), eq(dbm.schema.collectionItems.promptText, ps[2].text)));

    const created = await engine.createRoundForSchedule(
      manual,
      { trigger: "manual", scheduledFor: at(5), priority: 1, onRunning: "top_up" },
      at(5),
    );
    expect(created.status).toBe("created");

    fake.setStatus(() => true, "ready");
    await engine.runHarvestPass(at(40), deps(fake));
    await engine.runDispatchPass(at(41), deps(fake));
    expect(fake.submits.slice(2).map((s) => s.prompt)).toEqual([ps[4].text, ps[5].text]);

    fake.setStatus(() => true, "ready");
    await engine.runHarvestPass(at(80), deps(fake));
    vi.stubEnv("GEO_COLLECTOR_CAP_CHATGPT", "1");
    await engine.runDispatchPass(at(81), deps(fake));
    expect(fake.submits.slice(4).map((s) => s.prompt)).toEqual([ps[3].text]); // 재시도(3번째)보다 첫 시도(4번째) 먼저
  }, 60_000);

  it("j · perplexity 지역값 — 지역값 실패 → 지역값 없이 재시도(예산 밖) → 다시 실패 → 일반 재시도(10분 뒤) → failed", async () => {
    const ws = await makeWorkspace("j");
    await makePrompts(ws.id, promptTexts("j", 1));
    const s = await makeSchedule(ws.id, { providers: ["perplexity"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.inline(req, [{ error: "Auth wall: sign-up prompt detected", error_code: "crawl_failed" }]);

    await engine.runDispatchPass(T0, deps(fake));
    let [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("queued");
    expect(item.countryFallbacks).toBe(1);
    expect(item.dropCountry).toBe(true);
    expect(item.paidRetries).toBe(0);
    expect((await stateRow("perplexity_country_failed_at"))?.value).toEqual({ at: T0.toISOString() });

    await engine.runDispatchPass(at(1), deps(fake));
    [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("queued");
    expect(item.paidRetries).toBe(1);
    expect(item.nextAttemptAt!.getTime()).toBe(at(1).getTime() + 10 * 60_000);

    await engine.runDispatchPass(at(5 * 60), deps(fake)); // 아직 10분 전 — 보내지 않는다
    expect(fake.submitCount()).toBe(2);

    await engine.runDispatchPass(at(1 + 10 * 60), deps(fake));
    [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("failed");
    expect(item.lastErrorCode).toBe("CRAWLER_AUTH_WALL");
    expect(item.paidAttempts).toBe(3);
    expect(fake.submits.map((x) => x.country)).toEqual(["KR", undefined, undefined]);

    await engine.runHarvestPass(at(2 + 10 * 60), deps(fake));
    const [r] = await roundsOf(s.id);
    expect(r.status).toBe("completed");
    expect(r.summary?.failed).toBe(1);
    expect(r.summary?.countryFallbacks).toBe(1);
    expect(r.summary?.paidRetries).toBe(1);
    expect(r.summary?.paidAttempts).toBe(3);
    expect(r.summary?.byProvider.perplexity.failedByCode).toEqual({ CRAWLER_AUTH_WALL: 1 });
  }, 60_000);

  it("k · 재시도 예산 경쟁 — 보내기(200 경로)와 거두기가 동시에 실패를 처리해도 paid_retries 합 ≤ 예산", async () => {
    const ws = await makeWorkspace("k");
    const [p1, p2, p3] = await makePrompts(ws.id, promptTexts("k", 3));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: FAR_FUTURE });
    const created = await engine.createRoundForSchedule(
      s,
      { trigger: "cron", scheduledFor: T0, priority: 0, onRunning: "skip" },
      T0,
    );
    if (created.status !== "created") throw new Error("회차가 만들어져야 한다");
    const fake = new FakeBd();
    const crawlerPayload = [{ error: "Browser disconnected" }];
    // p2 는 이미 진행 중(요청 번호 보유) — 준비됐지만 결과가 수집기 오류
    fake.jobs.set("snap-k2", { id: "snap-k2", provider: "chatgpt", prompt: p2.text, status: "ready", payload: crawlerPayload });
    const { db, schema } = dbm;
    await db
      .update(schema.collectionItems)
      .set({
        status: "submitted",
        snapshotId: "snap-k2",
        submitStartedAt: T0,
        submittedAt: T0,
        nextPollAt: T0,
        pollDeadlineAt: at(600),
        paidAttempts: 1,
        attempts: [{ n: 1, country: "KR", startedAt: T0.toISOString(), snapshotId: "snap-k2", accepted: true }],
      })
      .where(and(eq(schema.collectionItems.roundId, created.round.id), eq(schema.collectionItems.promptText, p2.text)));
    // p1 은 보내기 줄기에서 200 으로 수집기 오류, p3 은 정상 진행
    fake.onSubmit = async (req) => {
      if (req.prompt === p1.text) {
        await new Promise((r) => setTimeout(r, 15));
        return fake.inline(req, crawlerPayload);
      }
      return fake.snapshot(req, "running");
    };

    await Promise.all([engine.runDispatchPass(at(1), deps(fake)), engine.runHarvestPass(at(1), deps(fake))]);

    const its = await itemsOfRound(created.round.id);
    const budget = 1; // 3건 × 0.2 → max(1, ceil(0.6)) = 1
    expect(its.reduce((sum, i) => sum + i.paidRetries, 0)).toBeLessThanOrEqual(budget);
    const pair = its.filter((i) => i.promptText === p1.text || i.promptText === p2.text);
    expect(pair.map((i) => i.status).sort()).toEqual(["failed", "queued"]);
    expect(its.find((i) => i.promptText === p3.text)?.status).toBe("submitted");
  }, 60_000);

  it("l · 회차 겹침 — 진행 중에 다음 예정 → skipped_overlap 행 · next_run_at 전진 · last_run_at 그대로", async () => {
    const ws = await makeWorkspace("l");
    await makePrompts(ws.id, promptTexts("l", 1));
    const t0 = new Date("2031-05-05T03:00:30.000Z");
    const s = await makeSchedule(ws.id, {
      providers: ["chatgpt"],
      nextRunAt: new Date("2031-05-05T03:00:00.000Z"),
      cron: "0 * * * *",
    });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    await engine.runDispatchPass(t0, deps(fake));
    let sch = await scheduleRow(s.id);
    expect(sch.nextRunAt!.toISOString()).toBe("2031-05-05T04:00:00.000Z");
    expect(sch.lastRunAt!.toISOString()).toBe(t0.toISOString());

    const t1 = new Date("2031-05-05T04:00:30.000Z");
    const d = await engine.runDispatchPass(t1, deps(fake));
    expect(d.stats.roundsSkippedOverlap).toBe(1);
    const rs = await roundsOf(s.id);
    expect(rs.map((r) => r.status)).toEqual(["running", "skipped_overlap"]);
    const skipped = rs[1];
    expect(skipped.scheduledFor.toISOString()).toBe("2031-05-05T04:00:00.000Z");
    expect(skipped.expectedItems).toBe(0);
    expect(skipped.scoringSnapshot).toBeNull();
    expect(skipped.finishedAt!.toISOString()).toBe(t1.toISOString());
    sch = await scheduleRow(s.id);
    expect(sch.nextRunAt!.toISOString()).toBe("2031-05-05T05:00:00.000Z");
    expect(sch.lastRunAt!.toISOString()).toBe(t0.toISOString());
    expect(await itemsOfRound(skipped.id)).toHaveLength(0);
  }, 60_000);

  it("m · 스케줄 끄기 — 대기 항목 취소 · 보내는 중·진행 중은 끝까지 받는다", async () => {
    const ws = await makeWorkspace("m");
    await makePrompts(ws.id, promptTexts("m", 6));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    await engine.runDispatchPass(T0, deps(fake));
    await dbm.db.update(dbm.schema.schedules).set({ active: false }).where(eq(dbm.schema.schedules.id, s.id));
    const d = await engine.runDispatchPass(at(60), deps(fake));
    expect(d.stats.cancelled).toBe(2);

    fake.setStatus(() => true, "ready");
    await runUntilIdle(ws.id, deps(fake), at(120));
    const [r] = await roundsOf(s.id);
    expect(r.status).toBe("completed");
    expect(r.summary?.saved).toBe(4);
    expect(r.summary?.cancelled).toBe(2);
    const cancelled = (await itemsOfRound(r.id)).filter((i) => i.status === "cancelled");
    expect(cancelled.every((i) => i.lastErrorCode === "SCHEDULE_PAUSED")).toBe(true);
    expect(fake.submitCount()).toBe(4);
  }, 60_000);

  it("n · 429 — Retry-After 까지 그 AI 제출 없음 · free_requeues 1 · 다른 AI 는 계속", async () => {
    const ws = await makeWorkspace("n");
    await makePrompts(ws.id, promptTexts("n", 2));
    await makeSchedule(ws.id, { providers: ["chatgpt", "gemini"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    let limited = true;
    fake.onSubmit = (req) =>
      req.provider === "chatgpt" && limited
        ? { ok: false, code: "RATE_LIMITED", retryAfterMs: 120_000, message: "429 too many running jobs" }
        : fake.snapshot(req, "running");

    await engine.runDispatchPass(T0, deps(fake));
    expect(fake.submitCount((s) => s.provider === "chatgpt")).toBe(2);
    expect(fake.submitCount((s) => s.provider === "gemini")).toBe(2);
    let its = await itemsOfWorkspace(ws.id);
    for (const i of its.filter((x) => x.provider === "chatgpt")) {
      expect(i.status).toBe("queued");
      expect(i.freeRequeues).toBe(1);
      expect(i.nextAttemptAt!.getTime()).toBe(at(120).getTime());
    }
    expect((await stateRow("rate_pause:chatgpt"))?.value).toEqual({ until: at(120).toISOString() });

    limited = false;
    await engine.runDispatchPass(at(60), deps(fake)); // 멈춤 시각 전 — chatgpt 는 보내지 않는다
    expect(fake.submitCount((s) => s.provider === "chatgpt")).toBe(2);

    await engine.runDispatchPass(at(121), deps(fake));
    expect(fake.submitCount((s) => s.provider === "chatgpt")).toBe(4);
    its = await itemsOfWorkspace(ws.id);
    for (const i of its.filter((x) => x.provider === "chatgpt")) {
      expect(i.status).toBe("submitted");
      expect(i.freeRequeues).toBe(1);
      expect(i.paidAttempts).toBe(1);
    }
  }, 60_000);

  it("o · 즉시 실행 합류와 마감이 동시에 돌아도 새로 더한 항목이 처리된다 · 우선순위 1", async () => {
    const ws = await makeWorkspace("o");
    const [p1] = await makePrompts(ws.id, promptTexts("o", 1));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt", "gemini"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, req.provider === "chatgpt" ? "ready" : "running");

    await engine.runDispatchPass(T0, deps(fake));
    await engine.runHarvestPass(at(31), deps(fake)); // chatgpt 저장, gemini 는 진행 중 → 회차 열림
    const [r1] = await roundsOf(s.id);
    expect(r1.status).toBe("running");

    const [p2] = await makePrompts(ws.id, ["시험 질문 o 추가"]);
    fake.setStatus(() => true, "ready"); // 다음 거두기에서 마지막 항목이 끝나 마감 대상이 된다
    const sched = await scheduleRow(s.id);
    const [joined] = await Promise.all([
      engine.createRoundForSchedule(sched, { trigger: "manual", scheduledFor: at(95), priority: 1, onRunning: "top_up" }, at(95)),
      engine.runHarvestPass(at(95), deps(fake)),
    ]);
    expect(["topped_up", "created"]).toContain(joined.status);
    console.log(`[o] 즉시 실행 결과: ${joined.status}`);
    expect(joined.round.priority).toBe(1);

    fake.onSubmit = (req) => fake.snapshot(req, "ready"); // 새로 더한 항목은 곧바로 준비된다
    await runUntilIdle(ws.id, deps(fake), at(100));
    const runs = await runsOf(ws.id);
    expect(runs.filter((r) => r.promptText === p2.text).map((r) => r.provider).sort()).toEqual(["chatgpt", "gemini"]);
    expect(runs.filter((r) => r.promptText === p1.text)).toHaveLength(2);
    const p2Items = (await itemsOfWorkspace(ws.id)).filter((i) => i.promptText === p2.text);
    expect(p2Items).toHaveLength(2);
    expect(p2Items.every((i) => i.status === "saved")).toBe(true);
  }, 60_000);

  it("o′ · 마감이 먼저 끝난 뒤 즉시 실행 — 새 회차(우선순위 1)가 생기고, 이미 모은 조합은 무료 duplicate · 새 질문만 수집", async () => {
    const ws = await makeWorkspace("o2");
    const [p1] = await makePrompts(ws.id, promptTexts("o2", 1));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    await engine.runDispatchPass(T0, deps(fake));
    await engine.runHarvestPass(at(31), deps(fake)); // 저장 + 마감
    expect((await roundsOf(s.id))[0].status).toBe("completed");

    const [p2] = await makePrompts(ws.id, ["시험 질문 o2 추가"]);
    const r = await engine.createRoundForSchedule(
      await scheduleRow(s.id),
      { trigger: "manual", scheduledFor: at(40), priority: 1, onRunning: "top_up" },
      at(40),
    );
    expect(r).toMatchObject({ status: "created", newItems: 1 });
    expect(r.round.priority).toBe(1);
    await runUntilIdle(ws.id, deps(fake), at(41));
    const its = await itemsOfRound(r.round.id);
    expect(its.find((i) => i.promptText === p1.text)?.status).toBe("duplicate");
    expect(its.find((i) => i.promptText === p2.text)?.status).toBe("saved");
    expect(fake.submitCount()).toBe(2);
  }, 60_000);

  it("p · 되돌림 뒤 재가동 — 6시간 전 회차: 대기 취소(ROUND_EXPIRED) · 진행 중은 한 번 확인 후 닫힘 · 새 회차 정상 생성", async () => {
    const ws = await makeWorkspace("p");
    const ps = await makePrompts(ws.id, promptTexts("p", 3));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: FAR_FUTURE, cron: "0 * * * *" });
    const old = at(-6 * 3600);
    const created = await engine.createRoundForSchedule(
      s,
      { trigger: "cron", scheduledFor: old, priority: 0, onRunning: "skip" },
      old,
    );
    if (created.status !== "created") throw new Error("회차가 만들어져야 한다");
    const fake = new FakeBd();
    fake.jobs.set("snap-old", { id: "snap-old", provider: "chatgpt", prompt: ps[0].text, status: "running", payload: [] });
    const { db, schema } = dbm;
    await db
      .update(schema.collectionItems)
      .set({
        status: "submitted",
        snapshotId: "snap-old",
        submitStartedAt: at(60, old),
        submittedAt: at(60, old),
        nextPollAt: at(120, old),
        pollDeadlineAt: at(660, old),
        paidAttempts: 1,
        attempts: [{ n: 1, country: "KR", startedAt: at(60, old).toISOString(), snapshotId: "snap-old", accepted: true }],
      })
      .where(and(eq(schema.collectionItems.roundId, created.round.id), eq(schema.collectionItems.promptText, ps[0].text)));
    // 스케줄을 지금 때가 되게 한다(되돌림 동안 예전 엔진이 옮겨 둔 다음 시각이 지난 상태)
    await db.update(schema.schedules).set({ nextRunAt: at(-60) }).where(eq(schema.schedules.id, s.id));
    fake.onSubmit = (req) => fake.snapshot(req, "ready");

    // 첫 보내기 줄기 — 오래된 회차의 대기 항목은 취소, 진행 중이 남아 이번엔 새 회차를 미룬다(건너뛰지 않음)
    const d1 = await engine.runDispatchPass(T0, deps(fake));
    expect(d1.stats.roundsCreated).toBe(0);
    expect(d1.stats.roundsSkippedOverlap).toBe(0);
    expect((await scheduleRow(s.id)).nextRunAt!.getTime()).toBe(at(-60).getTime());
    const afterCancel = await itemsOfRound(created.round.id);
    expect(afterCancel.filter((i) => i.status === "cancelled" && i.lastErrorCode === "ROUND_EXPIRED")).toHaveLength(2);

    // 거두기 — 진행 중 항목은 한 번 확인 후 시간 초과로 닫히고 회차가 마감된다
    const h = await engine.runHarvestPass(at(10), deps(fake));
    expect(h.stats.timeouts).toBe(1);
    expect(fake.cancelCalls).toEqual(["snap-old"]);
    const [oldRound] = await roundsOf(s.id);
    expect(oldRound.status).toBe("completed");
    expect(oldRound.summary?.cancelled).toBe(2);
    expect(oldRound.summary?.byProvider.chatgpt.failedByCode).toEqual({ TIMEOUT: 1 });

    // 다음 보내기 줄기 — 새 회차가 정상으로 생긴다
    const d2 = await engine.runDispatchPass(at(60), deps(fake));
    expect(d2.stats.roundsCreated).toBe(1);
    const rs = await roundsOf(s.id);
    expect(rs.map((r) => r.status)).toEqual(["completed", "running"]);
    expect((await scheduleRow(s.id)).nextRunAt!.getTime()).toBeGreaterThan(at(60).getTime());
  }, 60_000);

  it("p′ · 5시간 넘은 회차에 즉시 실행 — 받을 항목이 남았으면 합류하지 않고 알려 주고(closing), 닫힌 뒤엔 새 회차", async () => {
    const ws = await makeWorkspace("p2");
    const ps = await makePrompts(ws.id, promptTexts("p2", 2));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: FAR_FUTURE });
    const old = at(-6 * 3600);
    const created = await engine.createRoundForSchedule(
      s,
      { trigger: "cron", scheduledFor: old, priority: 0, onRunning: "skip" },
      old,
    );
    if (created.status !== "created") throw new Error("회차가 만들어져야 한다");
    const fake = new FakeBd();
    fake.jobs.set("snap-p2", { id: "snap-p2", provider: "chatgpt", prompt: ps[0].text, status: "running", payload: [] });
    const { db, schema } = dbm;
    await db
      .update(schema.collectionItems)
      .set({
        status: "submitted",
        snapshotId: "snap-p2",
        submitStartedAt: at(60, old),
        submittedAt: at(60, old),
        nextPollAt: at(120, old),
        pollDeadlineAt: at(660, old),
        paidAttempts: 1,
        attempts: [{ n: 1, country: "KR", startedAt: at(60, old).toISOString(), snapshotId: "snap-p2", accepted: true }],
      })
      .where(and(eq(schema.collectionItems.roundId, created.round.id), eq(schema.collectionItems.promptText, ps[0].text)));

    const busy = await engine.createRoundForSchedule(
      await scheduleRow(s.id),
      { trigger: "manual", scheduledFor: T0, priority: 1, onRunning: "top_up" },
      T0,
    );
    expect(busy).toMatchObject({ status: "running_skipped", closing: true });
    // 합류하지 않은 대신 오래된 회차의 대기 항목은 정리됐다
    expect((await itemsOfRound(created.round.id)).filter((i) => i.status === "cancelled")).toHaveLength(1);

    await engine.runHarvestPass(at(10), deps(fake)); // 진행 중 항목이 시간 초과로 닫히고 회차 마감
    const again = await engine.createRoundForSchedule(
      await scheduleRow(s.id),
      { trigger: "manual", scheduledFor: at(20), priority: 1, onRunning: "top_up" },
      at(20),
    );
    expect(again).toMatchObject({ status: "created", newItems: 2 });
  }, 60_000);

  it("t · '준비됨' 뒤 내려받은 결과가 아직 자리표시자면 다시 내려받는다(추가 과금 없음)", async () => {
    const ws = await makeWorkspace("t");
    await makePrompts(ws.id, promptTexts("t", 1));
    await makeSchedule(ws.id, { providers: ["gemini"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    await engine.runDispatchPass(T0, deps(fake));
    const [job] = [...fake.jobs.values()];
    const real = job.payload;
    job.payload = [{ message: "Dataset is not ready yet, try again in 30s" }];

    await engine.runHarvestPass(at(31), deps(fake));
    let [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("submitted");
    expect(item.downloadErrors).toBe(1);
    expect(item.nextPollAt!.getTime()).toBe(at(61).getTime());

    job.payload = real;
    await engine.runHarvestPass(at(61), deps(fake));
    [item] = await itemsOfWorkspace(ws.id);
    expect(item.status).toBe("saved");
    expect(item.paidAttempts).toBe(1);
    expect(item.paidRetries).toBe(0);
    expect(fake.submitCount()).toBe(1);
  }, 60_000);

  it("q · 응답 초기화 뒤 — runs 삭제 후 같은 시간대 즉시 실행 → 다시 수집 (이전 saved 항목의 run_id 는 null)", async () => {
    const ws = await makeWorkspace("q");
    await makePrompts(ws.id, promptTexts("q", 1));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"], nextRunAt: FAR_FUTURE });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.inline(req);
    const manual = (t: Date) =>
      engine.createRoundForSchedule(s, { trigger: "manual", scheduledFor: t, priority: 1, onRunning: "top_up" }, t);

    const r1 = await manual(at(0));
    expect(r1).toMatchObject({ status: "created", newItems: 1 });
    await engine.runDispatchPass(at(1), deps(fake));
    await engine.runHarvestPass(at(2), deps(fake));
    expect(fake.submitCount()).toBe(1);

    // 같은 시간대 다시 — 이미 모았으니 새로 모을 것이 없다(무료로 duplicate)
    const r2 = await manual(at(10));
    expect(r2).toMatchObject({ status: "created", newItems: 0 });
    await engine.runDispatchPass(at(11), deps(fake));
    await engine.runHarvestPass(at(12), deps(fake));
    expect(fake.submitCount()).toBe(1);

    // 응답 초기화(runs 삭제) 뒤 같은 시간대 즉시 실행 → 다시 모은다
    await dbm.db.delete(dbm.schema.runs).where(eq(dbm.schema.runs.workspaceId, ws.id));
    const firstItem = (await itemsOfRound(r1.round.id))[0];
    expect(firstItem.status).toBe("saved");
    expect(firstItem.runId).toBeNull();

    const r3 = await manual(at(20));
    expect(r3).toMatchObject({ status: "created", newItems: 1 });
    await engine.runDispatchPass(at(21), deps(fake));
    expect(fake.submitCount()).toBe(2);
    expect((await runsOf(ws.id)).length).toBe(1);
  }, 60_000);

  it("r · 두 보내기 줄기 동시 — 항목마다 제출 1회 · 회차 1개", async () => {
    const ws = await makeWorkspace("r");
    await makePrompts(ws.id, promptTexts("r", 3));
    const s = await makeSchedule(ws.id, { providers: ["chatgpt", "gemini"], nextRunAt: at(-60) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.snapshot(req, "running");

    await Promise.all([engine.runDispatchPass(T0, deps(fake)), engine.runDispatchPass(T0, deps(fake))]);
    expect(await roundsOf(s.id)).toHaveLength(1);
    const keys = fake.submits.map((x) => `${x.provider}|${x.prompt}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(6);
  }, 60_000);

  it("s · 점수 동일성 — 같은 결과를 예전 경로(runTick)와 새 경로로 저장하면 runs 값이 같다", async () => {
    const llm = await import("@/lib/server/llm-sentiment");
    vi.mocked(llm.classifySentiment).mockResolvedValue({
      sentiment: "positive",
      isTopRanked: true,
      isStronglyRecommended: false,
    });
    const payloadFor = (provider: string, prompt: string) => [
      {
        answer_text:
          `시험브랜드는 재활 과정 안내를 제공합니다. "${prompt}" 에 대해 ${provider} 는 시험브랜드와 경쟁기관을 함께 소개합니다. ` +
          `자세한 안내는 https://brand.example/info 에서 볼 수 있습니다.`,
        citations: [
          { url: "https://brand.example/info", title: "안내", description: "" },
          { url: "https://news.example/a", title: "시험브랜드 소식", description: "" },
          { url: "https://www.instagram.com/p/AbCdEfGhIjK/", title: "TestBrand 후기", description: "" },
        ],
      },
    ];
    const providers = ["chatgpt", "perplexity"];
    const texts = promptTexts("s", 2);

    // ── 예전 경로: runTick → runAiScraper(가짜 fetch 200) → 저장
    vi.stubEnv("BRIGHT_DATA_KEY", "fake-int-test-key");
    const bd = await import("./brightdata-scraper");
    bd.clearScrapeCache();
    fetchHandler = async (url, init) => {
      if (!url.startsWith("https://api.brightdata.com/datasets/v3/scrape")) return unexpectedFetch(url, init);
      const body = JSON.parse(String(init?.body)) as { input: { url: string; prompt: string }[] };
      const rec = body.input[0];
      const provider = rec.url.includes("chatgpt") ? "chatgpt" : "perplexity";
      return new Response(JSON.stringify(payloadFor(provider, rec.prompt)), { status: 200 });
    };
    const wsLegacy = await makeWorkspace("s-legacy");
    await dbm.db.insert(dbm.schema.competitors).values({ workspaceId: wsLegacy.id, name: "경쟁기관", aliases: [], websites: ["https://rival.example"] });
    await makePrompts(wsLegacy.id, texts);
    const sLegacy = await makeSchedule(wsLegacy.id, { providers, nextRunAt: new Date(Date.now() - 60_000) });
    const tick = await runner.runTick();
    expect(tick.errors).toEqual([]);
    expect(tick.providerFailures).toEqual([]);
    await dbm.db.update(dbm.schema.schedules).set({ active: false }).where(eq(dbm.schema.schedules.id, sLegacy.id));
    fetchHandler = unexpectedFetch;

    // ── 새 경로: 보내기 줄기 → 200 바로 결과 → 저장
    const wsQueue = await makeWorkspace("s-queue");
    await dbm.db.insert(dbm.schema.competitors).values({ workspaceId: wsQueue.id, name: "경쟁기관", aliases: [], websites: ["https://rival.example"] });
    await makePrompts(wsQueue.id, texts);
    await makeSchedule(wsQueue.id, { providers, nextRunAt: new Date(Date.now() - 60_000) });
    const fake = new FakeBd();
    fake.onSubmit = (req) => fake.inline(req, payloadFor(req.provider, req.prompt));
    const d = await engine.runDispatchPass(new Date(), { bd: fake.client() });
    expect(d.errors).toEqual([]);
    expect(d.stats.savedInline).toBe(4);

    const pick = (r: Awaited<ReturnType<typeof runsOf>>[number]) => ({
      promptText: r.promptText,
      provider: r.provider,
      answer: r.answer,
      sources: r.sources,
      citations: r.citations,
      visibilityScore: r.visibilityScore,
      scoreVersion: r.scoreVersion,
      sentiment: r.sentiment,
      brandMentions: r.brandMentions,
      competitorMentions: r.competitorMentions,
      citedBrandDomains: r.citedBrandDomains,
      citedCompetitorDomains: r.citedCompetitorDomains,
      citedOwnedVideoIds: r.citedOwnedVideoIds,
      citedPressDomains: r.citedPressDomains,
      citedSocialDomains: r.citedSocialDomains,
      attachedBrandMentions: r.attachedBrandMentions,
      attachedCompetitorMentions: r.attachedCompetitorMentions,
      geolocation: r.geolocation,
      isAuto: r.isAuto,
      parseQuality: r.parseQuality,
      isCachedResponse: r.isCachedResponse,
      responseLength: r.responseLength,
    });
    const order = (a: { promptText: string; provider: string }, b: { promptText: string; provider: string }) =>
      `${a.promptText}|${a.provider}`.localeCompare(`${b.promptText}|${b.provider}`);
    const legacyRuns = (await runsOf(wsLegacy.id)).map(pick).sort(order);
    const queueRuns = (await runsOf(wsQueue.id)).map(pick).sort(order);
    expect(legacyRuns).toHaveLength(4);
    expect(queueRuns).toEqual(legacyRuns);
    // 점수 경로가 실제로 여러 갈래를 탔는지 — 언급·인용·언론·소셜
    expect(legacyRuns[0].brandMentions).toEqual(["시험브랜드"]);
    expect(legacyRuns[0].citedBrandDomains).toEqual(["brand.example"]);
    expect(legacyRuns[0].citedPressDomains).toEqual(["news.example"]);
    expect(legacyRuns[0].citedSocialDomains).toEqual(["instagram.com"]);
    vi.mocked(llm.classifySentiment).mockResolvedValue(null);
  }, 60_000);
});
