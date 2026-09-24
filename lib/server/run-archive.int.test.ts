/**
 * run-archive.int.test.ts — 응답 보관 통합 테스트 (로컬 DB · 계획 geotracker-response-archive-260924 §6-2).
 *
 * 실행: node run-int.mjs lib/server/run-archive.int.test.ts  (또는 GEO_TEST_POSTGRES_URL=<로컬 시험 DB>
 *       GEO_REQUIRE_DB_TESTS=1 npx vitest run lib/server/run-archive.int.test.ts)
 *   - URL 이 없으면 건너뛴다. GEO_REQUIRE_DB_TESTS=1 이면 URL 이 없을 때 실패한다.
 *   - 호스트가 로컬이 아니거나 DB 이름에 "test" 가 없으면 즉시 중단한다(test-support/int-db.ts).
 *   - 파일 전용 DB(<이름>_archive)를 쓰고, 끝나면 자기가 만든 시험 워크스페이스만 지운다(연쇄 삭제).
 *
 * 외부 호출 없음 — 수집(Bright Data)을 부르지 않는다. 권한 확인(auth-guard)만 가짜다.
 * ⚠️ PUBLIC 저장소 — 질문 문구는 전부 가짜 값이다.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { and, count, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import {
  TEST_WORKSPACE_PREFIX,
  assertOnlyTestData,
  ensureTestDatabase,
  migrateTestDatabase,
  readIntDbConfig,
} from "./test-support/int-db";

const getSessionMock = vi.fn();
vi.mock("@/lib/server/auth-guard", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: () => getSessionMock(),
    assertWorkspaceAccess: async () => null,
  };
});

const CFG = readIntDbConfig("archive");
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url; // db 모듈은 첫 쿼리 때 이 값을 읽는다

type DbMod = typeof import("./db");
type Archive = typeof import("./run-archive");
let dbm: DbMod;
let A: Archive;

const ADMIN = { kind: "admin", role: 0 };
const USER = { kind: "user", role: 1, uid: "u1" };

/* ------------------------------------------------------------------
 * 시험 데이터 도우미
 * ------------------------------------------------------------------ */
let wsCounter = 0;
async function makeWorkspace(label: string) {
  const [ws] = await dbm.db
    .insert(dbm.schema.workspaces)
    .values({ name: `${TEST_WORKSPACE_PREFIX}archive-${label}-${++wsCounter}`, isProduction: true })
    .returning();
  return ws;
}

async function addPrompt(wsId: string, text: string, active = true) {
  const [p] = await dbm.db.insert(dbm.schema.prompts).values({ workspaceId: wsId, text, active }).returning();
  return p;
}

const BASE_TS = Date.UTC(2026, 3, 1, 0, 0, 0); // 2026-04-01 — 과거(통계 구간 검사가 미래를 거절한다)
const ts = (minutes: number) => new Date(BASE_TS + minutes * 60_000);

async function addRuns(
  wsId: string,
  text: string,
  n: number,
  o: { isAuto?: boolean; startMin?: number; score?: number; provider?: string; createdAt?: Date } = {},
) {
  if (n === 0) return;
  const rows = Array.from({ length: n }, (_, i) => ({
    workspaceId: wsId,
    promptText: text,
    provider: o.provider ?? "chatgpt",
    visibilityScore: o.score ?? 40,
    sentiment: "neutral",
    isAuto: o.isAuto ?? true,
    createdAt: o.createdAt ?? ts((o.startMin ?? 0) + i),
  }));
  await dbm.db.insert(dbm.schema.runs).values(rows);
}

async function runStates(wsId: string) {
  return dbm.db
    .select({ id: dbm.schema.runs.id, text: dbm.schema.runs.promptText, archivedAt: dbm.schema.runs.archivedAt })
    .from(dbm.schema.runs)
    .where(eq(dbm.schema.runs.workspaceId, wsId))
    .orderBy(dbm.schema.runs.id);
}

async function archivedCount(wsId: string, text?: string) {
  const r = dbm.schema.runs;
  const [row] = await dbm.db
    .select({ n: count() })
    .from(r)
    .where(and(eq(r.workspaceId, wsId), isNotNull(r.archivedAt), text === undefined ? undefined : eq(r.promptText, text)));
  return Number(row.n);
}

async function runCount(wsId: string, text?: string) {
  const r = dbm.schema.runs;
  const [row] = await dbm.db
    .select({ n: count() })
    .from(r)
    .where(and(eq(r.workspaceId, wsId), text === undefined ? undefined : eq(r.promptText, text)));
  return Number(row.n);
}

function inTx<T>(fn: (tx: import("./run-archive").ArchiveDb) => Promise<T>): Promise<T> {
  return dbm.db.transaction(async (tx) => fn(tx));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanAll() {
  await dbm.db.delete(dbm.schema.workspaces).where(like(dbm.schema.workspaces.name, `${TEST_WORKSPACE_PREFIX}%`));
  getSessionMock.mockReset().mockResolvedValue(ADMIN);
}

/* ------------------------------------------------------------------ */

if (!CFG.enabled && CFG.mustFail) {
  describe("run-archive 통합 테스트", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("응답 보관 통합 (로컬 DB)", () => {
  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    dbm = await import("./db");
    A = await import("./run-archive");
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

  it("1 · 보관: 켜진 문구는 건너뛰고(skippedInList), 다른 워크스페이스는 그대로, 건수 정확", async () => {
    const ws = await makeWorkspace("1");
    const other = await makeWorkspace("1o");
    await addPrompt(ws.id, "가짜 켜진 질문 1", true);
    await addPrompt(ws.id, "가짜 꺼진 질문 1", false);
    await addRuns(ws.id, "가짜 켜진 질문 1", 3);
    await addRuns(ws.id, "가짜 꺼진 질문 1", 4);
    await addRuns(ws.id, "가짜 한 번 실행 1", 2, { isAuto: false });
    await addRuns(other.id, "가짜 꺼진 질문 1", 5);

    const r = await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 켜진 질문 1", "가짜 꺼진 질문 1", "가짜 한 번 실행 1", "없는 가짜 질문"]));
    expect(r).toEqual({ affectedRuns: 6, affectedQuestions: 2, skippedInList: ["가짜 켜진 질문 1"] });
    expect(await archivedCount(ws.id, "가짜 켜진 질문 1")).toBe(0);
    expect(await archivedCount(ws.id, "가짜 꺼진 질문 1")).toBe(4);
    expect(await archivedCount(ws.id, "가짜 한 번 실행 1")).toBe(2);
    expect(await archivedCount(other.id)).toBe(0);

    // 이미 보관된 응답은 다시 세지 않는다
    const again = await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 꺼진 질문 1"]));
    expect(again.affectedRuns).toBe(0);
  });

  it("2 · 스냅숏(I4): 보관 뒤 같은 문구로 새로 들어온 응답은 보관되지 않고 ①(아직 정리 안 한 질문)에 보인다", async () => {
    const ws = await makeWorkspace("2");
    await addRuns(ws.id, "가짜 스냅숏 질문", 3);
    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 스냅숏 질문"]));
    await addRuns(ws.id, "가짜 스냅숏 질문", 1, { createdAt: new Date() });

    expect(await archivedCount(ws.id)).toBe(3);
    const untracked = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "untracked", null));
    expect(untracked.items.map((i) => [i.promptText, i.runCount])).toEqual([["가짜 스냅숏 질문", 1]]);
    const archived = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "archived", null));
    expect(archived.items.map((i) => [i.promptText, i.runCount])).toEqual([["가짜 스냅숏 질문", 3]]);
  });

  it("3 · 되돌리기: 보관 전과 정확히 같은 상태로 돌아온다", async () => {
    const ws = await makeWorkspace("3");
    await addRuns(ws.id, "가짜 되돌릴 질문 A", 3);
    await addRuns(ws.id, "가짜 되돌릴 질문 B", 2, { isAuto: false });
    const before = await runStates(ws.id);

    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 되돌릴 질문 A", "가짜 되돌릴 질문 B"]));
    expect(await archivedCount(ws.id)).toBe(5);
    const r = await inTx((tx) => A.restoreByTexts(tx, ws.id, ["가짜 되돌릴 질문 A", "가짜 되돌릴 질문 B"]));
    expect(r).toEqual({ affectedRuns: 5, affectedQuestions: 2, skippedInList: [] });
    expect(await runStates(ws.id)).toEqual(before);
  });

  it("4 · 영구 삭제: 응답(보관·미보관 모두)·변동 알림을 지우고, 켜진 문구·다른 워크스페이스는 그대로", async () => {
    const ws = await makeWorkspace("4");
    const other = await makeWorkspace("4o");
    await addPrompt(ws.id, "가짜 켜진 질문 4", true);
    await addRuns(ws.id, "가짜 켜진 질문 4", 2);
    await addRuns(ws.id, "가짜 지울 질문 4", 3);
    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 지울 질문 4"]));
    await addRuns(ws.id, "가짜 지울 질문 4", 1, { createdAt: new Date() }); // 보관 뒤 새 응답(미보관)
    await addRuns(other.id, "가짜 지울 질문 4", 2);
    const alert = { provider: "chatgpt", oldScore: 50, newScore: 10, delta: -40, severity: "critical" };
    await dbm.db.insert(dbm.schema.driftAlerts).values([
      { ...alert, workspaceId: ws.id, promptText: "가짜 지울 질문 4" },
      { ...alert, workspaceId: ws.id, promptText: "가짜 켜진 질문 4" },
      { ...alert, workspaceId: other.id, promptText: "가짜 지울 질문 4" },
    ]);

    const r = await inTx((tx) => A.purgeUntracked(tx, ws.id, ["가짜 지울 질문 4", "가짜 켜진 질문 4"]));
    expect(r).toEqual({ affectedRuns: 4, affectedQuestions: 1, skippedInList: ["가짜 켜진 질문 4"], deletedAlerts: 1 });
    expect(await runCount(ws.id, "가짜 지울 질문 4")).toBe(0);
    expect(await runCount(ws.id, "가짜 켜진 질문 4")).toBe(2);
    expect(await runCount(other.id, "가짜 지울 질문 4")).toBe(2);
    const alerts = await dbm.db.select().from(dbm.schema.driftAlerts);
    expect(alerts.map((a) => [a.workspaceId === ws.id ? "ws" : "other", a.promptText]).sort()).toEqual(
      [["other", "가짜 지울 질문 4"], ["ws", "가짜 켜진 질문 4"]].sort(),
    );
  });

  it("5 · 보관함 목록: 문구 250개 → 200 + 50(중복·누락 없음) · 같은 시각이 여럿이어도 순서 고정 · counts", async () => {
    const ws = await makeWorkspace("5");
    await addPrompt(ws.id, "가짜 켜진 질문 5", true);
    await addRuns(ws.id, "가짜 켜진 질문 5", 2);
    // 250개 문구 · 50개씩 같은 시각을 갖게 해 동률 정렬을 시험한다
    const texts = Array.from({ length: 250 }, (_, i) => `가짜 대량 질문 ${String(i).padStart(3, "0")}`);
    const rows = texts.flatMap((t, i) => [
      { workspaceId: ws.id, promptText: t, provider: "chatgpt", visibilityScore: 10, sentiment: "neutral", isAuto: true, createdAt: ts(Math.floor(i / 50)) },
      { workspaceId: ws.id, promptText: t, provider: "gemini", visibilityScore: 10, sentiment: "neutral", isAuto: false, createdAt: ts(-1000) },
    ]);
    await dbm.db.insert(dbm.schema.runs).values(rows);

    const p1 = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "untracked", null));
    expect(p1.items).toHaveLength(200);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "untracked", A.parseArchiveCursor(p1.nextCursor)));
    expect(p2.items).toHaveLength(50);
    expect(p2.nextCursor).toBeNull();
    const seen = [...p1.items, ...p2.items].map((i) => i.promptText);
    expect(new Set(seen).size).toBe(250);
    expect([...seen].sort()).toEqual([...texts].sort());
    expect(seen).not.toContain("가짜 켜진 질문 5");
    // 같은 조회를 다시 해도 순서가 같다
    const again = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "untracked", null));
    expect(again.items.map((i) => i.promptText)).toEqual(p1.items.map((i) => i.promptText));
    // 최신 시각 묶음이 먼저 온다
    expect(p1.items[0].lastAt >= p2.items[p2.items.length - 1].lastAt).toBe(true);
    // 건수 칸
    const it0 = p1.items[0];
    expect([it0.runCount, it0.autoCount, it0.manualCount, it0.inList, it0.archivedAt]).toEqual([2, 1, 1, false, null]);
    expect(it0.firstAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const counts = await inTx((tx) => A.countArchiveQuestions(tx, ws.id));
    expect(counts).toEqual({ archivedQuestions: 0, untrackedQuestions: 250, untrackedRuns: 500 });

    // 보관한 질문 쪽도 200 + 50
    await inTx((tx) => A.archiveAllUntracked(tx, ws.id, new Date(Date.now() + 60_000).toISOString()));
    const a1 = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "archived", null));
    const a2 = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "archived", A.parseArchiveCursor(a1.nextCursor)));
    expect(a1.items).toHaveLength(200);
    expect(a2.items).toHaveLength(50);
    expect(new Set([...a1.items, ...a2.items].map((i) => i.promptText)).size).toBe(250);
    expect(a1.items[0].archivedAt).toMatch(/Z$/);
    expect(await inTx((tx) => A.countArchiveQuestions(tx, ws.id))).toEqual({
      archivedQuestions: 250,
      untrackedQuestions: 0,
      untrackedRuns: 0,
    });
  });

  it("5′ · 보관함 API(GET) — 쪽 넘김 표시·기준 시각·counts 가 실제 DB 로 왕복한다", async () => {
    const ws = await makeWorkspace("5r");
    const texts = Array.from({ length: 205 }, (_, i) => `가짜 API 질문 ${String(i).padStart(3, "0")}`);
    await dbm.db.insert(dbm.schema.runs).values(
      texts.map((t) => ({ workspaceId: ws.id, promptText: t, provider: "chatgpt", visibilityScore: 1, sentiment: "neutral", isAuto: true, createdAt: ts(0) })),
    );
    const { GET } = await import("@/app/api/workspaces/[id]/response-archive/route");
    const call = async (qs: string) =>
      GET(new NextRequest(`http://localhost/api/workspaces/${ws.id}/response-archive${qs}`), { params: Promise.resolve({ id: ws.id }) });
    const r1 = await call("?view=untracked");
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.items).toHaveLength(200);
    expect(b1.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(b1.counts).toEqual({ archivedQuestions: 0, untrackedQuestions: 205, untrackedRuns: 205 });
    const r2 = await call(`?view=untracked&cursor=${encodeURIComponent(b1.nextCursor)}`);
    const b2 = await r2.json();
    expect(b2.items).toHaveLength(5);
    expect(b2.nextCursor).toBeNull();
    expect(new Set([...b1.items, ...b2.items].map((i: { promptText: string }) => i.promptText)).size).toBe(205);
  });

  it("6 · 모두 보관(archive_all_untracked): 기준 시각 뒤에 들어온 응답은 남고, 켜진 문구는 빠진다", async () => {
    const ws = await makeWorkspace("6");
    await addPrompt(ws.id, "가짜 켜진 질문 6", true);
    await addRuns(ws.id, "가짜 켜진 질문 6", 2);
    await addRuns(ws.id, "가짜 목록 밖 6A", 3);
    await addRuns(ws.id, "가짜 목록 밖 6B", 2, { isAuto: false });
    const asOf = await inTx((tx) => A.readDbNow(tx));
    await sleep(20);
    await addRuns(ws.id, "가짜 목록 밖 6A", 1, { createdAt: new Date(Date.now() + 1000) }); // 목록을 연 뒤 새 응답

    const r = await inTx((tx) => A.archiveAllUntracked(tx, ws.id, asOf));
    expect(r).toEqual({ affectedRuns: 5, affectedQuestions: 2, skippedInList: [] });
    expect(await archivedCount(ws.id, "가짜 켜진 질문 6")).toBe(0);
    const untracked = await inTx((tx) => A.listArchiveQuestions(tx, ws.id, "untracked", null));
    expect(untracked.items.map((i) => [i.promptText, i.runCount])).toEqual([["가짜 목록 밖 6A", 1]]);

    // 미래 기준 시각이 와도 지금 시각을 넘지 않는다(아직 생기지 않은 응답을 미리 보관하지 않는다)
    const future = await inTx((tx) => A.archiveAllUntracked(tx, ws.id, "2099-01-01T00:00:00Z"));
    expect(future.affectedRuns).toBe(0);
  });

  it("7 · 수동 응답 삭제(scope=manual)는 보관 응답을 남기고, auto·all 은 보관 응답까지 지운다", async () => {
    const ws = await makeWorkspace("7");
    await addRuns(ws.id, "가짜 수동 보관 7", 2, { isAuto: false });
    await addRuns(ws.id, "가짜 수동 보임 7", 3, { isAuto: false });
    await addRuns(ws.id, "가짜 자동 보관 7", 4, { isAuto: true });
    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 수동 보관 7", "가짜 자동 보관 7"]));
    const { POST } = await import("@/app/api/workspaces/[id]/reset-responses/route");
    const reset = (scope: string) =>
      POST(new NextRequest(`http://localhost/api/workspaces/${ws.id}/reset-responses?scope=${scope}`, { method: "POST" }), {
        params: Promise.resolve({ id: ws.id }),
      });

    getSessionMock.mockResolvedValue(USER);
    const m = await reset("manual");
    expect((await m.json()).deleted.runs).toBe(3);
    expect(await runCount(ws.id, "가짜 수동 보관 7")).toBe(2);

    getSessionMock.mockResolvedValue(ADMIN);
    const a = await reset("auto");
    expect((await a.json()).deleted.runs).toBe(4);
    expect(await runCount(ws.id, "가짜 자동 보관 7")).toBe(0);
    const all = await reset("all");
    expect((await all.json()).deleted.runs).toBe(2);
    expect(await runCount(ws.id)).toBe(0);
  });

  it("8 · 변동 알림: 보관 전 알림은 숨고 되돌리면 보이며, 보관 뒤 새 알림은 보인다", async () => {
    const ws = await makeWorkspace("8");
    await addRuns(ws.id, "가짜 알림 질문 8", 2);
    const alert = { workspaceId: ws.id, promptText: "가짜 알림 질문 8", provider: "chatgpt", oldScore: 50, newScore: 10, delta: -40, severity: "critical" };
    await dbm.db.insert(dbm.schema.driftAlerts).values({ ...alert, createdAt: new Date(Date.now() - 60_000) });
    const { GET } = await import("@/app/api/workspaces/[id]/drift/route");
    const alerts = async () =>
      (await (await GET(new NextRequest(`http://localhost/api/workspaces/${ws.id}/drift?dismissed=false`), { params: Promise.resolve({ id: ws.id }) })).json())
        .alerts as { id: string }[];

    expect(await alerts()).toHaveLength(1);
    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 알림 질문 8"]));
    expect(await alerts()).toHaveLength(0);
    await sleep(20);
    await dbm.db.insert(dbm.schema.driftAlerts).values({ ...alert, createdAt: new Date(Date.now() + 1000) });
    expect(await alerts()).toHaveLength(1);
    await inTx((tx) => A.restoreByTexts(tx, ws.id, ["가짜 알림 질문 8"]));
    expect(await alerts()).toHaveLength(2);
  });

  it("9 · 통계 헬퍼·재산출 리포트 조건을 실제 쿼리로 돌리면 보관 응답이 빠진다", async () => {
    const { buildRunStatsWhere } = await import("./run-stats-where");
    const { buildReportConditions } = await import("./visibility-rescore-selector");
    const ws = await makeWorkspace("9");
    await addRuns(ws.id, "가짜 통계 질문 남김", 3, { score: 80 });
    await addRuns(ws.id, "가짜 통계 질문 보관", 2, { score: 0 });
    const r = dbm.schema.runs;
    const statsCount = async () => {
      const where = and(
        ...buildRunStatsWhere({ workspaceId: ws.id, fromDate: ts(-10), toDate: ts(100), autoOnly: true, brandTerms: [], branded: false }),
      );
      const [row] = await dbm.db.select({ n: count(), avg: sql<number>`avg(${r.visibilityScore})::float` }).from(r).where(where);
      return [Number(row.n), Math.round(Number(row.avg))];
    };
    const reportCount = async () => {
      const conds = buildReportConditions(
        { key: "target", fromUtc: ts(-10).toISOString(), toUtc: ts(100).toISOString(), providers: null, excludeProviders: null },
        [{ id: ws.id, brandTerms: ["가짜브랜드"] }],
      );
      const [row] = await dbm.db.select({ n: count() }).from(r).where(and(...conds));
      return Number(row.n);
    };

    expect(await statsCount()).toEqual([5, 48]);
    expect(await reportCount()).toBe(5);
    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 통계 질문 보관"]));
    expect(await statsCount()).toEqual([3, 80]);
    expect(await reportCount()).toBe(3);
    await inTx((tx) => A.restoreByTexts(tx, ws.id, ["가짜 통계 질문 보관"]));
    expect(await statsCount()).toEqual([5, 48]);
  });

  it("10 · 잠금: 질문을 다시 켜는 트랜잭션이 끝날 때까지 보관·영구 삭제가 기다렸다가, 켜진 문구를 건너뛴다", async () => {
    for (const op of ["archive", "purge"] as const) {
      const ws = await makeWorkspace(`10-${op}`);
      const text = `가짜 잠금 질문 ${op}`;
      const p = await addPrompt(ws.id, text, false);
      await addRuns(ws.id, text, 3);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));

      // 연결 1 — 질문 추가(다시 켜기)와 같은 흐름: 잠금 → 켜기 → 되돌리기, 그리고 커밋 전에 멈춘다
      const t1 = inTx(async (tx) => {
        await A.lockResponseArchive(tx, ws.id);
        await tx.update(dbm.schema.prompts).set({ active: true }).where(eq(dbm.schema.prompts.id, p.id));
        await A.restoreByTexts(tx, ws.id, [text]);
        markLocked();
        await gate;
      });
      await locked;

      // 연결 2 — 보관 또는 영구 삭제
      let done = false;
      const t2 = inTx(async (tx) => {
        await A.applyArchiveTxTimeouts(tx);
        return op === "archive" ? A.archiveByTexts(tx, ws.id, [text]) : A.purgeUntracked(tx, ws.id, [text]);
      }).then((res) => {
        done = true;
        return res;
      });
      await sleep(300);
      expect(done, `${op} 이 잠금을 기다리지 않았다`).toBe(false);

      release();
      await t1;
      const res = await t2;
      expect(res.skippedInList).toEqual([text]);
      expect(res.affectedRuns).toBe(0);
      expect(await runCount(ws.id, text)).toBe(3);
      expect(await archivedCount(ws.id, text)).toBe(0);
    }
  });

  it("재추가 자동 복원 — 질문 추가 API 가 보관 응답을 되돌리고 건수를 알린다(목록에 다시 들어온다)", async () => {
    const ws = await makeWorkspace("readd");
    await addPrompt(ws.id, "가짜 재추가 질문", false);
    await addRuns(ws.id, "가짜 재추가 질문", 4);
    await inTx((tx) => A.archiveByTexts(tx, ws.id, ["가짜 재추가 질문"]));
    expect(await archivedCount(ws.id)).toBe(4);

    getSessionMock.mockResolvedValue(USER);
    const { POST } = await import("@/app/api/workspaces/[id]/prompts/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/workspaces/${ws.id}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "가짜 재추가 질문", tags: [] }),
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.restoredRuns).toBe(4);
    expect(body.prompt.active).toBe(true);
    expect(await archivedCount(ws.id)).toBe(0);
    const counts = await inTx((tx) => A.countArchiveQuestions(tx, ws.id));
    expect(counts).toEqual({ archivedQuestions: 0, untrackedQuestions: 0, untrackedRuns: 0 });
    // 켜진 질문이 되어 목록 밖 조건에서도 빠진다
    const rows = await dbm.db
      .select({ n: count() })
      .from(dbm.schema.runs)
      .where(and(eq(dbm.schema.runs.workspaceId, ws.id), inArray(dbm.schema.runs.promptText, ["가짜 재추가 질문"]), A.notInTrackedListCondition()));
    expect(Number(rows[0].n)).toBe(0);
  });
});
