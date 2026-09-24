/**
 * route.test.ts — GET/DELETE /api/runs/:id 가드 순서 (계획 geotracker-response-archive-260924 §S5 · §6-1).
 *
 * 예전 결함: 이 라우트는 로그인 여부(미들웨어)만 보고 워크스페이스 권한·삭제 권한을 전혀 보지 않아,
 * 일반관리자가 id 만 알면 어떤 응답이든 조회·영구 삭제할 수 있었다(응답 영구 삭제 정책의 우회 경로).
 *
 * DB 는 in-memory fake, drizzle eq 는 술어 서술자, auth-guard 는 getSession·assertWorkspaceAccess 를
 * 스파이로 바꾸고 requireAdmin 은 실제 함수를 쓴다(중립 안내 문구까지 확인).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type RunRow = { id: string; workspaceId: string; promptText: string };

const H = vi.hoisted(() => {
  const store: { runs: RunRow[] } = { runs: [] };
  const calls = { select: 0, delete: 0 };
  type Pred = { op: "eq"; col: { name: string }; val: unknown };
  const match = (row: Record<string, unknown>, p?: Pred) => !p || row[p.col.name] === p.val;
  const col = (name: string) => ({ __col: true as const, name });
  const schema = { runs: { __table: "runs", id: col("id"), workspaceId: col("workspaceId"), promptText: col("promptText") } };
  const db = {
    select: () => {
      calls.select += 1;
      let pred: Pred | undefined;
      const api = {
        from: () => api,
        where: (p: Pred) => {
          pred = p;
          return api;
        },
        limit: (n: number) => Promise.resolve(store.runs.filter((r) => match(r, pred)).slice(0, n).map((r) => ({ ...r }))),
      };
      return api;
    },
    delete: () => {
      calls.delete += 1;
      let pred: Pred | undefined;
      const api = {
        where: (p: Pred) => {
          pred = p;
          return api;
        },
        returning: () => {
          const removed = store.runs.filter((r) => match(r, pred));
          store.runs = store.runs.filter((r) => !match(r, pred));
          return Promise.resolve(removed.map((r) => ({ id: r.id })));
        },
      };
      return api;
    },
  };
  return {
    store,
    calls,
    schema,
    db,
    reset: () => {
      store.runs = [];
      calls.select = 0;
      calls.delete = 0;
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: (col: { name: string }, val: unknown) => ({ op: "eq" as const, col, val }) };
});

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: () => getSessionMock(),
    assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
  };
});

const { GET, DELETE } = await import("./route");

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = { kind: "user", role: 1, uid: "u1" };
const ADMIN = { kind: "admin", role: 0 };

const get = (id: string) => GET(new NextRequest(`http://localhost/api/runs/${id}`), { params: Promise.resolve({ id }) });
const del = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/runs/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  H.reset();
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/runs/:id — 로그인 → 조회 → 워크스페이스 권한(거부 시 404)", () => {
  it("세션 없음 → 401, DB 조회 없음", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await get(uid(1));
    expect(res.status).toBe(401);
    expect(H.calls.select).toBe(0);
  });

  it("다른 워크스페이스 행 → 404 (존재를 알리지 않는다)", async () => {
    H.store.runs.push({ id: uid(2), workspaceId: WS_B, promptText: "가짜 질문" });
    getSessionMock.mockResolvedValue(USER);
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await get(uid(2));
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_B, USER);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("없는 행 → 404, 권한 확인은 부르지 않는다", async () => {
    getSessionMock.mockResolvedValue(USER);
    const res = await get(uid(3));
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한이 있으면 200 으로 행을 준다", async () => {
    H.store.runs.push({ id: uid(4), workspaceId: WS_A, promptText: "가짜 질문" });
    getSessionMock.mockResolvedValue(USER);
    assertWorkspaceAccessMock.mockResolvedValue(null);
    const res = await get(uid(4));
    expect(res.status).toBe(200);
    expect((await res.json()).run.id).toBe(uid(4));
  });

  it("UUID 형식이 아닌 id → 400, 세션·DB 모두 안 본다", async () => {
    const res = await get("not-a-uuid");
    expect(res.status).toBe(400);
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(H.calls.select).toBe(0);
  });

  it("DB 오류 → 500 고정 코드, 본문에 SQL 원문 없음", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    const original = H.db.select;
    H.db.select = (() => ({
      from: () => ({ where: () => ({ limit: () => Promise.reject(new Error('Failed query: select * from "runs"')) }) }),
    })) as unknown as typeof H.db.select;
    try {
      const res = await get(uid(5));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "run_get_failed" });
    } finally {
      H.db.select = original;
    }
  });
});

describe("DELETE /api/runs/:id — 삭제 권한을 DB 접근 전에", () => {
  it("세션 없음 → 401, DB 미호출", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await del(uid(6));
    expect(res.status).toBe(401);
    expect(H.calls.delete + H.calls.select).toBe(0);
  });

  it("kind=user → 403(중립 안내), DB 미호출, 행은 그대로", async () => {
    H.store.runs.push({ id: uid(7), workspaceId: WS_A, promptText: "가짜 질문" });
    getSessionMock.mockResolvedValue(USER);
    const res = await del(uid(7));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", hint: "이 작업을 할 권한이 없습니다" });
    expect(H.calls.delete + H.calls.select).toBe(0);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(H.store.runs).toHaveLength(1);
  });

  it("kind=admin → 삭제", async () => {
    H.store.runs.push({ id: uid(8), workspaceId: WS_B, promptText: "가짜 질문" });
    getSessionMock.mockResolvedValue(ADMIN);
    const res = await del(uid(8));
    expect(res.status).toBe(200);
    expect(H.store.runs).toHaveLength(0);
  });

  it("kind=admin · 없는 행 → 404", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    const res = await del(uid(9));
    expect(res.status).toBe(404);
  });

  it("DB 오류 → 500 고정 코드", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    const original = H.db.delete;
    H.db.delete = (() => ({
      where: () => ({ returning: () => Promise.reject(new Error('Failed query: delete from "runs"')) }),
    })) as unknown as typeof H.db.delete;
    try {
      const res = await del(uid(10));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "run_delete_failed" });
    } finally {
      H.db.delete = original;
    }
  });
});
