/**
 * route.test.ts — POST /api/schedules/:id/trigger 워크스페이스 권한 게이트.
 *
 * 운영에서 확인된 결함: 이 라우트는 id 만으로 대상을 찾기 때문에 getSession·
 * assertWorkspaceAccess 호출이 전혀 없었다 — 권한 없는 일반관리자 세션으로도 남의
 * 워크스페이스 스케줄을 즉시 실행(nextRunAt 을 과거로, active 를 true 로) 상태로 바꿀 수
 * 있었다(같은 세션의 PATCH/DELETE 는 403 으로 정상 차단되는 것과 대비됨). 이제는
 * schedules/[id] PATCH·DELETE 와 동일한 패턴(대상 조회 → assertWorkspaceAccess)을 적용한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type ScheduleRow = {
  id: string;
  workspaceId: string;
  nextRunAt: Date | null;
  active: boolean;
};

const H = vi.hoisted(() => {
  const store: { schedules: ScheduleRow[] } = { schedules: [] };

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
    schedules: {
      __table: "schedules",
      id: col("id"),
      workspaceId: col("workspaceId"),
      nextRunAt: col("nextRunAt"),
      active: col("active"),
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
        const rows = store.schedules.filter((r) => match(r, pred));
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
        const rows = store.schedules.filter((r) => match(r, pred));
        for (const r of rows) Object.assign(r, vals);
        return Promise.resolve(rows.map((r) => project(r, proj)));
      },
    };
    return api;
  };

  const db = {
    select: (proj?: Record<string, { name: string }>) => selectBuilder(proj),
    update: () => updateBuilder(),
  };

  return {
    store,
    db,
    schema,
    reset: () => {
      store.schedules = [];
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

const { POST } = await import("./route");

const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function seedSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  const row: ScheduleRow = {
    id: "sch-1",
    workspaceId: WS_A,
    nextRunAt: new Date("2030-01-01T00:00:00Z"),
    active: false,
    ...overrides,
  };
  H.store.schedules.push(row);
  return row;
}

function triggerReq(id: string) {
  return POST(new NextRequest(`http://localhost/api/schedules/${id}/trigger`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  H.reset();
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset();
});

describe("POST /api/schedules/:id/trigger — 워크스페이스 권한 확인", () => {
  it("존재하지 않는 스케줄 → 404, 권한 체크는 호출되지 않는다", async () => {
    const res = await triggerReq("no-such-id");
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 다른 워크스페이스 스케줄 트리거 → 403, DB 는 바뀌지 않는다", async () => {
    const fixed = new Date("2030-01-01T00:00:00Z");
    seedSchedule({ id: "sch-2", workspaceId: WS_B, nextRunAt: fixed, active: false });
    const session = { kind: "user", role: 1, uid: "u1" };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await triggerReq("sch-2");

    expect(res.status).toBe(403);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_B, session);
    const row = H.store.schedules.find((s) => s.id === "sch-2")!;
    expect(row.active).toBe(false);
    expect(row.nextRunAt!.toISOString()).toBe(fixed.toISOString());
  });

  it("접근 권한이 있으면 nextRunAt 이 과거로, active 가 true 로 바뀐다", async () => {
    seedSchedule({ id: "sch-3", workspaceId: WS_A, nextRunAt: new Date("2030-01-01T00:00:00Z"), active: false });
    const session = { kind: "admin", role: 0 };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await triggerReq("sch-3");

    expect(res.status).toBe(200);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_A, session);
    const body = await res.json();
    expect(body.schedule.active).toBe(true);
    expect(new Date(body.schedule.nextRunAt).getTime()).toBeLessThan(Date.now());
  });
});
