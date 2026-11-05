/**
 * route.test.ts — PATCH·DELETE /api/prompt-sets/:setId 경계 계약 (계획 prompt-sets-plan-v2 §9-1).
 * 형식 틀린 번호 → DB 전 400 · 권한 거부 그대로 · isDefault 는 받지 않음 · 오류 본문에 SQL 원문 없음.
 * 실제 잠금·삭제 순서는 lib/server/prompt-sets.int.test.ts(로컬 DB)가 본다. 여기선 db 를 가짜로 둔다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const SET = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";

const H = vi.hoisted(() => {
  const state = {
    setRow: null as null | { id: string; workspaceId: string; isDefault: boolean },
    updateResult: [] as unknown[],
    updateFail: null as Error | null,
    txFail: null as Error | null,
    selectCalls: 0,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            state.selectCalls += 1;
            return Promise.resolve(state.setRow ? [state.setRow] : []);
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => (state.updateFail ? Promise.reject(state.updateFail) : Promise.resolve(state.updateResult)),
        }),
      }),
    }),
    transaction: () => (state.txFail ? Promise.reject(state.txFail) : Promise.resolve({ movedInactive: 0 })),
  };
  return {
    state,
    db,
    guard: vi.fn(async (): Promise<unknown> => null),
  };
});

vi.mock("@/lib/server/db", () => ({
  db: H.db,
  schema: { promptSets: { id: {}, workspaceId: {}, isDefault: {} }, prompts: { id: {}, setId: {} } },
}));
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "user", role: 1, uid: "u" }),
  assertWorkspaceAccess: () => H.guard(),
}));

const { PATCH, DELETE } = await import("./route");

function patch(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/prompt-sets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ setId: id }) },
  );
}
function del(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/prompt-sets/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ setId: id }),
  });
}
const drizzleErr = (cause: Record<string, unknown>) =>
  Object.assign(new Error('Failed query: update "prompt_sets" set "name" = $1'), { cause });

beforeEach(() => {
  H.state.setRow = { id: SET, workspaceId: WS, isDefault: false };
  H.state.updateResult = [{ id: SET, name: "바꾼 이름" }];
  H.state.updateFail = null;
  H.state.txFail = null;
  H.state.selectCalls = 0;
  H.guard.mockReset();
  H.guard.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("PATCH /api/prompt-sets/:setId", () => {
  it("형식 틀린 번호 → DB 를 타기 전에 400", async () => {
    const res = await patch("not-a-uuid", { name: "x" });
    expect(res.status).toBe(400);
    expect(H.state.selectCalls).toBe(0);
  });

  it("없는 세트 → 404", async () => {
    H.state.setRow = null;
    expect((await patch(SET, { name: "x" })).status).toBe(404);
  });

  it("다른 워크스페이스(권한 없음) → 권한 확인 응답을 그대로 돌려주고 고치지 않는다", async () => {
    H.guard.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await patch(SET, { name: "x" });
    expect(res.status).toBe(403);
  });

  it("isDefault 같은 다른 칸이 오면 400", async () => {
    const res = await patch(SET, { name: "x", isDefault: true });
    expect(res.status).toBe(400);
  });

  it("이름 바꾸기 성공 → 200", async () => {
    const res = await patch(SET, { name: " 바꾼 이름 " });
    expect(res.status).toBe(200);
    expect((await res.json()).set.name).toBe("바꾼 이름");
  });

  it("같은 이름 → 409 set_name_taken, SQL 원문 없음", async () => {
    H.state.updateFail = drizzleErr({ code: "23505", constraint_name: "uq_prompt_sets_workspace_name" });
    const res = await patch(SET, { name: "겹침" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("set_name_taken");
    expect(JSON.stringify(body)).not.toMatch(/Failed query|uq_prompt_sets/);
  });

  it("그 밖의 DB 오류 → 500 고정 코드만", async () => {
    H.state.updateFail = drizzleErr({ code: "42703" });
    const res = await patch(SET, { name: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "prompt_set_update_failed" });
  });
});

describe("DELETE /api/prompt-sets/:setId", () => {
  it("형식 틀린 번호 → DB 를 타기 전에 400", async () => {
    expect((await del("abc")).status).toBe(400);
    expect(H.state.selectCalls).toBe(0);
  });

  it("권한 없음 → 권한 확인 응답 그대로", async () => {
    H.guard.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await del(SET)).status).toBe(403);
  });

  it("삭제 중 외래 키 위반 → 409 set_not_empty(「방금 지워졌다」가 아니다)", async () => {
    H.state.txFail = drizzleErr({ code: "23503", constraint_name: "prompts_set_id_prompt_sets_id_fk" });
    const res = await del(SET);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("set_not_empty");
    expect(JSON.stringify(body)).not.toMatch(/Failed query|prompts_set_id/);
  });

  it("그 밖의 DB 오류 → 500 고정 코드만", async () => {
    H.state.txFail = drizzleErr({ code: "40001" });
    const res = await del(SET);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "prompt_set_delete_failed" });
  });
});
