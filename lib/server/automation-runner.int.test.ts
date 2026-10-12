/**
 * automation-runner.int.test.ts — 하루 집계(runDailyRollup) 통합 테스트 (로컬 DB · 계획 geotracker-daily-rollup-260925).
 *
 * 실행: GEO_TEST_POSTGRES_URL=<로컬 시험 DB> GEO_REQUIRE_DB_TESTS=1 npx vitest run lib/server/automation-runner.int.test.ts
 *   - URL 이 없으면 건너뛴다. GEO_REQUIRE_DB_TESTS=1 이면 URL 이 없을 때 실패한다.
 *   - 호스트가 로컬이 아니거나 DB 이름에 "test" 가 없으면 즉시 중단한다(test-support/int-db.ts).
 *   - 파일 전용 DB(<이름>_rollup)를 쓰고, 끝나면 자기가 만든 시험 워크스페이스만 지운다(연쇄 삭제).
 *
 * 결함 배경(2026-09-25) — daily_stats 의 기본키는 (date, workspace_id, provider, prompt_id) 라
 * prompt_id 는 Postgres 기본키 제약으로 실제 NOT NULL 인데, 옛 구현은 이 컬럼에 항상 null 을
 * 넣어 모든 저장이 실패했다(운영 daily_stats 0행). 이 시험은 (1) 실제로 행이 저장되는지
 * (2) 프롬프트별로 올바르게 나뉘는지 (3) 매칭되는 프롬프트가 없는 응답은 빠지는지
 * (4) 같은 날 두 번 돌려도 중복 없이 갱신되는지를 확인한다.
 *
 * ⚠️ PUBLIC 저장소 — 질문·브랜드 문구는 전부 가짜 값이다.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, like } from "drizzle-orm";
// OpenRouter Perplexity 하루 1회 추가 테스트용(계획 geotracker-pplx-openrouter-261012 v2 §8-2 — 파일 끝 묶음)
import { vi, beforeEach } from "vitest";
import {
  TEST_WORKSPACE_PREFIX,
  assertOnlyTestData,
  ensureTestDatabase,
  migrateTestDatabase,
  readIntDbConfig,
} from "./test-support/int-db";

const CFG = readIntDbConfig("rollup");
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url; // db 모듈은 첫 쿼리 때 이 값을 읽는다

type DbMod = typeof import("./db");
type Runner = typeof import("./automation-runner");
let dbm: DbMod;
let R: Runner;

// 어제(KST) 자정~오늘(KST) 자정 구간에 잡히도록, "오늘"을 2026-04-02 KST 새벽으로 고정한다.
// → 어제 구간 = 2026-04-01T00:00+09:00 ~ 2026-04-02T00:00+09:00.
const NOW = new Date("2026-04-02T01:00:00+09:00");
const KST_APR1_MORNING = new Date("2026-04-01T10:00:00+09:00");

/* ------------------------------------------------------------------
 * 시험 데이터 도우미
 * ------------------------------------------------------------------ */
let wsCounter = 0;
async function makeWorkspace(label: string) {
  const [ws] = await dbm.db
    .insert(dbm.schema.workspaces)
    .values({ name: `${TEST_WORKSPACE_PREFIX}rollup-${label}-${++wsCounter}`, isProduction: true })
    .returning();
  return ws;
}

async function addPrompt(wsId: string, text: string, active = true) {
  const [p] = await dbm.db.insert(dbm.schema.prompts).values({ workspaceId: wsId, text, active }).returning();
  return p;
}

async function addRun(
  wsId: string,
  text: string,
  o: {
    provider?: string;
    score?: number;
    sentiment?: string;
    createdAt?: Date;
    isAuto?: boolean;
    parseQuality?: string | null;
    brandMentions?: string[];
    citedBrandDomains?: string[];
  } = {},
) {
  await dbm.db.insert(dbm.schema.runs).values({
    workspaceId: wsId,
    promptText: text,
    provider: o.provider ?? "chatgpt",
    visibilityScore: o.score ?? 40,
    sentiment: o.sentiment ?? "neutral",
    isAuto: o.isAuto ?? true,
    parseQuality: o.parseQuality === undefined ? "high" : o.parseQuality,
    brandMentions: o.brandMentions ?? [],
    citedBrandDomains: o.citedBrandDomains ?? [],
    createdAt: o.createdAt ?? KST_APR1_MORNING,
  });
}

async function dailyStatsRows(wsId: string) {
  return dbm.db
    .select()
    .from(dbm.schema.dailyStats)
    .where(eq(dbm.schema.dailyStats.workspaceId, wsId));
}

async function cleanAll() {
  await dbm.db.delete(dbm.schema.workspaces).where(like(dbm.schema.workspaces.name, `${TEST_WORKSPACE_PREFIX}%`));
}

/* ------------------------------------------------------------------ */

if (!CFG.enabled && CFG.mustFail) {
  describe("runDailyRollup 통합 테스트", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("하루 집계(runDailyRollup) 통합 (로컬 DB)", () => {
  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    dbm = await import("./db");
    R = await import("./automation-runner");
    await cleanAll();
  }, 120_000);

  afterEach(async () => {
    await cleanAll();
  });

  afterAll(async () => {
    if (!dbm) return;
    await cleanAll();
    const g = globalThis as unknown as { __geotracker_pg_client?: { end: () => Promise<void> } };
    await g.__geotracker_pg_client?.end();
  });

  it("1 · 프롬프트별로 나뉘어 실제 행이 저장된다(예전엔 prompt_id NOT NULL 위반으로 0행)", async () => {
    const ws = await makeWorkspace("1");
    await addPrompt(ws.id, "가짜 질문 A");
    await addPrompt(ws.id, "가짜 질문 B");
    await addRun(ws.id, "가짜 질문 A", { score: 60, sentiment: "positive", brandMentions: ["브랜드"] });
    await addRun(ws.id, "가짜 질문 A", { score: 40 });
    await addRun(ws.id, "가짜 질문 B", { score: 80, citedBrandDomains: ["example.com"] });

    const result = await R.runDailyRollup(NOW);
    expect(result).toEqual({ date: "2026-04-01", rows: 2 });

    const saved = await dailyStatsRows(ws.id);
    expect(saved).toHaveLength(2);
    const byPromptId = new Map(saved.map((r) => [r.promptId, r]));
    expect([...byPromptId.keys()].every((id) => typeof id === "string" && id.length > 0)).toBe(true);

    const promptRows = await dbm.db
      .select({ id: dbm.schema.prompts.id, text: dbm.schema.prompts.text })
      .from(dbm.schema.prompts)
      .where(eq(dbm.schema.prompts.workspaceId, ws.id));
    const idOfA = promptRows.find((p) => p.text === "가짜 질문 A")!.id;
    const idOfB = promptRows.find((p) => p.text === "가짜 질문 B")!.id;

    const rowA = byPromptId.get(idOfA)!;
    expect(rowA.sampleCount).toBe(2);
    expect(Number(rowA.avgVisibility)).toBeCloseTo(50, 5);

    const rowB = byPromptId.get(idOfB)!;
    expect(rowB.sampleCount).toBe(1);
    expect(Number(rowB.avgVisibility)).toBeCloseTo(80, 5);
  });

  it("2 · 질문 목록에 없는 문구(삭제된 프롬프트)의 응답은 집계에서 빠지고 오류도 없다", async () => {
    const ws = await makeWorkspace("2");
    await addPrompt(ws.id, "가짜 살아있는 질문");
    await addRun(ws.id, "가짜 살아있는 질문", { score: 50 });
    await addRun(ws.id, "가짜 지워진 질문", { score: 90 }); // prompts 에 없음

    const result = await R.runDailyRollup(NOW);
    expect(result.rows).toBe(1);

    const saved = await dailyStatsRows(ws.id);
    expect(saved).toHaveLength(1);
    expect(Number(saved[0].avgVisibility)).toBeCloseTo(50, 5);
  });

  it("3 · 같은 날 두 번 돌려도 중복되지 않고 갱신만 된다(ON CONFLICT)", async () => {
    const ws = await makeWorkspace("3");
    await addPrompt(ws.id, "가짜 재실행 질문");
    await addRun(ws.id, "가짜 재실행 질문", { score: 30 });

    const first = await R.runDailyRollup(NOW);
    expect(first.rows).toBe(1);
    expect(await dailyStatsRows(ws.id)).toHaveLength(1);

    // 재실행 사이에 같은 날짜 구간에 새 응답이 하나 더 생겼다고 가정 — 갱신 값이 반영돼야 한다.
    await addRun(ws.id, "가짜 재실행 질문", { score: 90 });

    const second = await R.runDailyRollup(NOW);
    expect(second.rows).toBe(1);

    const saved = await dailyStatsRows(ws.id);
    expect(saved).toHaveLength(1); // 기본키 충돌 없이 그대로 1행
    expect(saved[0].sampleCount).toBe(2);
    expect(Number(saved[0].avgVisibility)).toBeCloseTo(60, 5); // (30+90)/2
  });

  it("4 · parse_quality='low' 인 응답은 집계에서 제외된다(기존 동작 유지)", async () => {
    const ws = await makeWorkspace("4");
    await addPrompt(ws.id, "가짜 품질 질문");
    await addRun(ws.id, "가짜 품질 질문", { score: 70, parseQuality: "high" });
    await addRun(ws.id, "가짜 품질 질문", { score: 10, parseQuality: "low" });

    await R.runDailyRollup(NOW);
    const saved = await dailyStatsRows(ws.id);
    expect(saved).toHaveLength(1);
    expect(saved[0].sampleCount).toBe(1);
    expect(Number(saved[0].avgVisibility)).toBeCloseTo(70, 5);
  });

  /* ----------------------------------------------------------------
   * 같은 질문 하루 1회 · OpenRouter Perplexity — 예전 엔진(runTick)
   * 계획 geotracker-pplx-openrouter-261012 v2 §3 · §8-2. 전역 fetch 는 가짜(OpenRouter·Bright Data 모두).
   * runTick 은 실제 현재 시각으로 돈다 — "오늘(KST)" 기준 행을 현재 시각으로 만든다.
   * ---------------------------------------------------------------- */
  describe("같은 질문 하루 1회 · OpenRouter Perplexity (예전 엔진 runTick)", () => {
    const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
    const BD_URL = "https://api.brightdata.com/datasets/v3/scrape";
    let fetchCalls: string[] = [];

    const orOk = () =>
      new Response(
        JSON.stringify({
          model: "perplexity/sonar",
          provider: "Perplexity",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "가짜 응답입니다 — OpenRouter 시험용 문장이 충분히 깁니다 [1].",
                annotations: [{ type: "url_citation", url_citation: { url: "https://example-a.test/one", title: "가짜 제목" } }],
              },
            },
          ],
          usage: { cost: 0.001 },
        }),
        { status: 200 },
      );
    const bdOk = () =>
      new Response(JSON.stringify([{ answer_text: "가짜 응답입니다 — Bright Data 시험용 문장이 충분히 깁니다." }]), {
        status: 200,
      });

    /** 오늘(KST) 자정 */
    const kstMidnightMs = () => {
      const kstDate = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      return Date.parse(`${kstDate}T00:00:00+09:00`);
    };

    async function addAutoRun(wsId: string, text: string, provider: string, createdAt: Date) {
      await dbm.db.insert(dbm.schema.runs).values({
        workspaceId: wsId,
        promptText: text,
        provider,
        visibilityScore: 0,
        sentiment: "not-mentioned",
        isAuto: true,
        intervalSlot: "2000-01-01T00", // 지금 시간대와 다른 칸
        createdAt,
      });
    }

    async function addDueSchedule(wsId: string, providers: string[]) {
      await dbm.db.insert(dbm.schema.schedules).values({
        workspaceId: wsId,
        name: "가짜 하루 1회 시험",
        cronExpression: "0 0 * * *",
        providers,
        promptIds: [],
        active: true,
        nextRunAt: new Date(Date.now() - 60_000),
      });
    }

    async function runsCount(wsId: string, provider: string) {
      const rows = await dbm.db.select().from(dbm.schema.runs).where(eq(dbm.schema.runs.workspaceId, wsId));
      return rows.filter((r) => r.provider === provider).length;
    }

    beforeEach(async () => {
      fetchCalls = [];
      vi.stubGlobal("fetch", async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).startsWith(OR_URL)) return orOk();
        if (String(url).startsWith(BD_URL)) return bdOk();
        throw new Error(`예상하지 못한 네트워크 호출: ${String(url).slice(0, 60)}`);
      });
      vi.stubEnv("BRIGHT_DATA_KEY", "fake-int-test-key");
      vi.stubEnv("OPENROUTER_KEY", "or-int-fake-key-0001");
      (await import("./brightdata-scraper")).clearScrapeCache();
      (await import("./perplexity-openrouter")).__resetOpenRouterStateForTest();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      (await import("./perplexity-openrouter")).__resetOpenRouterStateForTest();
      // 이 묶음이 만든 하루 상한 행만 지운다(파일 전용 시험 DB)
      await dbm.db.delete(dbm.schema.collectorState).where(like(dbm.schema.collectorState.key, "openrouter_pplx_%"));
    });

    it("5 · 같은 날 다른 시간대 결과가 있으면 skippedDuplicates · OpenRouter 요청 0", async () => {
      vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
      const ws = await makeWorkspace("5");
      await addPrompt(ws.id, "가짜 하루 1회 질문 5");
      await addAutoRun(ws.id, "가짜 하루 1회 질문 5", "perplexity", new Date(Math.max(Date.now() - 60_000, kstMidnightMs())));
      await addDueSchedule(ws.id, ["perplexity"]);

      const tick = await R.runTick();
      expect(tick.errors).toEqual([]);
      expect(tick.skippedDuplicates).toBe(1);
      expect(tick.executedRuns).toBe(0);
      expect(fetchCalls).toEqual([]);
      expect(await runsCount(ws.id, "perplexity")).toBe(1);
    });

    it("6 · 전날(KST) 결과만 있으면 다시 묻는다 — OpenRouter 로 수집·저장(참조 인용) · 오늘 상한 행 count 1", async () => {
      vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
      const ws = await makeWorkspace("6");
      await addPrompt(ws.id, "가짜 하루 1회 질문 6");
      await addAutoRun(ws.id, "가짜 하루 1회 질문 6", "perplexity", new Date(kstMidnightMs() - 3600_000));
      await addDueSchedule(ws.id, ["perplexity"]);

      const tick = await R.runTick();
      expect(tick.errors).toEqual([]);
      expect(tick.providerFailures).toEqual([]);
      expect(tick.executedRuns).toBe(1);
      expect(fetchCalls).toEqual([OR_URL]);
      const rows = await dbm.db.select().from(dbm.schema.runs).where(eq(dbm.schema.runs.workspaceId, ws.id));
      const fresh = rows.find((r) => r.intervalSlot !== "2000-01-01T00")!;
      expect(fresh.answer).toContain("OpenRouter 시험용");
      expect((fresh.citations as { url: string }[]).map((c) => c.url)).toEqual(["https://example-a.test/one"]);
      const OR = await import("./perplexity-openrouter");
      const [state] = await dbm.db
        .select()
        .from(dbm.schema.collectorState)
        .where(eq(dbm.schema.collectorState.key, OR.dailyCapKey(new Date())));
      expect(state?.value).toMatchObject({ count: 1, costed: 1 });
      // 예전 엔진은 자동 수집 몫으로 센다 — 수동 수집 행은 생기지 않는다(1회차 검수 S-4)
      const [manual] = await dbm.db
        .select()
        .from(dbm.schema.collectorState)
        .where(eq(dbm.schema.collectorState.key, OR.dailyCapKey(new Date(), "manual")));
      expect(manual).toBeUndefined();
    });

    it("7 · 설정이 brightdata 면 하루 1회 미적용 — 같은 날 결과가 있어도 Bright Data 로 수집", async () => {
      const ws = await makeWorkspace("7");
      await addPrompt(ws.id, "가짜 하루 1회 질문 7");
      await addAutoRun(ws.id, "가짜 하루 1회 질문 7", "perplexity", new Date(Math.max(Date.now() - 60_000, kstMidnightMs())));
      await addDueSchedule(ws.id, ["perplexity"]);

      const tick = await R.runTick();
      expect(tick.executedRuns).toBe(1);
      expect(tick.skippedDuplicates).toBe(0);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].startsWith(BD_URL)).toBe(true);
    });

    it("8 · runAiScraper 가 DAILY_CAP 을 던지면 그 질문의 Perplexity 만 실패 · 같은 질문의 다른 AI 는 저장", async () => {
      vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
      vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "0");
      const ws = await makeWorkspace("8");
      await addPrompt(ws.id, "가짜 하루 1회 질문 8");
      await addDueSchedule(ws.id, ["perplexity", "chatgpt"]);

      const tick = await R.runTick();
      expect(tick.errors).toEqual([]);
      expect(tick.executedRuns).toBe(1);
      expect(tick.providerFailures).toHaveLength(1);
      expect(tick.providerFailures[0].provider).toBe("perplexity");
      expect(tick.providerFailures[0].reason.startsWith("[DAILY_CAP]")).toBe(true);
      expect(fetchCalls.some((u) => u.startsWith(OR_URL))).toBe(false); // 상한에 걸리면 요청하지 않는다
      expect(await runsCount(ws.id, "chatgpt")).toBe(1);
      expect(await runsCount(ws.id, "perplexity")).toBe(0);
    });
  });
});
