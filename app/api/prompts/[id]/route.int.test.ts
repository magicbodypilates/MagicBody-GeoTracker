/**
 * route.int.test.ts — DELETE /api/prompts/:id 의 daily_stats 선삭제 통합 테스트 (로컬 DB · 결함 3 ·
 * 검수 geotracker-rollup-fix-260925-review.md).
 *
 * 실행: GEO_TEST_POSTGRES_URL=<로컬 시험 DB> GEO_REQUIRE_DB_TESTS=1 npx vitest run "app/api/prompts/[id]/route.int.test.ts"
 *   - URL 이 없으면 건너뛴다. GEO_REQUIRE_DB_TESTS=1 이면 URL 이 없을 때 실패한다.
 *   - 호스트가 로컬이 아니거나 DB 이름에 "test" 가 없으면 즉시 중단한다(test-support/int-db.ts).
 *
 * 결함 배경 — route.ts DELETE 는 프롬프트를 지우기 전에 `tx.delete(schema.dailyStats)
 * .where(eq(schema.dailyStats.promptId, id))` 로 그 프롬프트를 가리키던 하루 집계 행을 먼저
 * 지운다. daily_stats 의 prompt_id 는 기본키(date, workspace_id, provider, prompt_id)의
 * 일부라 Postgres 가 NOT NULL 을 강제하므로, 이 선삭제가 없으면 FK 의 ON DELETE SET NULL 이
 * 그 값을 null 로 바꾸려다 제약 위반으로 프롬프트 삭제 자체가 실패한다. 기존 route.test.ts
 * (in-memory 목업)는 이 줄이 살아있는지 스파이하지 않아 조건이 바뀌어도 잡지 못했다 —
 * 이 파일은 실제 Postgres 로 (1) 대상 프롬프트의 daily_stats 행이 사라지는지 (2) 다른
 * 프롬프트의 행은 그대로인지 (3) 실제로 프롬프트가 삭제되는지(선삭제가 빠지면 FK 위반으로
 * 트랜잭션 전체가 롤백돼 이 단언들이 깨진다)를 검증한다.
 *
 * DB 는 실제, 권한(auth-guard)만 가짜다(collector-routes.int.test.ts 와 같은 패턴).
 *
 * ⚠️ PUBLIC 저장소 — 질문 문구는 전부 가짜 값이다.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { eq, like } from "drizzle-orm";
import {
  TEST_WORKSPACE_PREFIX,
  assertOnlyTestData,
  ensureTestDatabase,
  migrateTestDatabase,
  readIntDbConfig,
} from "@/lib/server/test-support/int-db";

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
const requireAdminMock = vi.fn();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
  requireAdmin: (session: unknown) => requireAdminMock(session),
}));

const CFG = readIntDbConfig("promptsdelete");
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url; // db 모듈은 첫 쿼리 때 이 값을 읽는다

type DbMod = typeof import("@/lib/server/db");
let dbm: DbMod;
let DELETE: (typeof import("./route"))["DELETE"];

/* ------------------------------------------------------------------
 * 시험 데이터 도우미
 * ------------------------------------------------------------------ */
let wsCounter = 0;
async function makeWorkspace(label: string) {
  const [ws] = await dbm.db
    .insert(dbm.schema.workspaces)
    .values({ name: `${TEST_WORKSPACE_PREFIX}promptsdel-${label}-${++wsCounter}`, isProduction: true })
    .returning();
  return ws;
}

async function makePrompt(wsId: string, text: string) {
  const [p] = await dbm.db.insert(dbm.schema.prompts).values({ workspaceId: wsId, text }).returning();
  return p;
}

async function makeDailyStat(wsId: string, promptId: string, o: { date?: string; provider?: string } = {}) {
  await dbm.db.insert(dbm.schema.dailyStats).values({
    date: o.date ?? "2026-04-01",
    workspaceId: wsId,
    provider: o.provider ?? "chatgpt",
    promptId,
    sampleCount: 3,
    avgVisibility: "50.00",
    mentionRate: "0.5000",
    positiveSentimentRate: "0.5000",
    citedOfficialRate: "0.0000",
  });
}

async function dailyStatsOf(promptId: string) {
  return dbm.db.select().from(dbm.schema.dailyStats).where(eq(dbm.schema.dailyStats.promptId, promptId));
}

async function promptExists(id: string) {
  const rows = await dbm.db.select({ id: dbm.schema.prompts.id }).from(dbm.schema.prompts).where(eq(dbm.schema.prompts.id, id));
  return rows.length > 0;
}

function deleteReq(id: string, qs = "") {
  return DELETE(new NextRequest(`http://localhost/api/prompts/${id}${qs}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

async function cleanAll() {
  await dbm.db.delete(dbm.schema.workspaces).where(like(dbm.schema.workspaces.name, `${TEST_WORKSPACE_PREFIX}%`));
}

/* ------------------------------------------------------------------ */

if (!CFG.enabled && CFG.mustFail) {
  describe("DELETE /api/prompts/:id daily_stats 선삭제 통합 테스트", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("DELETE /api/prompts/:id — daily_stats 선삭제 (로컬 DB)", () => {
  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    dbm = await import("@/lib/server/db");
    DELETE = (await import("./route")).DELETE;
    await cleanAll();
  }, 120_000);

  afterEach(async () => {
    await cleanAll();
    getSessionMock.mockReset();
    assertWorkspaceAccessMock.mockReset();
    requireAdminMock.mockReset();
  });

  afterAll(async () => {
    if (!dbm) return;
    await cleanAll();
    const g = globalThis as unknown as { __geotracker_pg_client?: { end: () => Promise<void> } };
    await g.__geotracker_pg_client?.end();
  });

  it("1 · cascade=false — 대상 프롬프트의 daily_stats 행만 지워지고, 다른 프롬프트 행은 남는다", async () => {
    const ws = await makeWorkspace("1");
    const promptA = await makePrompt(ws.id, "가짜 질문 A");
    const promptB = await makePrompt(ws.id, "가짜 질문 B");
    await makeDailyStat(ws.id, promptA.id);
    await makeDailyStat(ws.id, promptB.id);

    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await deleteReq(promptA.id);

    // 선삭제가 빠지면 FK(ON DELETE SET NULL → NOT NULL 위반)로 트랜잭션 전체가 롤백되어
    // 200 대신 500 이 오고, 아래 단언들도 전부 깨진다 — 이 테스트가 그 회귀를 잡는다.
    expect(res.status).toBe(200);
    expect(await promptExists(promptA.id)).toBe(false);
    expect(await dailyStatsOf(promptA.id)).toHaveLength(0);

    // 다른 프롬프트(B)는 그대로 — promptId 조건 없이 워크스페이스·날짜만으로 지우지 않았는지 확인.
    expect(await promptExists(promptB.id)).toBe(true);
    expect(await dailyStatsOf(promptB.id)).toHaveLength(1);
  });

  it("2 · cascade=true 에서도 daily_stats 정리는 대상 프롬프트로만 한정된다", async () => {
    const ws = await makeWorkspace("2");
    const promptA = await makePrompt(ws.id, "가짜 질문 C");
    const promptB = await makePrompt(ws.id, "가짜 질문 D");
    await makeDailyStat(ws.id, promptA.id);
    await makeDailyStat(ws.id, promptB.id);

    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);
    requireAdminMock.mockReturnValue(null);

    const res = await deleteReq(promptA.id, "?cascade=true");

    expect(res.status).toBe(200);
    expect(await dailyStatsOf(promptA.id)).toHaveLength(0);
    expect(await dailyStatsOf(promptB.id)).toHaveLength(1);
  });

  it("3 · 권한 거부(assertWorkspaceAccess) 시 daily_stats 는 그대로 — 삭제가 실행되지 않는다", async () => {
    const ws = await makeWorkspace("3");
    const promptA = await makePrompt(ws.id, "가짜 질문 E");
    await makeDailyStat(ws.id, promptA.id);

    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));

    const res = await deleteReq(promptA.id);

    expect(res.status).toBe(403);
    expect(await promptExists(promptA.id)).toBe(true);
    expect(await dailyStatsOf(promptA.id)).toHaveLength(1);
  });
});
