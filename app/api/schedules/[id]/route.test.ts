/**
 * route.test.ts — PATCH /api/schedules/:id 권한 게이트 + 부가 동작 계약.
 *
 * 이 라우트도 prompts/[id] 와 같은 이유로 워크스페이스 권한 확인이 없었다(로그인 여부만
 * 확인). 여기서는 그 게이트 추가에 더해, 스케줄 편집 기능(D)이 기대는 두 가지 부가 동작을
 * 함께 계약으로 고정한다 — ① promptIds 저장 시 그 워크스페이스에 실제로 없는(삭제된) ID
 * 는 걸러낸다 ② cronExpression 이 바뀌고 호출측이 nextRunAt 을 직접 주지 않았으면 새
 * 주기 기준으로 다음 실행 시각을 다시 계산한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type ScheduleRow = {
  id: string;
  workspaceId: string;
  name: string;
  cronExpression: string;
  providers: string[];
  promptIds: string[];
  active: boolean;
  nextRunAt: Date | null;
};
type PromptRow = { id: string; workspaceId: string };

const H = vi.hoisted(() => {
  const store: { schedules: ScheduleRow[]; prompts: PromptRow[] } = { schedules: [], prompts: [] };

  type Pred =
    | { op: "eq"; col: { name: string }; val: unknown }
    | { op: "and"; preds: Pred[] }
    | { op: "inArray"; col: { name: string }; vals: unknown[] };

  const match = (row: Record<string, unknown>, pred?: Pred): boolean => {
    if (!pred) return true;
    if (pred.op === "and") return pred.preds.every((p) => match(row, p));
    if (pred.op === "inArray") return (pred.vals as unknown[]).includes(row[pred.col.name]);
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
    schedules: mkTable("schedules", [
      "id",
      "workspaceId",
      "name",
      "cronExpression",
      "providers",
      "promptIds",
      "active",
      "nextRunAt",
    ]),
    prompts: mkTable("prompts", ["id", "workspaceId"]),
  };

  const tableOf = (t: { __table: string }) =>
    store[t.__table as "schedules" | "prompts"] as unknown as Record<string, unknown>[];

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
        // limit() 이 없는 select(promptIds 존재 검증)는 그대로 배열 프라미스로 resolve 되게
        // then 을 얹는다 — 실제 drizzle 도 limit 없이 await 가능.
        return {
          ...api,
          then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
            try {
              res(tableOf(table!).filter((r) => match(r, pred)).map((r) => project(r, proj)));
            } catch (e) {
              if (rej) rej(e);
            }
          },
        };
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
        if (t.__table === "schedules") store.schedules = keep as ScheduleRow[];
        else store.prompts = keep as PromptRow[];
        return Promise.resolve(removed.map((r) => project(r, proj)));
      },
    };
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
      store.schedules = [];
      store.prompts = [];
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
    inArray: (col: { name: string }, vals: unknown[]) => ({ op: "inArray" as const, col, vals }),
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
/**
 * promptIds 는 zod `.uuid()` 검증을 받는다 — zod v4 는 버전(4)·변형(8~b) 니블까지
 * 확인하므로(실측: 전부 0인 문자열은 "Invalid UUID"로 거부) 버전 4 형태를 고정해 쓴다.
 * 이제 경로 id(스케줄 자체의 id, S1 수정)도 같은 검증을 받으므로 "sch-1" 같은 옛 임의
 * 문자열은 더는 이 라우트를 통과하지 못한다 — 별도 네임스페이스(sid)로 구분해 쓴다.
 */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seedSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  const row: ScheduleRow = {
    id: sid(1),
    workspaceId: WS_A,
    name: "기본 자동 조사",
    cronExpression: "0 0,12 * * *",
    providers: ["chatgpt"],
    promptIds: [],
    active: true,
    nextRunAt: null,
    ...overrides,
  };
  H.store.schedules.push(row);
  return row;
}

function patchReq(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteReq(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/schedules/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  H.reset();
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset();
});

describe("PATCH /api/schedules/:id — 워크스페이스 권한 확인", () => {
  it("존재하지 않는 스케줄 → 404, 권한 체크는 호출되지 않는다", async () => {
    const res = await patchReq(sid(99), { name: "x" });
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 다른 워크스페이스 스케줄 PATCH → 403, DB 는 바뀌지 않는다", async () => {
    seedSchedule({ id: sid(2), workspaceId: WS_B, name: "원래 이름" });
    const session = { kind: "user", role: 1, uid: "u1" };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await patchReq(sid(2), { name: "바뀐 이름" });

    expect(res.status).toBe(403);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_B, session);
    expect(H.store.schedules.find((s) => s.id === sid(2))!.name).toBe("원래 이름");
  });

  it("UUID 형식이 아닌 id → 400, DB 조회 없음", async () => {
    const original = H.db.select;
    H.db.select = (() => {
      throw new Error("DB select must not be called for a malformed id");
    }) as unknown as typeof H.db.select;
    try {
      const res = await patchReq("not-a-uuid", { name: "x" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_id");
      expect(getSessionMock).not.toHaveBeenCalled();
    } finally {
      H.db.select = original;
    }
  });

  it("DB 오류 시 응답 본문에 SQL 원문이 없고 고정 오류 코드를 반환한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = H.db.select;
    H.db.select = (() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.reject(
              new Error(
                `Failed query: select "id", "workspace_id", "cron_expression" from "schedules" where "id" = $1 -- params: ["${sid(60)}"]`,
              ),
            ),
        }),
      }),
    })) as unknown as typeof H.db.select;
    try {
      const res = await patchReq(sid(60), { name: "x" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/Failed query|select .* from|params:/i);
      expect(body.error).toBe("schedule_update_failed");
    } finally {
      H.db.select = original;
    }
  });
});

describe("DELETE /api/schedules/:id — 워크스페이스 권한 확인 · 잘못된 id 형식 · DB 오류 응답", () => {
  it("존재하지 않는 스케줄 → 404, 권한 체크는 호출되지 않는다", async () => {
    const res = await deleteReq(sid(98));
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 다른 워크스페이스 스케줄 DELETE → 403, 삭제되지 않는다", async () => {
    seedSchedule({ id: sid(13), workspaceId: WS_B });
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await deleteReq(sid(13));

    expect(res.status).toBe(403);
    expect(H.store.schedules).toHaveLength(1);
  });

  it("접근 권한이 있으면 정상 삭제된다", async () => {
    seedSchedule({ id: sid(14) });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await deleteReq(sid(14));

    expect(res.status).toBe(200);
    expect(H.store.schedules).toHaveLength(0);
  });

  it("UUID 형식이 아닌 id → 400, DB 조회 없음", async () => {
    const original = H.db.select;
    H.db.select = (() => {
      throw new Error("DB select must not be called for a malformed id");
    }) as unknown as typeof H.db.select;
    try {
      const res = await deleteReq("not-a-uuid");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_id");
      expect(getSessionMock).not.toHaveBeenCalled();
    } finally {
      H.db.select = original;
    }
  });

  it("DB 오류 시 응답 본문에 SQL 원문이 없고 고정 오류 코드를 반환한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = H.db.select;
    H.db.select = (() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.reject(
              new Error(
                `Failed query: select "id", "workspace_id" from "schedules" where "id" = $1 -- params: ["${sid(61)}"]`,
              ),
            ),
        }),
      }),
    })) as unknown as typeof H.db.select;
    try {
      const res = await deleteReq(sid(61));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/Failed query|select .* from|params:/i);
      expect(body.error).toBe("schedule_delete_failed");
    } finally {
      H.db.select = original;
    }
  });
});

describe("PATCH /api/schedules/:id — promptIds 정리(D)", () => {
  it("존재하지 않는(삭제된) 프롬프트 ID 는 저장에서 걸러진다", async () => {
    seedSchedule({ id: sid(3), promptIds: [] });
    H.store.prompts.push({ id: uid(1), workspaceId: WS_A });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(3), {
      promptIds: [uid(1), uid(2)], // uid(2) 는 어느 테이블에도 없다 = 삭제된 프롬프트
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([uid(1)]);
  });

  it("다른 워크스페이스 소유의 프롬프트 ID 도 걸러진다", async () => {
    seedSchedule({ id: sid(4), promptIds: [] });
    H.store.prompts.push({ id: uid(3), workspaceId: WS_A });
    H.store.prompts.push({ id: uid(4), workspaceId: WS_B });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(4), { promptIds: [uid(3), uid(4)] });

    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([uid(3)]);
  });

  it("빈 배열은 그대로 저장된다(활성 전체 실행 의미 유지)", async () => {
    seedSchedule({ id: sid(5), promptIds: [uid(5)] });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(5), { promptIds: [] });

    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([]);
  });

  it("비어 있지 않은 선택인데 전부 무효(삭제됨/다른 워크스페이스)면 400 으로 거부하고 저장하지 않는다", async () => {
    // 재현 대상 결함: 필터링 결과가 빈 배열이 되면 조용히 "활성 프롬프트 전체 실행"으로
    // 저장돼 버려서, 사용자가 "이 질문들만" 실행하려던 의도가 예고 없이 확장됐다.
    seedSchedule({ id: sid(12), promptIds: [uid(7)] });
    H.store.prompts.push({ id: uid(8), workspaceId: WS_B }); // 다른 워크스페이스 소속 — 무효 취급
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(12), {
      promptIds: [uid(9), uid(8)], // uid(9) 는 어디에도 없고, uid(8) 은 다른 워크스페이스 소속
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("no_valid_prompts_selected");
    expect(typeof body.hint).toBe("string");
    // 거부됐으므로 기존 promptIds 는 그대로 남아있어야 한다(조용한 "전체 실행" 확장 금지).
    expect(H.store.schedules.find((s) => s.id === sid(12))!.promptIds).toEqual([uid(7)]);
  });

  it("promptIds 를 아예 보내지 않으면 기존 값을 건드리지 않는다", async () => {
    seedSchedule({ id: sid(6), promptIds: [uid(6)] });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(6), { name: "이름만 변경" });

    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([uid(6)]);
    expect(body.schedule.name).toBe("이름만 변경");
  });
});

describe("PATCH /api/schedules/:id — 주기 변경 시 다음 실행 시각 재계산(D)", () => {
  it("cronExpression 이 바뀌면 nextRunAt 을 새 주기 기준으로 다시 계산한다", async () => {
    seedSchedule({ id: sid(7), cronExpression: "0 0,12 * * *", nextRunAt: new Date("2020-01-01T00:00:00Z") });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(7), { cronExpression: "0 * * * *" }); // 1시간마다

    expect(res.status).toBe(200);
    const body = await res.json();
    const newNextRun = new Date(body.schedule.nextRunAt);
    // 새로 계산된 nextRunAt 은 "지금"으로부터 최대 1시간 이내여야 한다(옛 값 2020 년 그대로면 실패).
    expect(newNextRun.getTime()).toBeGreaterThan(Date.now());
    expect(newNextRun.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5000);
  });

  it("실제 화면 편집 패널처럼 매번 cronExpression 을 함께 보내도, 값이 그대로면 재계산하지 않는다", async () => {
    // 회귀 재현: 편집 UI 는 이름/프로바이더만 바뀌어도 cronExpression 을 폼 값 그대로
    // 항상 함께 보낸다. "필드가 보내졌는가" 만으로 재계산하면 편집할 때마다 nextRunAt 이
    // 불필요하게 매번 초기화된다 — 로컬 실제 확인에서 실제로 재현된 결함.
    const fixed = new Date("2030-06-01T00:00:00Z");
    seedSchedule({ id: sid(11), cronExpression: "0 0,12 * * *", nextRunAt: fixed, name: "원래 이름" });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(11), {
      name: "이름만 바꿈",
      cronExpression: "0 0,12 * * *", // 폼이 그대로 재전송한 기존 값과 동일
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule.name).toBe("이름만 바꿈");
    expect(new Date(body.schedule.nextRunAt).toISOString()).toBe(fixed.toISOString());
  });

  it("호출측이 nextRunAt 을 직접 지정하면 그 값을 존중하고 재계산하지 않는다", async () => {
    seedSchedule({ id: sid(8), cronExpression: "0 0,12 * * *" });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);
    const explicit = "2030-05-01T00:00:00.000Z";

    const res = await patchReq(sid(8), { cronExpression: "0 * * * *", nextRunAt: explicit });

    const body = await res.json();
    expect(body.schedule.nextRunAt).toBe(explicit);
  });

  it("잘못된 cron 표현식이면 400을 반환하고 저장하지 않는다", async () => {
    seedSchedule({ id: sid(9), cronExpression: "0 0,12 * * *", name: "원래" });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(9), { cronExpression: "not a cron" });

    expect(res.status).toBe(400);
    expect(H.store.schedules.find((s) => s.id === sid(9))!.name).toBe("원래");
  });

  it("cronExpression 이 바뀌지 않으면 nextRunAt 을 건드리지 않는다", async () => {
    const fixed = new Date("2030-01-01T00:00:00Z");
    seedSchedule({ id: sid(10), nextRunAt: fixed });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(sid(10), { active: false });

    const body = await res.json();
    expect(new Date(body.schedule.nextRunAt).toISOString()).toBe(fixed.toISOString());
  });
});
