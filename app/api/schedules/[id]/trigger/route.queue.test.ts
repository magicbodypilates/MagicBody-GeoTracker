/**
 * route.queue.test.ts — POST /api/schedules/:id/trigger 의 새 수집 엔진(queue) 경로 단위 테스트.
 * 계획 geotracker-collect-speed-260924 §8-1 · §11 "trigger 라우트 테스트".
 *
 * DB·엔진·권한은 가짜다. 실제 DB 로 합류·중복 없음·같은 시간대 재실행을 확인하는 것은
 * lib/server/collector-routes.int.test.ts 가 맡는다. legacy 경로는 route.test.ts(무수정)가 맡는다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type ScheduleRow = {
  id: string;
  workspaceId: string;
  name: string;
  cronExpression: string;
  providers: string[];
  promptIds: string[];
  geolocation: string | null;
  active: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
};

const H = vi.hoisted(() => {
  const store: { schedules: ScheduleRow[] } = { schedules: [] };
  type Pred = { op: "eq"; col: { name: string }; val: unknown };
  const match = (row: Record<string, unknown>, pred?: Pred) => (pred ? row[pred.col.name] === pred.val : true);
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
  const selectBuilder = () => {
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
        return Promise.resolve(store.schedules.filter((r) => match(r, pred)).slice(0, n).map((r) => ({ ...r })));
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
      returning() {
        const rows = store.schedules.filter((r) => match(r, pred));
        for (const r of rows) Object.assign(r, vals);
        return Promise.resolve(rows.map((r) => ({ ...r })));
      },
    };
    return api;
  };
  return {
    store,
    schema,
    db: { select: () => selectBuilder(), update: () => updateBuilder() },
    reset: () => {
      store.schedules = [];
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
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
}));

const createRoundMock = vi.fn();
vi.mock("@/lib/server/collector-engine", () => ({
  createRoundForSchedule: (...args: unknown[]) => createRoundMock(...args),
}));

const { POST } = await import("./route");

const WS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function seed(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  const row: ScheduleRow = {
    id: "sch-1",
    workspaceId: WS,
    name: "시험 스케줄",
    cronExpression: "0 */6 * * *",
    providers: ["chatgpt"],
    promptIds: [],
    geolocation: null,
    active: true,
    lastRunAt: null,
    nextRunAt: new Date("2030-01-01T06:00:00Z"),
    createdAt: new Date("2030-01-01T00:00:00Z"),
    ...overrides,
  };
  H.store.schedules.push(row);
  return row;
}

function fakeRound(overrides: Record<string, unknown> = {}) {
  return {
    id: "round-1",
    workspaceId: WS,
    scheduleId: "sch-1",
    trigger: "manual",
    priority: 1,
    status: "running",
    scheduledFor: new Date("2030-01-01T03:00:00Z"),
    intervalSlot: "2030-01-01T03",
    geolocation: null,
    scoringSnapshot: { brandConfig: { brandName: "비공개 설정" }, competitors: [] },
    expectedItems: 4,
    summary: null,
    createdAt: new Date("2030-01-01T03:00:00Z"),
    finishedAt: null,
    ...overrides,
  };
}

function trigger(id = "sch-1") {
  return POST(new NextRequest(`http://localhost/api/schedules/${id}/trigger`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  H.reset();
  getSessionMock.mockReset().mockResolvedValue({ kind: "admin", role: 0 });
  assertWorkspaceAccessMock.mockReset().mockResolvedValue(null);
  createRoundMock.mockReset();
  vi.stubEnv("GEO_COLLECTOR_ENGINE", "queue");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/schedules/:id/trigger — 새 엔진(queue)", () => {
  it("권한 없음 → 403, 회차를 만들지 않는다", async () => {
    seed();
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await trigger();
    expect(res.status).toBe(403);
    expect(createRoundMock).not.toHaveBeenCalled();
  });

  it("없는 스케줄 → 404", async () => {
    const res = await trigger("nope");
    expect(res.status).toBe(404);
    expect(createRoundMock).not.toHaveBeenCalled();
  });

  it("새 회차 → 200 · 우선순위 1 수동 회차 요청 · newItems·안내 · 점수 기준 사본은 싣지 않는다", async () => {
    seed();
    createRoundMock.mockResolvedValue({ status: "created", round: fakeRound(), newItems: 4 });
    const res = await trigger();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newItems).toBe(4);
    expect(body.hint).toContain("4개 항목을 순서에 올렸습니다");
    expect(body.round).not.toHaveProperty("scoringSnapshot");
    expect(JSON.stringify(body)).not.toContain("비공개 설정");
    const [schedArg, opts] = createRoundMock.mock.calls[0] as [ScheduleRow, Record<string, unknown>];
    expect(schedArg.id).toBe("sch-1");
    expect(opts).toMatchObject({ trigger: "manual", priority: 1, onRunning: "top_up" });
    // 즉시 실행은 정기 주기(next_run_at)를 건드리지 않는다
    expect(H.store.schedules[0].nextRunAt!.toISOString()).toBe("2030-01-01T06:00:00.000Z");
  });

  it("같은 시간대에 이미 모두 모았으면(newItems 0) 그렇게 알려 준다", async () => {
    seed();
    createRoundMock.mockResolvedValue({ status: "created", round: fakeRound(), newItems: 0 });
    const body = await (await trigger()).json();
    expect(body.hint).toContain("이미 모두 모았습니다");
  });

  it("질문이 없어 빈 회차면 질문 확인을 안내한다", async () => {
    seed();
    createRoundMock.mockResolvedValue({
      status: "created",
      round: fakeRound({ expectedItems: 0, status: "completed" }),
      newItems: 0,
    });
    const body = await (await trigger()).json();
    expect(body.hint).toContain("실행할 질문이 없습니다");
  });

  it("진행 중 합류 — 새 질문을 더했으면 joinedRunning·addedItems·안내", async () => {
    seed();
    createRoundMock.mockResolvedValue({
      status: "topped_up",
      round: fakeRound({ priority: 1 }),
      addedItems: 8,
      addedPrompts: 2,
      newItems: 8,
    });
    const body = await (await trigger()).json();
    expect(body).toMatchObject({ ok: true, joinedRunning: true, addedItems: 8, newItems: 8 });
    expect(body.hint).toBe("진행 중인 조사에 새 질문 2개를 더해 먼저 처리합니다.");
  });

  it("진행 중 합류 — 더할 것이 없으면 이미 들어 있다고 안내", async () => {
    seed();
    createRoundMock.mockResolvedValue({ status: "topped_up", round: fakeRound(), addedItems: 0, addedPrompts: 0, newItems: 0 });
    const body = await (await trigger()).json();
    expect(body.hint).toContain("이미 진행 중인 조사에 모두 들어 있습니다");
  });

  it("오래된 회차를 마무리하는 중이면 409 + 안내", async () => {
    seed();
    createRoundMock.mockResolvedValue({ status: "running_skipped", round: fakeRound(), closing: true });
    const res = await trigger();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("previous_round_closing");
    expect(body.hint).toContain("몇 분 뒤 다시");
  });

  it("꺼진 스케줄을 켤 때 — 다음 시각은 지금 이후 첫 cron (과거로 두지 않는다)", async () => {
    seed({ active: false, nextRunAt: null });
    createRoundMock.mockResolvedValue({ status: "created", round: fakeRound(), newItems: 1 });
    const before = Date.now();
    const res = await trigger();
    expect(res.status).toBe(200);
    const row = H.store.schedules[0];
    expect(row.active).toBe(true);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(before);
    expect(row.nextRunAt!.getUTCMinutes()).toBe(0); // "0 */6 * * *" 의 정각
    const [schedArg] = createRoundMock.mock.calls[0] as [ScheduleRow];
    expect(schedArg.active).toBe(true);
  });

  it("엔진 오류 → 500 고정 코드, SQL·원문을 싣지 않는다", async () => {
    seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    createRoundMock.mockRejectedValue(new Error('Failed query: insert into "collection_items" ... params: 비밀 질문'));
    const res = await trigger();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "trigger_failed" });
  });

  it("legacy 로 되돌리면 예전 동작(next_run_at 을 1분 전으로) — 회차를 만들지 않는다", async () => {
    vi.stubEnv("GEO_COLLECTOR_ENGINE", "legacy");
    seed({ active: false });
    const res = await trigger();
    expect(res.status).toBe(200);
    expect(createRoundMock).not.toHaveBeenCalled();
    const row = H.store.schedules[0];
    expect(row.active).toBe(true);
    expect(row.nextRunAt!.getTime()).toBeLessThan(Date.now());
  });
});
