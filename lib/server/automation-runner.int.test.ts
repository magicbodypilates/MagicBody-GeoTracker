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
});
