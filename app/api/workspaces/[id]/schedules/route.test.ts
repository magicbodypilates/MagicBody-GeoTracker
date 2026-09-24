/**
 * route.test.ts — POST /api/workspaces/:id/schedules 의 promptIds 검증(R2).
 *
 * 운영에서 확인된 결함: 이 라우트는 promptIds 를 전혀 검증하지 않고 그대로 insert 했다.
 * schedules/[id] PATCH 는 "존재하지 않는 ID 는 걸러내고, 비어 있지 않은 선택이 전부
 * 무효면 거부"하는 규칙이 있는데, 스케줄 "생성" 경로에는 같은 규칙이 없어 불일치했다.
 * 이 테스트는 POST 에도 동일 규칙이 적용되는지를 고정한다. DB 는 in-memory fake 로 대체.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type PromptRow = { id: string; workspaceId: string };
type ScheduleRow = {
  id: string;
  workspaceId: string;
  name: string;
  cronExpression: string;
  providers: string[];
  promptIds: string[];
  geolocation: string | null;
  active: boolean;
  createdAt: Date;
};

const H = vi.hoisted(() => {
  const store: { prompts: PromptRow[]; schedules: ScheduleRow[] } = { prompts: [], schedules: [] };
  let seq = 1;

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
  const schema = {
    prompts: { __table: "prompts", id: col("id"), workspaceId: col("workspaceId") },
    schedules: {
      __table: "schedules",
      id: col("id"),
      workspaceId: col("workspaceId"),
      name: col("name"),
      cronExpression: col("cronExpression"),
      providers: col("providers"),
      promptIds: col("promptIds"),
      geolocation: col("geolocation"),
      active: col("active"),
      createdAt: col("createdAt"),
    },
  };

  // 이 라우트의 select 는 prompts 테이블 하나만, limit() 없이 그대로 await 된다
  // (schedules/[id] PATCH 의 promptIds 존재 검증과 동일한 사용 패턴).
  const selectBuilder = (proj?: Record<string, { name: string }>) => {
    let pred: Pred | undefined;
    const api = {
      from() {
        return api;
      },
      where(p: Pred) {
        pred = p;
        return {
          then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
            try {
              res(store.prompts.filter((r) => match(r, pred)).map((r) => project(r, proj)));
            } catch (e) {
              if (rej) rej(e);
            }
          },
        };
      },
    };
    return api;
  };

  const insertBuilder = () => {
    let vals: Partial<ScheduleRow> | null = null;
    const api = {
      values(v: Partial<ScheduleRow>) {
        vals = v;
        return api;
      },
      returning() {
        const row: ScheduleRow = {
          id: `sch-${seq++}`,
          workspaceId: vals!.workspaceId!,
          name: vals!.name!,
          cronExpression: vals!.cronExpression!,
          providers: vals!.providers ?? [],
          promptIds: vals!.promptIds ?? [],
          geolocation: vals!.geolocation ?? null,
          active: vals!.active ?? true,
          createdAt: new Date(),
        };
        store.schedules.push(row);
        return Promise.resolve([{ ...row }]);
      },
    };
    return api;
  };

  const db = {
    select: (proj?: Record<string, { name: string }>) => selectBuilder(proj),
    insert: () => insertBuilder(),
  };

  return {
    store,
    db,
    schema,
    reset: () => {
      store.prompts = [];
      store.schedules = [];
      seq = 1;
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
    asc: (col: unknown) => col,
  };
});

vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "admin", role: 0 }),
  assertWorkspaceAccess: async () => null,
}));

const { POST } = await import("./route");

const WS = "11111111-1111-1111-1111-111111111111";
const WS_OTHER = "22222222-2222-2222-2222-222222222222";
/** zod v4 `.uuid()` 는 버전(4)·변형(8~b) 니블까지 확인하므로 버전 4 형태로 고정. */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function post(body: unknown) {
  return POST(
    new NextRequest(`http://localhost/api/workspaces/${WS}/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: WS }) },
  );
}

beforeEach(() => {
  H.reset();
});

describe("POST /api/workspaces/:id/schedules — promptIds 검증", () => {
  const baseBody = { name: "테스트 스케줄", cronExpression: "0 * * * *", providers: ["chatgpt"] };

  it("promptIds 생략 시 빈 배열 기본값으로 생성된다(활성 전체 실행 의미)", async () => {
    const res = await post(baseBody);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([]);
  });

  it("promptIds 를 명시적으로 빈 배열로 보내도 그대로 허용된다", async () => {
    const res = await post({ ...baseBody, promptIds: [] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([]);
  });

  it("전부 유효한 promptIds 는 그대로 저장된다", async () => {
    H.store.prompts.push({ id: uid(1), workspaceId: WS });
    H.store.prompts.push({ id: uid(2), workspaceId: WS });

    const res = await post({ ...baseBody, promptIds: [uid(1), uid(2)] });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([uid(1), uid(2)]);
  });

  it("일부만 무효(삭제됨/다른 워크스페이스)면 무효 ID 만 걸러진다", async () => {
    H.store.prompts.push({ id: uid(3), workspaceId: WS });
    H.store.prompts.push({ id: uid(4), workspaceId: WS_OTHER }); // 다른 워크스페이스 소속

    const res = await post({ ...baseBody, promptIds: [uid(3), uid(4)] });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule.promptIds).toEqual([uid(3)]);
  });

  it("비어 있지 않은 선택인데 전부 무효면 400 으로 거부하고, 스케줄이 생성되지 않는다", async () => {
    const res = await post({ ...baseBody, promptIds: [uid(5), uid(6)] }); // 어디에도 없는 ID

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("no_valid_prompts_selected");
    expect(typeof body.hint).toBe("string");
    expect(H.store.schedules).toHaveLength(0);
  });
});
