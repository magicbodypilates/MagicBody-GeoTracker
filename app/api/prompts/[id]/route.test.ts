/**
 * route.test.ts — PATCH/DELETE /api/prompts/:id 워크스페이스 권한 게이트.
 *
 * 운영에서 확인된 결함: 이 라우트는 id 만으로 대상을 찾기 때문에, 로그인 여부(middleware)
 * 만 확인하고 워크스페이스 소유 여부는 전혀 보지 않았다 — 일반관리자가 자신의 프로덕션
 * 워크스페이스가 아닌 프롬프트도 id 만 알면 PATCH/DELETE 할 수 있었다. 이제는 대상의
 * workspaceId 를 먼저 조회해 assertWorkspaceAccess 를 적용한다(DELETE 의 cascade 는 그
 * 위에 admin 전용 제약을 추가로 얹는다).
 *
 * DB 는 in-memory fake 로 대체하고, auth-guard 는 getSession/assertWorkspaceAccess/
 * requireAdmin 을 스파이로 바꿔 라우트가 "무엇을 호출했는지 · 어떤 워크스페이스로
 * 호출했는지 · 그 반환값에 따라 실제로 분기했는지"를 확인한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type PromptRow = { id: string; workspaceId: string; text: string; tags: string[]; active: boolean };
type RunRow = { id: string; workspaceId: string; promptText: string };

const H = vi.hoisted(() => {
  const store: { prompts: PromptRow[]; runs: RunRow[] } = { prompts: [], runs: [] };

  type Pred =
    | { op: "eq"; col: { name: string }; val: unknown }
    | { op: "and"; preds: Pred[] };

  const match = (row: Record<string, unknown>, pred?: Pred): boolean => {
    if (!pred) return true;
    if (pred.op === "and") return pred.preds.every((p) => match(row, p));
    return row[pred.col.name] === pred.val;
  };

  const project = (row: Record<string, unknown>, proj?: Record<string, { name: string }>) => {
    if (!proj) return { ...row };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(proj)) out[k] = row[v.name];
    return out;
  };

  const col = (name: string) => ({ __col: true as const, name });
  const mkTable = (tableName: string, cols: string[]) => {
    const t: Record<string, unknown> = { __table: tableName };
    for (const c of cols) t[c] = col(c);
    return t;
  };

  const schema = {
    prompts: mkTable("prompts", ["id", "workspaceId", "text", "tags", "active"]),
    runs: mkTable("runs", ["id", "workspaceId", "promptText"]),
  };

  const tableOf = (t: { __table: string }) =>
    store[t.__table as "prompts" | "runs"] as unknown as Record<string, unknown>[];

  const selectBuilder = (proj?: Record<string, { name: string }>) => {
    let table: { __table: string } | null = null;
    let pred: Pred | undefined;
    const api = {
      from(t: { __table: string }) {
        table = t;
        return api;
      },
      where(p: Pred) {
        pred = p;
        return api;
      },
      limit(n: number) {
        const rows = tableOf(table!).filter((r) => match(r, pred));
        return Promise.resolve(rows.slice(0, n).map((r) => project(r, proj)));
      },
    };
    return api;
  };

  const updateBuilder = (t: { __table: string }) => {
    let vals: Record<string, unknown> = {};
    let pred: Pred | undefined;
    const api = {
      set(v: Record<string, unknown>) {
        vals = v;
        return api;
      },
      where(p: Pred) {
        pred = p;
        return api;
      },
      returning(proj?: Record<string, { name: string }>) {
        const rows = tableOf(t).filter((r) => match(r, pred));
        for (const r of rows) Object.assign(r, vals);
        return Promise.resolve(rows.map((r) => project(r, proj)));
      },
    };
    return api;
  };

  const deleteBuilder = (t: { __table: string }) => {
    let pred: Pred | undefined;
    const api = {
      where(p: Pred) {
        pred = p;
        return api;
      },
      returning(proj?: Record<string, { name: string }>) {
        const all = tableOf(t);
        const removed = all.filter((r) => match(r, pred));
        const keep = all.filter((r) => !match(r, pred));
        if (table_.__table === "prompts") store.prompts = keep as PromptRow[];
        else store.runs = keep as RunRow[];
        return Promise.resolve(removed.map((r) => project(r, proj)));
      },
    };
    const table_ = t;
    return api;
  };

  const db = {
    select: (proj?: Record<string, { name: string }>) => selectBuilder(proj),
    update: (t: { __table: string }) => updateBuilder(t),
    delete: (t: { __table: string }) => deleteBuilder(t),
  };

  return {
    store,
    db,
    schema,
    reset: () => {
      store.prompts = [];
      store.runs = [];
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: { name: string }, val: unknown) => ({ op: "eq" as const, col, val }),
    and: (...preds: unknown[]) => ({ op: "and" as const, preds }),
  };
});

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
const requireAdminMock = vi.fn();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
  requireAdmin: (session: unknown) => requireAdminMock(session),
}));

const { PATCH, DELETE } = await import("./route");

const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function seedPrompt(id: string, workspaceId: string, overrides: Partial<PromptRow> = {}): PromptRow {
  const row: PromptRow = { id, workspaceId, text: "문구", tags: [], active: true, ...overrides };
  H.store.prompts.push(row);
  return row;
}

function patchReq(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/prompts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteReq(id: string, qs = "") {
  return DELETE(new NextRequest(`http://localhost/api/prompts/${id}${qs}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  H.reset();
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset();
  requireAdminMock.mockReset();
});

describe("PATCH /api/prompts/:id — 워크스페이스 권한 확인", () => {
  it("존재하지 않는 프롬프트 → 404, 권한 체크는 아예 호출되지 않는다", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await patchReq("no-such-id", { active: false });
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 일반관리자가 다른 워크스페이스 프롬프트를 PATCH → 403, DB 는 바뀌지 않는다", async () => {
    seedPrompt("p1", WS_B, { active: true });
    const session = { kind: "user", role: 1, uid: "u1" };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await patchReq("p1", { active: false });

    expect(res.status).toBe(403);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_B, session);
    // 권한 게이트에서 막혔으므로 실제 수정이 일어나지 않았다.
    expect(H.store.prompts.find((p) => p.id === "p1")!.active).toBe(true);
  });

  it("접근 권한이 있으면 정상적으로 수정된다", async () => {
    seedPrompt("p2", WS_A, { active: true });
    const session = { kind: "admin", role: 0 };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq("p2", { active: false });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt.active).toBe(false);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_A, session);
  });
});

describe("DELETE /api/prompts/:id — 워크스페이스 권한 확인", () => {
  it("권한 없는 세션 거부 — 다른 워크스페이스 프롬프트 DELETE → 403, 삭제되지 않는다", async () => {
    seedPrompt("p3", WS_B);
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await deleteReq("p3");

    expect(res.status).toBe(403);
    expect(H.store.prompts).toHaveLength(1);
    // 워크스페이스 게이트에서 이미 막혔으므로 cascade/admin 체크까지 가지 않는다.
    expect(requireAdminMock).not.toHaveBeenCalled();
  });

  it("워크스페이스 접근은 되지만 cascade=true 이고 admin 이 아니면 403, 삭제되지 않는다", async () => {
    seedPrompt("p4", WS_A);
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(null);
    requireAdminMock.mockReturnValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));

    const res = await deleteReq("p4", "?cascade=true");

    expect(res.status).toBe(403);
    expect(H.store.prompts).toHaveLength(1);
  });

  it("접근 권한이 있으면 정상 삭제되고, cascade 시 같은 워크스페이스·같은 문구의 runs 만 함께 삭제된다", async () => {
    seedPrompt("p5", WS_A, { text: "지울 문구" });
    H.store.runs.push({ id: "r1", workspaceId: WS_A, promptText: "지울 문구" });
    H.store.runs.push({ id: "r2", workspaceId: WS_A, promptText: "다른 문구" });
    H.store.runs.push({ id: "r3", workspaceId: WS_B, promptText: "지울 문구" }); // 다른 워크스페이스 — 영향 없어야 함
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);
    requireAdminMock.mockReturnValue(null);

    const res = await deleteReq("p5", "?cascade=true");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runsDeleted).toBe(1);
    expect(H.store.prompts).toHaveLength(0);
    expect(H.store.runs.map((r) => r.id).sort()).toEqual(["r2", "r3"]);
  });

  it("cascade 없이 삭제하면 runs 는 그대로 남는다", async () => {
    seedPrompt("p6", WS_A, { text: "지울 문구2" });
    H.store.runs.push({ id: "r4", workspaceId: WS_A, promptText: "지울 문구2" });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await deleteReq("p6");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runsDeleted).toBe(0);
    expect(H.store.runs).toHaveLength(1);
    expect(requireAdminMock).not.toHaveBeenCalled(); // cascade 아니므로 admin 체크 자체를 안 함
  });
});
