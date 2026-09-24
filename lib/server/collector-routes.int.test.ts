/**
 * collector-routes.int.test.ts — 즉시 실행·상태 조회 라우트 통합 테스트 (로컬 DB · 실제 엔진).
 * 계획 geotracker-collect-speed-260924 §11 "trigger 라우트 테스트" · "collection-rounds 라우트 테스트".
 *
 * 권한 확인(auth-guard)만 가짜고, DB·엔진은 실제다. Bright Data 는 부르지 않는다(회차 만들기만 확인) —
 * 전역 fetch 를 가짜로 바꿔 실수로 네트워크를 부르면 즉시 실패한다.
 * 실행 조건·안전장치는 collector-engine.int.test.ts 와 같다(test-support/int-db.ts).
 * ⚠️ PUBLIC 저장소 — 질문·브랜드는 가짜 값이다.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, like } from "drizzle-orm";
import type { BrandConfig, Schedule } from "@/drizzle/schema";
import {
  TEST_WORKSPACE_PREFIX,
  assertOnlyTestData,
  ensureTestDatabase,
  migrateTestDatabase,
  readIntDbConfig,
} from "./test-support/int-db";
import { formatIntervalSlot } from "./collector-schedule";

vi.mock("@/lib/server/llm-sentiment", () => ({ classifySentiment: vi.fn(async () => null) }));

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
}));

const CFG = readIntDbConfig("routes");
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url;

type DbMod = typeof import("./db");
type Engine = typeof import("./collector-engine");
let dbm: DbMod;
let engine: Engine;
let triggerPOST: (typeof import("@/app/api/schedules/[id]/trigger/route"))["POST"];
let roundsGET: (typeof import("@/app/api/workspaces/[id]/collection-rounds/route"))["GET"];

const BRAND: BrandConfig = {
  brandName: "시험브랜드",
  brandAliases: "",
  websites: ["https://brand.example"],
  industry: "",
  keywords: "",
  description: "",
};

let wsCounter = 0;
async function makeWorkspace(label: string) {
  const [ws] = await dbm.db
    .insert(dbm.schema.workspaces)
    .values({ name: `${TEST_WORKSPACE_PREFIX}route-${label}-${++wsCounter}`, brandConfig: BRAND, isProduction: true })
    .returning();
  return ws;
}

async function makePrompts(wsId: string, texts: string[]) {
  const out: { id: string; text: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const [p] = await dbm.db
      .insert(dbm.schema.prompts)
      .values({ workspaceId: wsId, text: texts[i], createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)) })
      .returning({ id: dbm.schema.prompts.id, text: dbm.schema.prompts.text });
    out.push(p);
  }
  return out;
}

async function makeSchedule(wsId: string, o: Partial<typeof dbm.schema.schedules.$inferInsert> = {}): Promise<Schedule> {
  const [s] = await dbm.db
    .insert(dbm.schema.schedules)
    .values({
      workspaceId: wsId,
      name: "시험 스케줄",
      cronExpression: "0 */6 * * *",
      providers: ["chatgpt", "gemini"],
      promptIds: [],
      active: true,
      nextRunAt: new Date("2099-01-01T00:00:00Z"),
      ...o,
    })
    .returning();
  return s;
}

function trigger(id: string) {
  return triggerPOST(new NextRequest(`http://localhost/api/schedules/${id}/trigger`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

function rounds(wsId: string, query = "") {
  return roundsGET(new NextRequest(`http://localhost/api/workspaces/${wsId}/collection-rounds${query}`), {
    params: Promise.resolve({ id: wsId }),
  });
}

async function itemsOf(scheduleId: string) {
  const rs = await dbm.db
    .select({ id: dbm.schema.collectionRounds.id })
    .from(dbm.schema.collectionRounds)
    .where(eq(dbm.schema.collectionRounds.scheduleId, scheduleId));
  const out = [];
  for (const r of rs) {
    out.push(
      ...(await dbm.db.select().from(dbm.schema.collectionItems).where(eq(dbm.schema.collectionItems.roundId, r.id))),
    );
  }
  return out;
}

async function cleanAll() {
  await dbm.db.delete(dbm.schema.workspaces).where(like(dbm.schema.workspaces.name, `${TEST_WORKSPACE_PREFIX}%`));
  await dbm.db.delete(dbm.schema.collectorState);
  engine._resetCollectorMemoryForTest();
  vi.unstubAllEnvs();
  vi.stubEnv("GEO_COLLECTOR_ENGINE", "queue");
  getSessionMock.mockReset().mockResolvedValue({ kind: "admin", role: 0 });
  assertWorkspaceAccessMock.mockReset().mockResolvedValue(null);
}

if (!CFG.enabled && CFG.mustFail) {
  describe("collector 라우트 통합 테스트", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("즉시 실행·상태 조회 라우트 (로컬 DB)", () => {
  let savedState: { key: string; value: Record<string, unknown>; updatedAt: Date }[] = [];

  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    vi.stubGlobal("fetch", async (url: string) => {
      throw new Error(`통합 테스트에서 예상하지 못한 네트워크 호출: ${String(url).slice(0, 60)}`);
    });
    dbm = await import("./db");
    engine = await import("./collector-engine");
    triggerPOST = (await import("@/app/api/schedules/[id]/trigger/route")).POST;
    roundsGET = (await import("@/app/api/workspaces/[id]/collection-rounds/route")).GET;
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
    vi.unstubAllEnvs();
  });

  it("권한 없음 → 403, 회차·항목이 생기지 않는다", async () => {
    const ws = await makeWorkspace("403");
    await makePrompts(ws.id, ["시험 질문 권한 01"]);
    const s = await makeSchedule(ws.id);
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await trigger(s.id);
    expect(res.status).toBe(403);
    expect(await itemsOf(s.id)).toHaveLength(0);
  }, 60_000);

  it("새 회차 — 항목 = 질문 × AI · newItems · 우선순위 1 · last_run_at 갱신 · next_run_at 그대로", async () => {
    const ws = await makeWorkspace("new");
    await makePrompts(ws.id, ["시험 질문 새 01", "시험 질문 새 02"]);
    const s = await makeSchedule(ws.id);
    const res = await trigger(s.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newItems).toBe(4);
    expect(body.round).toMatchObject({ trigger: "manual", priority: 1, status: "running", expectedItems: 4 });
    expect(body.round.scoringSnapshot).toBeUndefined();
    expect(await itemsOf(s.id)).toHaveLength(4);
    const [row] = await dbm.db.select().from(dbm.schema.schedules).where(eq(dbm.schema.schedules.id, s.id));
    expect(row.lastRunAt).not.toBeNull();
    expect(row.nextRunAt!.toISOString()).toBe("2099-01-01T00:00:00.000Z");
  }, 60_000);

  it("두 번 연속(동시에) 눌러도 항목 중복 없음 — 두 번째는 진행 중 회차에 합류", async () => {
    const ws = await makeWorkspace("twice");
    await makePrompts(ws.id, ["시험 질문 두번 01", "시험 질문 두번 02"]);
    const s = await makeSchedule(ws.id);
    const [a, b] = await Promise.all([trigger(s.id), trigger(s.id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((x) => x.joinedRunning === true)).toHaveLength(1);
    const its = await itemsOf(s.id);
    expect(its).toHaveLength(4);
    const keys = its.map((i) => `${i.roundId}|${i.promptText}|${i.provider}`);
    expect(new Set(keys).size).toBe(4);
    const rs = await dbm.db
      .select()
      .from(dbm.schema.collectionRounds)
      .where(eq(dbm.schema.collectionRounds.scheduleId, s.id));
    expect(rs).toHaveLength(1);
  }, 60_000);

  it("진행 중 회차에 합류 — 새로 추가한 질문만 더하고 우선순위 1", async () => {
    const ws = await makeWorkspace("join");
    await makePrompts(ws.id, ["시험 질문 합류 01"]);
    const s = await makeSchedule(ws.id);
    // 정기 회차(우선순위 0)가 진행 중인 상태
    const cron = await engine.createRoundForSchedule(
      s,
      { trigger: "cron", scheduledFor: new Date(), priority: 0, onRunning: "skip" },
      new Date(),
    );
    expect(cron.status).toBe("created");
    await makePrompts(ws.id, ["시험 질문 합류 02 추가"]);

    const res = await trigger(s.id);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, joinedRunning: true, addedItems: 2, newItems: 2 });
    expect(body.hint).toBe("진행 중인 조사에 새 질문 1개를 더해 먼저 처리합니다.");
    expect(body.round.priority).toBe(1);
    const its = await itemsOf(s.id);
    expect(its).toHaveLength(4);
    expect(new Set(its.map((i) => i.roundId)).size).toBe(1);
  }, 60_000);

  it("같은 시간대 재실행 → newItems 0 (이미 모은 결과가 있으면 다시 모으지 않는다)", async () => {
    const ws = await makeWorkspace("same");
    const [p] = await makePrompts(ws.id, ["시험 질문 같은시간 01"]);
    const s = await makeSchedule(ws.id, { providers: ["chatgpt"] });
    const slotBefore = formatIntervalSlot(new Date());
    // 이번 시간대에 이미 모은 결과
    await dbm.db.insert(dbm.schema.runs).values({
      workspaceId: ws.id,
      scheduleId: s.id,
      promptText: p.text,
      provider: "chatgpt",
      answer: "이미 모은 시험 응답 문장입니다.",
      visibilityScore: 0,
      sentiment: "not-mentioned",
      isAuto: true,
      intervalSlot: slotBefore,
    });
    const res = await trigger(s.id);
    const body = await res.json();
    if (formatIntervalSlot(new Date()) !== slotBefore) return; // 정시를 넘긴 드문 경우 — 판정 불가라 건너뜀
    expect(body.newItems).toBe(0);
    expect(body.hint).toContain("이미 모두 모았습니다");
  }, 60_000);

  it("꺼진 스케줄 켤 때 — active=true · 다음 시각은 지금 이후 첫 cron · 회차 생성", async () => {
    const ws = await makeWorkspace("off");
    await makePrompts(ws.id, ["시험 질문 꺼짐 01"]);
    const s = await makeSchedule(ws.id, { active: false, nextRunAt: null });
    const before = Date.now();
    const res = await trigger(s.id);
    expect(res.status).toBe(200);
    const [row] = await dbm.db.select().from(dbm.schema.schedules).where(eq(dbm.schema.schedules.id, s.id));
    expect(row.active).toBe(true);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(before);
    expect(await itemsOf(s.id)).toHaveLength(2);
  }, 60_000);

  it("legacy 동작 그대로 — next_run_at 을 과거로, 회차는 만들지 않는다", async () => {
    vi.stubEnv("GEO_COLLECTOR_ENGINE", "legacy");
    const ws = await makeWorkspace("legacy");
    await makePrompts(ws.id, ["시험 질문 예전 01"]);
    const s = await makeSchedule(ws.id);
    const res = await trigger(s.id);
    expect(res.status).toBe(200);
    const [row] = await dbm.db.select().from(dbm.schema.schedules).where(eq(dbm.schema.schedules.id, s.id));
    expect(row.nextRunAt!.getTime()).toBeLessThan(Date.now());
    expect(await itemsOf(s.id)).toHaveLength(0);
  }, 60_000);

  it("상태 조회 — 권한 403 · 요청 번호·원문 오류는 내보내지 않고 코드만", async () => {
    const ws = await makeWorkspace("status");
    const [p1, p2] = await makePrompts(ws.id, ["시험 질문 상태 01", "시험 질문 상태 02"]);
    const s = await makeSchedule(ws.id, { providers: ["perplexity"] });
    const created = await engine.createRoundForSchedule(
      s,
      { trigger: "manual", scheduledFor: new Date(), priority: 1, onRunning: "top_up" },
      new Date(),
    );
    if (created.status !== "created") throw new Error("회차가 만들어져야 한다");
    const SECRET_SNAPSHOT = "sd_secret_snapshot_0000";
    const RAW_ERROR = "Auth wall: sign-up prompt detected at https://internal.example/path?token=abc";
    await dbm.db
      .update(dbm.schema.collectionItems)
      .set({ status: "failed", snapshotId: SECRET_SNAPSHOT, lastErrorCode: "CRAWLER_AUTH_WALL", lastError: RAW_ERROR })
      .where(and(eq(dbm.schema.collectionItems.roundId, created.round.id), eq(dbm.schema.collectionItems.promptText, p1.text)));
    await dbm.db
      .update(dbm.schema.collectionItems)
      .set({ status: "submitted", snapshotId: `${SECRET_SNAPSHOT}_2` })
      .where(and(eq(dbm.schema.collectionItems.roundId, created.round.id), eq(dbm.schema.collectionItems.promptText, p2.text)));

    assertWorkspaceAccessMock.mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await rounds(ws.id)).status).toBe(403);

    const res = await rounds(ws.id, `?scheduleId=${s.id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_SNAPSHOT);
    expect(text).not.toContain("Auth wall");
    expect(text).not.toContain("token=abc");
    const body = JSON.parse(text);
    expect(body.engine).toBe("queue");
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0]).toMatchObject({
      id: created.round.id,
      scheduleName: "시험 스케줄",
      status: "running",
      expected: 2,
      counts: { failed: 1, submitted: 1 },
      byProvider: { perplexity: { failed: 1, pending: 1 } },
      topErrors: [{ provider: "perplexity", code: "CRAWLER_AUTH_WALL", count: 1 }],
    });
  }, 60_000);
});
