/**
 * route.test.ts — PATCH/DELETE /api/drift/:id 워크스페이스 권한 게이트(A12).
 *
 * 보관 설계 대장에서 이관된 결함: 이 라우트는 id 만으로 대상을 찾기 때문에 getSession·
 * assertWorkspaceAccess 호출이 전혀 없었다 — 로그인 여부(middleware)만 확인하고 워크스페이스
 * 소유 여부는 보지 않아, 권한 없는 일반관리자가 자신의 것이 아닌 워크스페이스의 알림도
 * 숨기거나(dismiss) 완전 삭제할 수 있었다. prompts/[id]·schedules/[id] 와 동일한 패턴
 * (대상 조회 → assertWorkspaceAccess) 을 적용한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type DriftAlertRow = { id: string; workspaceId: string; dismissed: boolean };

const H = vi.hoisted(() => {
  const store: { driftAlerts: DriftAlertRow[] } = { driftAlerts: [] };

  type Pred = { op: "eq"; col: { name: string }; val: unknown };

  const match = (row: Record<string, unknown>, pred?: Pred): boolean => {
    if (!pred) return true;
    return row[pred.col.name] === pred.val;
  };

  const project = (row: Record<string, unknown>, proj?: Record<string, { name: string }>) => {
    if (!proj) return { ...row };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(proj)) out[k] = row[v.name];
    return out;
  };

  const col = (name: string) => ({ __col: true as const, name });
  const schema = {
    driftAlerts: {
      __table: "driftAlerts",
      id: col("id"),
      workspaceId: col("workspaceId"),
      dismissed: col("dismissed"),
    },
  };

  const selectBuilder = (proj?: Record<string, { name: string }>) => {
    let pred: Pred | undefined;
    const api = {
      from() {
        return api;
      },
      where(p: Pred) {
        pred = p;
        return api;
      },
      limit(n: number) {
        const rows = store.driftAlerts.filter((r) => match(r, pred));
        return Promise.resolve(rows.slice(0, n).map((r) => project(r, proj)));
      },
    };
    return api;
  };

  const updateBuilder = () => {
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
        const rows = store.driftAlerts.filter((r) => match(r, pred));
        for (const r of rows) Object.assign(r, vals);
        return Promise.resolve(rows.map((r) => project(r, proj)));
      },
    };
    return api;
  };

  const deleteBuilder = () => {
    let pred: Pred | undefined;
    const api = {
      where(p: Pred) {
        pred = p;
        return api;
      },
      returning(proj?: Record<string, { name: string }>) {
        const removed = store.driftAlerts.filter((r) => match(r, pred));
        store.driftAlerts = store.driftAlerts.filter((r) => !match(r, pred));
        return Promise.resolve(removed.map((r) => project(r, proj)));
      },
    };
    return api;
  };

  const db = {
    select: (proj?: Record<string, { name: string }>) => selectBuilder(proj),
    update: () => updateBuilder(),
    delete: () => deleteBuilder(),
  };

  return {
    store,
    db,
    schema,
    reset: () => {
      store.driftAlerts = [];
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: { name: string }, val: unknown) => ({ op: "eq" as const, col, val }),
  };
});

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
}));

const { PATCH, DELETE } = await import("./route");

const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function seedAlert(overrides: Partial<DriftAlertRow> = {}): DriftAlertRow {
  const row: DriftAlertRow = { id: "alert-1", workspaceId: WS_A, dismissed: false, ...overrides };
  H.store.driftAlerts.push(row);
  return row;
}

function patchReq(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/drift/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteReq(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/drift/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  H.reset();
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset();
});

describe("PATCH /api/drift/:id — 워크스페이스 권한 확인", () => {
  it("존재하지 않는 알림 → 404, 권한 체크는 호출되지 않는다", async () => {
    const res = await patchReq("no-such-id", { dismissed: true });
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 다른 워크스페이스 알림 PATCH → 403, DB 는 바뀌지 않는다", async () => {
    seedAlert({ id: "alert-2", workspaceId: WS_B, dismissed: false });
    const session = { kind: "user", role: 1, uid: "u1" };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await patchReq("alert-2", { dismissed: true });

    expect(res.status).toBe(403);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_B, session);
    expect(H.store.driftAlerts.find((a) => a.id === "alert-2")!.dismissed).toBe(false);
  });

  it("접근 권한이 있으면 정상적으로 dismiss 처리된다", async () => {
    seedAlert({ id: "alert-3", workspaceId: WS_A, dismissed: false });
    const session = { kind: "admin", role: 0 };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq("alert-3", { dismissed: true });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.dismissed).toBe(true);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_A, session);
  });
});

describe("DELETE /api/drift/:id — 워크스페이스 권한 확인", () => {
  it("존재하지 않는 알림 → 404, 권한 체크는 호출되지 않는다", async () => {
    const res = await deleteReq("no-such-id");
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 다른 워크스페이스 알림 DELETE → 403, 삭제되지 않는다", async () => {
    seedAlert({ id: "alert-4", workspaceId: WS_B });
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await deleteReq("alert-4");

    expect(res.status).toBe(403);
    expect(H.store.driftAlerts).toHaveLength(1);
  });

  it("접근 권한이 있으면 정상 삭제된다", async () => {
    seedAlert({ id: "alert-5", workspaceId: WS_A });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await deleteReq("alert-5");

    expect(res.status).toBe(200);
    expect(H.store.driftAlerts).toHaveLength(0);
  });
});
