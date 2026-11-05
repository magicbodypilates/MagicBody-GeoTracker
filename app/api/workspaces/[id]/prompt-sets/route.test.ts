/**
 * route.test.ts — GET·POST /api/workspaces/:id/prompt-sets 경계 계약 (계획 prompt-sets-plan-v2 §9-1).
 * 형식 틀린 번호 → DB 전 400 · 권한 거부 그대로 · 이름 검증 · 같은 이름 409 · 50개 상한 · 오류 본문에 SQL 원문 없음.
 * 실제 쿼리는 lib/server/prompt-sets.int.test.ts(로컬 DB)가 본다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const WS = "11111111-1111-4111-8111-111111111111";

const H = vi.hoisted(() => {
  const state = {
    setCount: 1,
    insertFail: null as Error | null,
    listFail: null as Error | null,
    dbTouched: 0,
    lockCalls: 0,
  };
  const tx = {
    execute: (_q: unknown) => {
      state.lockCalls += 1;
      return Promise.resolve([]);
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ n: state.setCount }]) }) }),
    insert: () => ({
      values: (v: { name: string }) => ({
        returning: () =>
          state.insertFail
            ? Promise.reject(state.insertFail)
            : Promise.resolve([{ id: "33333333-3333-4333-8333-333333333333", name: v.name, isDefault: false }]),
      }),
    }),
  };
  const db = {
    select: () => {
      state.dbTouched += 1;
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              groupBy: () => ({
                orderBy: () =>
                  state.listFail
                    ? Promise.reject(state.listFail)
                    : Promise.resolve([{ id: "a", name: "기존 세트", isDefault: true, createdAt: new Date(0), activePromptCount: "3" }]),
              }),
            }),
          }),
        }),
      };
    },
    transaction: <T,>(fn: (t: unknown) => Promise<T>) => {
      state.dbTouched += 1;
      return fn(tx);
    },
  };
  return { state, db, guard: vi.fn(async (): Promise<unknown> => null), ensure: vi.fn(async () => ({ id: "a" })) };
});

vi.mock("@/lib/server/db", () => ({
  db: H.db,
  schema: {
    promptSets: { id: {}, name: {}, isDefault: {}, createdAt: {}, workspaceId: {} },
    prompts: { id: {}, active: {}, setId: {} },
  },
}));
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "user", role: 1, uid: "u" }),
  assertWorkspaceAccess: () => H.guard(),
}));
vi.mock("@/lib/server/prompt-sets", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ensureDefaultSet: H.ensure, SET_ORDER: {} };
});

const { GET, POST } = await import("./route");

const post = (id: string, body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/workspaces/${id}/prompt-sets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
const get = (id: string) =>
  GET(new NextRequest(`http://localhost/api/workspaces/${id}/prompt-sets`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  H.state.setCount = 1;
  H.state.insertFail = null;
  H.state.listFail = null;
  H.state.dbTouched = 0;
  H.state.lockCalls = 0;
  H.guard.mockReset();
  H.guard.mockResolvedValue(null);
  H.ensure.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/workspaces/:id/prompt-sets", () => {
  it("형식 틀린 번호 → DB 를 타기 전에 400", async () => {
    expect((await get("x")).status).toBe(400);
    expect(H.state.dbTouched).toBe(0);
    expect(H.guard).not.toHaveBeenCalled();
  });

  it("권한 없음 → 권한 확인 응답 그대로, 조회 안 함", async () => {
    H.guard.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await get(WS)).status).toBe(403);
    expect(H.state.dbTouched).toBe(0);
  });

  it("목록 — 켜진 질문 수를 숫자로 돌려준다", async () => {
    const res = await get(WS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sets[0]).toMatchObject({ name: "기존 세트", isDefault: true, activePromptCount: 3 });
  });

  it("DB 오류 → 500 고정 코드만", async () => {
    H.state.listFail = new Error('Failed query: select "id" from "prompt_sets"');
    const res = await get(WS);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "prompt_sets_list_failed" });
  });
});

describe("POST /api/workspaces/:id/prompt-sets", () => {
  it("기본 세트를 먼저 보장하고 만든다 → 201", async () => {
    const res = await post(WS, { name: " 새 세트 " });
    expect(res.status).toBe(201);
    expect((await res.json()).set).toMatchObject({ name: "새 세트", activePromptCount: 0 });
    expect(H.ensure).toHaveBeenCalledTimes(1);
    // 개수 확인 전에 워크스페이스 잠금을 잡는다(P4)
    expect(H.state.lockCalls).toBe(1);
  });

  it("빈 이름·41자 → 400", async () => {
    expect((await post(WS, { name: "  " })).status).toBe(400);
    expect((await post(WS, { name: "가".repeat(41) })).status).toBe(400);
  });

  it("50개 상한 → 400 too_many_sets", async () => {
    H.state.setCount = 50;
    const res = await post(WS, { name: "하나 더" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too_many_sets");
  });

  it("같은 이름 → 409 set_name_taken, SQL 원문 없음", async () => {
    H.state.insertFail = Object.assign(new Error('Failed query: insert into "prompt_sets"'), {
      cause: { code: "23505", constraint_name: "uq_prompt_sets_workspace_name" },
    });
    const res = await post(WS, { name: "겹침" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("set_name_taken");
    expect(JSON.stringify(body)).not.toMatch(/Failed query|uq_prompt_sets/);
  });

  it("권한 없음 → 권한 확인 응답 그대로, 쓰기 없음", async () => {
    H.guard.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await post(WS, { name: "x" })).status).toBe(403);
    expect(H.state.dbTouched).toBe(0);
  });
});
