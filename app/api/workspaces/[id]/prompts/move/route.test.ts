/**
 * route.test.ts — POST /api/workspaces/:id/prompts/move 경계 계약 (계획 prompt-sets-plan-v2 §9-1).
 * 형식 틀린 번호 → DB 전 400 · 권한 거부 그대로 · 다른 워크스페이스 세트 400 · 세트가 방금 지워짐 409 ·
 * 오류 본문에 SQL 원문 없음. 실제 이동·응답 보존은 lib/server/prompt-sets.int.test.ts(I5)가 본다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const WS = "11111111-1111-4111-8111-111111111111";
const SET = "22222222-2222-4222-8222-222222222222";
const P1 = "44444444-4444-4444-8444-444444444444";
const P2 = "55555555-5555-4555-8555-555555555555";

const H = vi.hoisted(() => {
  const state = {
    setFound: true,
    moved: [] as { id: string }[],
    updateFail: null as Error | null,
    dbTouched: 0,
  };
  const db = {
    select: () => {
      state.dbTouched += 1;
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(state.setFound ? [{ id: "s" }] : []) }) }) };
    },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => (state.updateFail ? Promise.reject(state.updateFail) : Promise.resolve(state.moved)),
        }),
      }),
    }),
  };
  return { state, db, guard: vi.fn(async (): Promise<unknown> => null) };
});

vi.mock("@/lib/server/db", () => ({
  db: H.db,
  schema: { promptSets: { id: {}, workspaceId: {} }, prompts: { id: {}, workspaceId: {}, setId: {} } },
}));
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "user", role: 1, uid: "u" }),
  assertWorkspaceAccess: () => H.guard(),
}));

const { POST } = await import("./route");

const move = (id: string, body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/workspaces/${id}/prompts/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  H.state.setFound = true;
  H.state.moved = [];
  H.state.updateFail = null;
  H.state.dbTouched = 0;
  H.guard.mockReset();
  H.guard.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/workspaces/:id/prompts/move", () => {
  it("형식 틀린 번호(경로·본문) → DB 를 타기 전에 400", async () => {
    expect((await move("x", { promptIds: [P1], setId: SET })).status).toBe(400);
    expect((await move(WS, { promptIds: ["x"], setId: SET })).status).toBe(400);
    expect((await move(WS, { promptIds: [P1], setId: "y" })).status).toBe(400);
    expect((await move(WS, { promptIds: [], setId: SET })).status).toBe(400);
    expect(H.state.dbTouched).toBe(0);
  });

  it("권한 없음 → 권한 확인 응답 그대로, 쓰기 없음", async () => {
    H.guard.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await move(WS, { promptIds: [P1], setId: SET })).status).toBe(403);
    expect(H.state.dbTouched).toBe(0);
  });

  it("이 워크스페이스 세트가 아니면 400 invalid_set", async () => {
    H.state.setFound = false;
    const res = await move(WS, { promptIds: [P1], setId: SET });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_set");
  });

  it("옮긴 수와 못 찾은 번호를 돌려준다(중복 번호는 한 번만)", async () => {
    H.state.moved = [{ id: P1 }];
    const res = await move(WS, { promptIds: [P1, P2, P1], setId: SET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 1, notFound: [P2] });
  });

  it("대문자 번호로 와도 옮겨진 질문은 notFound 에 넣지 않는다(P5)", async () => {
    // 글자(a～f)가 든 번호여야 대문자·소문자가 갈린다
    const PX = "abcdef01-2345-4678-9abc-def012345678";
    H.state.moved = [{ id: PX }]; // DB 는 소문자로 돌려준다
    const res = await move(WS, { promptIds: [PX.toUpperCase(), PX, P2], setId: "ABCDEF01-2345-4678-9ABC-DEF012345678" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 1, notFound: [P2] });
  });

  it("세트가 방금 지워졌다(외래 키 위반) → 409 set_gone, SQL 원문 없음", async () => {
    H.state.updateFail = Object.assign(new Error('Failed query: update "prompts" set "set_id"'), {
      cause: { code: "23503", constraint_name: "prompts_set_id_prompt_sets_id_fk" },
    });
    const res = await move(WS, { promptIds: [P1], setId: SET });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("set_gone");
    expect(JSON.stringify(body)).not.toMatch(/Failed query|prompts_set_id/);
  });

  it("그 밖의 DB 오류 → 500 고정 코드만", async () => {
    H.state.updateFail = new Error('Failed query: update "prompts"');
    const res = await move(WS, { promptIds: [P1], setId: SET });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "prompts_move_failed" });
  });
});
