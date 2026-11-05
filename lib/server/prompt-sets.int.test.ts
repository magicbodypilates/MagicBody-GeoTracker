/**
 * prompt-sets.int.test.ts — 질문 세트 통합 시험 (로컬 DB · 계획 prompt-sets-plan-v2 §9-2 I4～I7).
 *
 * 실행: GEO_TEST_POSTGRES_URL=<로컬 시험 DB> GEO_REQUIRE_DB_TESTS=1 npx vitest run lib/server/prompt-sets.int.test.ts
 *   - URL 이 없으면 건너뛴다. GEO_REQUIRE_DB_TESTS=1 이면 URL 이 없을 때 실패한다.
 *   - 호스트가 로컬이 아니거나 DB 이름에 "test" 가 없으면 즉시 중단한다(test-support/int-db.ts).
 *
 * DB 는 실제, 권한(auth-guard)만 가짜다(app/api/prompts/[id]/route.int.test.ts 와 같은 패턴).
 * 동시성 시험(I6·I7 set_gone)은 별도 연결로 잠금을 쥐고, 상대 요청이 실제로 잠금을 기다리는지
 * pg_stat_activity 로 확인한 뒤 풀어 준다 — 시간에 기대지 않는다.
 *
 * ⚠️ PUBLIC 저장소 — 질문 문구는 전부 가짜 값이다.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { and, eq, like } from "drizzle-orm";
import postgres from "postgres";
import {
  TEST_WORKSPACE_PREFIX,
  assertOnlyTestData,
  ensureTestDatabase,
  insertTestPrompt,
  migrateTestDatabase,
  readIntDbConfig,
} from "./test-support/int-db";

const getSessionMock = vi.fn(async () => ({ kind: "admin", role: 0 }));
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: async () => null,
  requireAdmin: () => null,
}));

const CFG = readIntDbConfig("promptsets");
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url; // db 모듈은 첫 쿼리 때 이 값을 읽는다

type DbMod = typeof import("./db");
type SetsRoute = typeof import("@/app/api/workspaces/[id]/prompt-sets/route");
type SetRoute = typeof import("@/app/api/prompt-sets/[setId]/route");
type MoveRoute = typeof import("@/app/api/workspaces/[id]/prompts/move/route");
type PromptsRoute = typeof import("@/app/api/workspaces/[id]/prompts/route");
type PromptRoute = typeof import("@/app/api/prompts/[id]/route");
type WorkspacesRoute = typeof import("@/app/api/workspaces/route");

let dbm: DbMod;
let setsRoute: SetsRoute;
let setRoute: SetRoute;
let moveRoute: MoveRoute;
let promptsRoute: PromptsRoute;
let promptRoute: PromptRoute;
let workspacesRoute: WorkspacesRoute;
let side: ReturnType<typeof postgres>;

/* ------------------------------------------------------------------
 * 도우미
 * ------------------------------------------------------------------ */
let wsCounter = 0;
async function makeWorkspace(label: string) {
  const [ws] = await dbm.db
    .insert(dbm.schema.workspaces)
    .values({ name: `${TEST_WORKSPACE_PREFIX}sets-${label}-${++wsCounter}`, isProduction: true })
    .returning();
  return ws;
}

function json(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createSet(wsId: string, name: string) {
  const res = await setsRoute.POST(json("POST", `http://localhost/api/workspaces/${wsId}/prompt-sets`, { name }), {
    params: Promise.resolve({ id: wsId }),
  });
  return { res, body: await res.json() };
}

async function listSets(wsId: string) {
  const res = await setsRoute.GET(new NextRequest(`http://localhost/api/workspaces/${wsId}/prompt-sets`), {
    params: Promise.resolve({ id: wsId }),
  });
  return (await res.json()) as {
    sets: { id: string; name: string; isDefault: boolean; activePromptCount: number }[];
  };
}

function deleteSet(setId: string) {
  return setRoute.DELETE(new NextRequest(`http://localhost/api/prompt-sets/${setId}`, { method: "DELETE" }), {
    params: Promise.resolve({ setId }),
  });
}

function addPrompt(wsId: string, body: { text: string; setId?: string }) {
  return promptsRoute.POST(json("POST", `http://localhost/api/workspaces/${wsId}/prompts`, body), {
    params: Promise.resolve({ id: wsId }),
  });
}

function move(wsId: string, body: unknown) {
  return moveRoute.POST(json("POST", `http://localhost/api/workspaces/${wsId}/prompts/move`, body), {
    params: Promise.resolve({ id: wsId }),
  });
}

async function promptRow(id: string) {
  const [row] = await dbm.db.select().from(dbm.schema.prompts).where(eq(dbm.schema.prompts.id, id));
  return row;
}

async function defaultSetId(wsId: string) {
  const [row] = await dbm.db
    .select({ id: dbm.schema.promptSets.id })
    .from(dbm.schema.promptSets)
    .where(and(eq(dbm.schema.promptSets.workspaceId, wsId), eq(dbm.schema.promptSets.isDefault, true)));
  return row?.id;
}

/** 이 시험 DB 에서 잠금을 기다리는 연결 수 — 상대 요청이 실제로 막혔는지 확인용. */
async function lockWaiters(): Promise<number> {
  const [row] = await side<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`;
  return Number(row?.n ?? 0);
}

async function waitForLockWaiters(n: number, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await lockWaiters()) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`잠금 대기 연결이 ${n}개가 되지 않음`);
}

async function cleanAll() {
  await dbm.db.delete(dbm.schema.workspaces).where(like(dbm.schema.workspaces.name, `${TEST_WORKSPACE_PREFIX}%`));
}

/* ------------------------------------------------------------------ */

if (!CFG.enabled && CFG.mustFail) {
  describe("질문 세트 통합 시험", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("질문 세트 (로컬 DB)", () => {
  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    dbm = await import("./db");
    setsRoute = await import("@/app/api/workspaces/[id]/prompt-sets/route");
    setRoute = await import("@/app/api/prompt-sets/[setId]/route");
    moveRoute = await import("@/app/api/workspaces/[id]/prompts/move/route");
    promptsRoute = await import("@/app/api/workspaces/[id]/prompts/route");
    promptRoute = await import("@/app/api/prompts/[id]/route");
    workspacesRoute = await import("@/app/api/workspaces/route");
    side = postgres(CFG.url, { max: 2, onnotice: () => {} });
    await cleanAll();
  }, 120_000);

  afterEach(async () => {
    await cleanAll();
  });

  afterAll(async () => {
    if (!dbm) return;
    await cleanAll();
    await side?.end();
    const g = globalThis as unknown as { __geotracker_pg_client?: { end: () => Promise<void> } };
    await g.__geotracker_pg_client?.end();
  });

  it("마이그레이션 직후 — 세트 칸은 필수, 외래 키는 삭제 동작 없음(NO ACTION)", async () => {
    const [col] = await side<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns where table_name = 'prompts' and column_name = 'set_id'`;
    expect(col.is_nullable).toBe("NO");
    const [fk] = await side<{ confdeltype: string }[]>`
      select confdeltype from pg_constraint where conname = 'prompts_set_id_prompt_sets_id_fk'`;
    expect(fk.confdeltype).toBe("a"); // a = NO ACTION
  });

  it("워크스페이스 만들기 → 같은 트랜잭션에서 「기존 세트」가 생긴다", async () => {
    const res = await workspacesRoute.POST(
      json("POST", "http://localhost/api/workspaces", { name: `${TEST_WORKSPACE_PREFIX}sets-new-ws` }),
    );
    expect(res.status).toBe(201);
    const { workspace } = await res.json();
    const { sets } = await listSets(workspace.id);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ name: "기존 세트", isDefault: true, activePromptCount: 0 });
  });

  it("세트 만들기·목록·이름 바꾸기 — 기본 세트 먼저, 같은 이름 409, isDefault 는 받지 않음", async () => {
    const ws = await makeWorkspace("crud");
    const a = await createSet(ws.id, "  새 세트  ");
    expect(a.res.status).toBe(201);
    expect(a.body.set.name).toBe("새 세트"); // 앞뒤 공백 제거
    // 세트를 만들기 전에 기본 세트를 먼저 보장한다
    let { sets } = await listSets(ws.id);
    expect(sets.map((s) => [s.name, s.isDefault])).toEqual([
      ["기존 세트", true],
      ["새 세트", false],
    ]);

    const dup = await createSet(ws.id, "새 세트");
    expect(dup.res.status).toBe(409);
    expect(dup.body.error).toBe("set_name_taken");
    expect(JSON.stringify(dup.body)).not.toMatch(/uq_prompt_sets|Failed query/);

    const bad = await setRoute.PATCH(
      json("PATCH", `http://localhost/api/prompt-sets/${a.body.set.id}`, { name: "x", isDefault: true }),
      { params: Promise.resolve({ setId: a.body.set.id }) },
    );
    expect(bad.status).toBe(400);

    const ok = await setRoute.PATCH(
      json("PATCH", `http://localhost/api/prompt-sets/${a.body.set.id}`, { name: "바꾼 이름" }),
      { params: Promise.resolve({ setId: a.body.set.id }) },
    );
    expect(ok.status).toBe(200);
    // 기존 세트도 이름은 바꿀 수 있다
    const def = sets[0].id;
    const okDef = await setRoute.PATCH(json("PATCH", `http://localhost/api/prompt-sets/${def}`, { name: "처음 질문" }), {
      params: Promise.resolve({ setId: def }),
    });
    expect(okDef.status).toBe(200);
    ({ sets } = await listSets(ws.id));
    expect(sets.map((s) => s.name)).toEqual(["처음 질문", "바꾼 이름"]);

    const dupRename = await setRoute.PATCH(
      json("PATCH", `http://localhost/api/prompt-sets/${a.body.set.id}`, { name: "처음 질문" }),
      { params: Promise.resolve({ setId: a.body.set.id }) },
    );
    expect(dupRename.status).toBe(409);
  });

  it("형식 틀린 번호 → DB 를 타기 전에 400", async () => {
    const r1 = await deleteSet("not-a-uuid");
    expect(r1.status).toBe(400);
    const ws = await makeWorkspace("uuid");
    const r2 = await move(ws.id, { promptIds: ["x"], setId: "y" });
    expect(r2.status).toBe(400);
  });

  it("I4 · 세트·질문이 있는 워크스페이스 삭제 → 세트·질문까지 함께 지워진다(외래 키에 막히지 않음)", async () => {
    const ws = await makeWorkspace("cascade");
    const { body } = await createSet(ws.id, "다른 세트");
    await insertTestPrompt(dbm.db, ws.id, { text: "가짜 질문 기존" });
    await insertTestPrompt(dbm.db, ws.id, { text: "가짜 질문 다른", setId: body.set.id });

    await dbm.db.delete(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, ws.id));

    const sets = await dbm.db.select().from(dbm.schema.promptSets).where(eq(dbm.schema.promptSets.workspaceId, ws.id));
    const prompts = await dbm.db.select().from(dbm.schema.prompts).where(eq(dbm.schema.prompts.workspaceId, ws.id));
    expect(sets).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("I5 · 질문 이동 — 응답 행·문장, 일정의 질문 선택은 그대로", async () => {
    const ws = await makeWorkspace("move");
    const other = await makeWorkspace("move-other");
    const p1 = await insertTestPrompt(dbm.db, ws.id, { text: "가짜 이동 질문 1" });
    const p2 = await insertTestPrompt(dbm.db, ws.id, { text: "가짜 이동 질문 2" });
    const pOther = await insertTestPrompt(dbm.db, other.id, { text: "가짜 남의 질문" });
    await dbm.db.insert(dbm.schema.runs).values(
      [p1, p2].map((p) => ({
        workspaceId: ws.id,
        promptText: p.text,
        provider: "chatgpt",
        answer: "가짜 답",
        visibilityScore: 10,
        sentiment: "neutral",
      })),
    );
    const [sch] = await dbm.db
      .insert(dbm.schema.schedules)
      .values({ workspaceId: ws.id, name: "가짜 일정", cronExpression: "0 0 * * *", providers: ["chatgpt"], promptIds: [p1.id, p2.id] })
      .returning();
    const runsBefore = await dbm.db
      .select({ id: dbm.schema.runs.id, text: dbm.schema.runs.promptText })
      .from(dbm.schema.runs)
      .where(eq(dbm.schema.runs.workspaceId, ws.id));

    const { body } = await createSet(ws.id, "새 세트");
    const res = await move(ws.id, { promptIds: [p1.id, p2.id, pOther.id, p1.id], setId: body.set.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 2, notFound: [pOther.id] });

    expect((await promptRow(p1.id)).setId).toBe(body.set.id);
    expect((await promptRow(p2.id)).setId).toBe(body.set.id);
    expect((await promptRow(pOther.id)).setId).toBe(await defaultSetId(other.id)); // 남의 질문은 그대로

    const runsAfter = await dbm.db
      .select({ id: dbm.schema.runs.id, text: dbm.schema.runs.promptText })
      .from(dbm.schema.runs)
      .where(eq(dbm.schema.runs.workspaceId, ws.id));
    expect(runsAfter).toEqual(runsBefore);
    const [schAfter] = await dbm.db.select().from(dbm.schema.schedules).where(eq(dbm.schema.schedules.id, sch.id));
    expect(schAfter.promptIds).toEqual([p1.id, p2.id]);

    // 다른 워크스페이스의 세트로는 옮길 수 없다
    const otherDefault = await defaultSetId(other.id);
    const bad = await move(ws.id, { promptIds: [p1.id], setId: otherDefault });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_set");

    const { sets } = await listSets(ws.id);
    expect(sets.find((s) => s.isDefault)!.activePromptCount).toBe(0);
    expect(sets.find((s) => !s.isDefault)!.activePromptCount).toBe(2);
  });

  it("I6 · 세트 삭제 — 켜진 질문 409 · 꺼진 질문만이면 기존 세트로 옮기고 삭제 · 기존 세트는 400", async () => {
    const ws = await makeWorkspace("del");
    const { body } = await createSet(ws.id, "지울 세트");
    const setId = body.set.id as string;
    const on = await insertTestPrompt(dbm.db, ws.id, { text: "가짜 켜진 질문", setId });
    const off = await insertTestPrompt(dbm.db, ws.id, { text: "가짜 꺼진 질문", setId, active: false });

    const r1 = await deleteSet(setId);
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ error: "set_not_empty", activeCount: 1 });

    await dbm.db.delete(dbm.schema.prompts).where(eq(dbm.schema.prompts.id, on.id));
    const r2 = await deleteSet(setId);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, movedInactive: 1 });
    expect((await promptRow(off.id)).setId).toBe(await defaultSetId(ws.id));
    const gone = await dbm.db.select().from(dbm.schema.promptSets).where(eq(dbm.schema.promptSets.id, setId));
    expect(gone).toHaveLength(0);

    const def = (await defaultSetId(ws.id))!;
    const r3 = await deleteSet(def);
    expect(r3.status).toBe(400);
    expect((await r3.json()).error).toBe("default_set_locked");
  });

  it("I6 · 삭제가 질문 행을 잡은 동안 「다시 켜기」는 기다렸다가 기존 세트에서 켜진다", async () => {
    const ws = await makeWorkspace("race");
    const { body } = await createSet(ws.id, "경합 세트");
    const setId = body.set.id as string;
    const off = await insertTestPrompt(dbm.db, ws.id, { text: "가짜 경합 질문", setId, active: false });
    const def = (await defaultSetId(ws.id))!;

    // 기본 세트 행을 쥐어, 삭제가 ⑤(기본 세트로 옮기기)의 외래 키 검사에서 멈추게 한다 — 이때 삭제는 이미
    // ①세트 행 · ③질문 행을 잡고 있다.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = side.begin(async (tx) => {
      await tx`select id from prompt_sets where id = ${def} for update`;
      locked();
      await released;
    });
    await lockedP;

    const delP = deleteSet(setId);
    await waitForLockWaiters(1);

    // 다시 켜기(PATCH active=true) — 삭제가 잡은 질문 행에서 기다려야 한다
    const patchP = promptRoute.PATCH(json("PATCH", `http://localhost/api/prompts/${off.id}`, { active: true }), {
      params: Promise.resolve({ id: off.id }),
    });
    await waitForLockWaiters(2);

    release();
    await holder;
    const [delRes, patchRes] = await Promise.all([delP, patchP]);
    expect(delRes.status).toBe(200);
    expect(patchRes.status).toBe(200);
    const row = await promptRow(off.id);
    expect(row.active).toBe(true);
    expect(row.setId).toBe(def);
  });

  it("I7 · 같은 문장 다시 추가 — 다른 세트에 켜짐이면 세트 유지 + alreadyInSet · 꺼짐이면 다시 켜고 요청 세트로", async () => {
    const ws = await makeWorkspace("readd");
    const { body } = await createSet(ws.id, "새 세트");
    const newSet = body.set.id as string;
    const def = (await (async () => {
      const r = await addPrompt(ws.id, { text: "가짜 기존 질문" });
      expect(r.status).toBe(201);
      return (await r.json()).prompt.setId as string;
    })());
    expect(def).toBe(await defaultSetId(ws.id));

    const r1 = await addPrompt(ws.id, { text: "가짜 기존 질문", setId: newSet });
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    expect(b1.prompt.setId).toBe(def);
    expect(b1.alreadyInSet).toEqual({ id: def, name: "기존 세트" });

    // 끄고 다시 추가 → 요청 세트로 옮겨지며 켜진다
    await dbm.db.update(dbm.schema.prompts).set({ active: false }).where(eq(dbm.schema.prompts.id, b1.prompt.id));
    const r2 = await addPrompt(ws.id, { text: "가짜 기존 질문", setId: newSet });
    const b2 = await r2.json();
    expect(b2.prompt.active).toBe(true);
    expect(b2.prompt.setId).toBe(newSet);
    expect(b2.alreadyInSet).toBeUndefined();

    // 같은 세트에 켜진 문장 다시 추가 → 안내 없음
    const r3 = await addPrompt(ws.id, { text: "가짜 기존 질문", setId: newSet });
    expect((await r3.json()).alreadyInSet).toBeUndefined();
  });

  it("I7 · 확인 뒤 넣기 전에 세트가 지워지면 409 set_gone(SQL 원문 없음)", async () => {
    const ws = await makeWorkspace("gone");
    const { body } = await createSet(ws.id, "곧 지울 세트");
    const setId = body.set.id as string;

    // 다른 연결이 세트를 지우고 아직 커밋하지 않은 상태 — 추가 요청은 세트를 보고(커밋 전이라 보인다)
    // 넣다가 외래 키 검사에서 기다린다. 커밋하면 검사가 실패한다.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = side.begin(async (tx) => {
      await tx`delete from prompt_sets where id = ${setId}`;
      locked();
      await released;
    });
    await lockedP;

    const addP = addPrompt(ws.id, { text: "가짜 지워진 세트 질문", setId });
    await waitForLockWaiters(1);
    release();
    await holder;
    const res = await addP;
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b.error).toBe("set_gone");
    expect(JSON.stringify(b)).not.toMatch(/Failed query|prompts_set_id/);

    // 지워진 세트로 처음부터 넣으면 확인 단계에서 400 invalid_set
    const res2 = await addPrompt(ws.id, { text: "가짜 지워진 세트 질문", setId });
    expect(res2.status).toBe(400);
  });

  it("P4 · 49개인 워크스페이스에 동시에 5개를 만들면 하나만 생기고 50개에서 멈춘다", async () => {
    const ws = await makeWorkspace("limit");
    await createSet(ws.id, "세트 0"); // 기존 세트 + 1 = 2
    await dbm.db
      .insert(dbm.schema.promptSets)
      .values(Array.from({ length: 47 }, (_, i) => ({ workspaceId: ws.id, name: `채움 ${i}` })));
    expect((await listSets(ws.id)).sets).toHaveLength(49);

    // 다른 연결이 워크스페이스 행을 쥐어, 각 요청이 「개수 확인」 뒤 삽입(외래 키 검사)에서 멈추게 한다 —
    // 잠금이 없으면 5개 모두 49개를 본 채 멈췄다가 함께 들어가 54개가 된다. 5개가 모두 기다리는지 확인한 뒤 푼다.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = side.begin(async (tx) => {
      await tx`select id from workspaces where id = ${ws.id} for update`;
      locked();
      await released;
    });
    await lockedP;
    const pending = Array.from({ length: 5 }, (_, i) => createSet(ws.id, `동시 ${i}`));
    await waitForLockWaiters(5);
    release();
    await holder;
    const results = await Promise.all(pending);
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses).toEqual([201, 400, 400, 400, 400]);
    expect(results.filter((r) => r.res.status === 400).every((r) => r.body.error === "too_many_sets")).toBe(true);
    expect((await listSets(ws.id)).sets).toHaveLength(50);
  });

  it("P4-잔여 · 같은 워크스페이스를 대문자·소문자로 섞어 동시에 보내도 50개에서 멈춘다", async () => {
    const ws = await makeWorkspace("limit-case");
    await createSet(ws.id, "세트 0");
    await dbm.db
      .insert(dbm.schema.promptSets)
      .values(Array.from({ length: 47 }, (_, i) => ({ workspaceId: ws.id, name: `채움 ${i}` })));
    expect(ws.id).toMatch(/[a-f]/); // 대소문자가 갈리는 번호여야 이 시험이 뜻이 있다
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = side.begin(async (tx) => {
      await tx`select id from workspaces where id = ${ws.id} for update`;
      locked();
      await released;
    });
    await lockedP;
    const pending = [0, 1, 2, 3].map((i) => createSet(i % 2 === 0 ? ws.id : ws.id.toUpperCase(), `섞어 ${i}`));
    await waitForLockWaiters(4);
    release();
    await holder;
    const results = await Promise.all(pending);
    expect(results.map((r) => r.res.status).sort()).toEqual([201, 400, 400, 400]);
    expect((await listSets(ws.id)).sets).toHaveLength(50);
  });

  it("기본 세트가 없는 워크스페이스(옛 코드가 만든 것) — 질문 추가가 「기존 세트」를 만들고, 이름이 겹치면 「기존 세트 2」", async () => {
    const ws = await makeWorkspace("nodefault");
    // 기본이 아닌 「기존 세트」가 이미 있는 드문 상태를 직접 만든다
    await dbm.db.insert(dbm.schema.promptSets).values({ workspaceId: ws.id, name: "기존 세트", isDefault: false });
    const r = await addPrompt(ws.id, { text: "가짜 질문" });
    expect(r.status).toBe(201);
    const { sets } = await listSets(ws.id);
    const def = sets.find((s) => s.isDefault)!;
    expect(def.name).toBe("기존 세트 2");
    expect((await r.json()).prompt.setId).toBe(def.id);
  });
});
