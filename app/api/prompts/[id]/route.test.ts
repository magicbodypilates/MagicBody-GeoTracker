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
    // DELETE 가 프롬프트를 지우기 전 daily_stats 를 함께 지운다(promptId 가 기본키의 일부라
    // NOT NULL — 프롬프트 삭제 시 FK 의 ON DELETE SET NULL 이 그대로 걸리면 제약 위반이 난다).
    // 이 시험에는 daily_stats 시드가 없어 실제 행 삭제는 검증하지 않고, 컬럼 참조가 죽지
    // 않게 최소 모양만 갖춘다.
    dailyStats: mkTable("dailyStats", ["date", "workspaceId", "provider", "promptId"]),
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

  /** 호출 순서 기록 — 보관 잠금 → 수정 → 보관 응답 되돌리기(응답 보관 §S8). */
  const order: string[] = [];

  const db = {
    select: (proj?: Record<string, { name: string }>) => selectBuilder(proj),
    update: (t: { __table: string }) => {
      order.push("update");
      return updateBuilder(t);
    },
    delete: (t: { __table: string }) => deleteBuilder(t),
    // PATCH 가 켜짐·문구를 바꿀 때 잠금·수정·되돌리기를 한 트랜잭션으로 묶는다 — 같은 가짜로 콜백을 부른다.
    transaction: <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };

  return {
    store,
    db,
    schema,
    order,
    lockResponseArchive: vi.fn(async (_tx: unknown, wsId: string) => {
      order.push(`lock:${wsId}`);
    }),
    restoreByTexts: vi.fn(async (_tx: unknown, wsId: string, texts: string[]) => {
      order.push(`restore:${wsId}:${texts.join("|")}`);
      return { affectedRuns: 3, affectedQuestions: 1, skippedInList: [] };
    }),
    // RV1 수정 전에는 없던 단계 — 워크스페이스 잠금을 잡기 전에 대기 한도를 건다. order 에는
    // 넣지 않는다(기존 lock/update/restore 순서 단언을 그대로 유지) — 호출 여부는 별도 단언.
    applyPromptLockTimeout: vi.fn(async () => {}),
    reset: () => {
      store.prompts = [];
      store.runs = [];
      order.length = 0;
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

// isLockTimeoutError 는 실제 구현(순수 함수)을 그대로 쓴다 — 이 파일에 로직을 다시 베끼면
// run-archive.ts 가 바뀔 때 조용히 어긋날 수 있다.
vi.mock("@/lib/server/run-archive", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    lockResponseArchive: H.lockResponseArchive,
    restoreByTexts: H.restoreByTexts,
    applyPromptLockTimeout: H.applyPromptLockTimeout,
  };
});

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
/**
 * prompts.id 는 이제 라우트 진입 시 zod `.uuid()` 검증을 받는다(S1 수정) — zod v4 는
 * 버전(4)·변형(8~b) 니블까지 확인하므로(실측: 전부 0인 문자열은 "Invalid UUID"로 거부)
 * 버전 4 형태를 고정해 쓴다. "p1" 같은 옛 임의 문자열은 더는 이 라우트를 통과하지 못한다.
 */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
  H.lockResponseArchive.mockClear();
  H.restoreByTexts.mockClear();
  H.applyPromptLockTimeout.mockClear();
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset();
  requireAdminMock.mockReset();
});

describe("PATCH /api/prompts/:id — 워크스페이스 권한 확인", () => {
  it("존재하지 않는 프롬프트 → 404, 권한 체크는 아예 호출되지 않는다", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await patchReq(uid(99), { active: false });
    expect(res.status).toBe(404);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it("권한 없는 세션 거부 — 일반관리자가 다른 워크스페이스 프롬프트를 PATCH → 403, DB 는 바뀌지 않는다", async () => {
    seedPrompt(uid(1), WS_B, { active: true });
    const session = { kind: "user", role: 1, uid: "u1" };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await patchReq(uid(1), { active: false });

    expect(res.status).toBe(403);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_B, session);
    // 권한 게이트에서 막혔으므로 실제 수정이 일어나지 않았다.
    expect(H.store.prompts.find((p) => p.id === uid(1))!.active).toBe(true);
  });

  it("접근 권한이 있으면 정상적으로 수정된다", async () => {
    seedPrompt(uid(2), WS_A, { active: true });
    const session = { kind: "admin", role: 0 };
    getSessionMock.mockResolvedValue(session);
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await patchReq(uid(2), { active: false });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt.active).toBe(false);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS_A, session);
  });

  it("UUID 형식이 아닌 id → 400, DB 조회 없음", async () => {
    const original = H.db.select;
    H.db.select = (() => {
      throw new Error("DB select must not be called for a malformed id");
    }) as unknown as typeof H.db.select;
    try {
      const res = await patchReq("not-a-uuid", { active: false });
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
                `Failed query: select "id", "workspace_id" from "prompts" where "id" = $1 -- params: ["${uid(50)}"]`,
              ),
            ),
        }),
      }),
    })) as unknown as typeof H.db.select;
    try {
      const res = await patchReq(uid(50), { active: false });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/Failed query|select .* from|params:/i);
      expect(body.error).toBe("prompt_update_failed");
    } finally {
      H.db.select = original;
    }
  });
});

describe("DELETE /api/prompts/:id — 워크스페이스 권한 확인", () => {
  it("권한 없는 세션 거부 — 다른 워크스페이스 프롬프트 DELETE → 403, 삭제되지 않는다", async () => {
    seedPrompt(uid(3), WS_B);
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );

    const res = await deleteReq(uid(3));

    expect(res.status).toBe(403);
    expect(H.store.prompts).toHaveLength(1);
    // 워크스페이스 게이트에서 이미 막혔으므로 cascade/admin 체크까지 가지 않는다.
    expect(requireAdminMock).not.toHaveBeenCalled();
  });

  it("워크스페이스 접근은 되지만 cascade=true 이고 admin 이 아니면 403, 삭제되지 않는다", async () => {
    seedPrompt(uid(4), WS_A);
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(null);
    requireAdminMock.mockReturnValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));

    const res = await deleteReq(uid(4), "?cascade=true");

    expect(res.status).toBe(403);
    expect(H.store.prompts).toHaveLength(1);
  });

  it("접근 권한이 있으면 정상 삭제되고, cascade 시 같은 워크스페이스·같은 문구의 runs 만 함께 삭제된다", async () => {
    seedPrompt(uid(5), WS_A, { text: "지울 문구" });
    H.store.runs.push({ id: "r1", workspaceId: WS_A, promptText: "지울 문구" });
    H.store.runs.push({ id: "r2", workspaceId: WS_A, promptText: "다른 문구" });
    H.store.runs.push({ id: "r3", workspaceId: WS_B, promptText: "지울 문구" }); // 다른 워크스페이스 — 영향 없어야 함
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);
    requireAdminMock.mockReturnValue(null);

    const res = await deleteReq(uid(5), "?cascade=true");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runsDeleted).toBe(1);
    expect(H.store.prompts).toHaveLength(0);
    expect(H.store.runs.map((r) => r.id).sort()).toEqual(["r2", "r3"]);
  });

  it("cascade 없이 삭제하면 runs 는 그대로 남는다", async () => {
    seedPrompt(uid(6), WS_A, { text: "지울 문구2" });
    H.store.runs.push({ id: "r4", workspaceId: WS_A, promptText: "지울 문구2" });
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    assertWorkspaceAccessMock.mockResolvedValue(null);

    const res = await deleteReq(uid(6));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runsDeleted).toBe(0);
    expect(H.store.runs).toHaveLength(1);
    expect(requireAdminMock).not.toHaveBeenCalled(); // cascade 아니므로 admin 체크 자체를 안 함
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
                `Failed query: select "id", "text", "workspace_id" from "prompts" where "id" = $1 -- params: ["${uid(51)}"]`,
              ),
            ),
        }),
      }),
    })) as unknown as typeof H.db.select;
    try {
      const res = await deleteReq(uid(51));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/Failed query|select .* from|params:/i);
      expect(body.error).toBe("prompt_delete_failed");
    } finally {
      H.db.select = original;
    }
  });
});

describe("PATCH /api/prompts/:id — 켜면 보관 응답 자동 복원 (응답 보관 §S8)", () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
    assertWorkspaceAccessMock.mockResolvedValue(null);
  });

  it("다시 켜기(active=true) → 잠금 → 수정 → 그 문구 되돌리기 순서 · restoredRuns", async () => {
    seedPrompt(uid(20), WS_A, { text: "꺼졌던 질문", active: false });
    const res = await patchReq(uid(20), { active: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt.active).toBe(true);
    expect(body.restoredRuns).toBe(3);
    expect(H.order).toEqual([`lock:${WS_A}`, "update", `restore:${WS_A}:꺼졌던 질문`]);
    // 워크스페이스 잠금을 잡기 전에 대기 한도를 건다(결함 대장 RV1).
    expect(H.applyPromptLockTimeout).toHaveBeenCalledTimes(1);
  });

  it("켜진 질문의 문구를 바꾸면 **바뀐 문구**를 되돌린다", async () => {
    seedPrompt(uid(21), WS_A, { text: "옛 문구", active: true });
    const res = await patchReq(uid(21), { text: "새 문구" });
    expect(res.status).toBe(200);
    expect(H.restoreByTexts).toHaveBeenCalledTimes(1);
    expect(H.restoreByTexts.mock.calls[0].slice(1)).toEqual([WS_A, ["새 문구"]]);
  });

  it("끄기(active=false) → 잠금·수정은 하되 되돌리지 않는다 · restoredRuns 0", async () => {
    seedPrompt(uid(22), WS_A, { text: "끌 질문", active: true });
    const res = await patchReq(uid(22), { active: false });
    expect(res.status).toBe(200);
    expect((await res.json()).restoredRuns).toBe(0);
    expect(H.lockResponseArchive).toHaveBeenCalledTimes(1);
    expect(H.restoreByTexts).not.toHaveBeenCalled();
  });

  it("태그만 바꾸면 잠금·되돌리기 없이 저장 · restoredRuns 0", async () => {
    seedPrompt(uid(23), WS_A, { text: "태그 질문", active: true });
    const res = await patchReq(uid(23), { tags: ["새 태그"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt.tags).toEqual(["새 태그"]);
    expect(body.restoredRuns).toBe(0);
    expect(H.lockResponseArchive).not.toHaveBeenCalled();
    expect(H.restoreByTexts).not.toHaveBeenCalled();
  });

  it("권한이 없으면 잠금·되돌리기까지 가지 않는다", async () => {
    seedPrompt(uid(24), WS_B, { text: "남의 질문", active: false });
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await patchReq(uid(24), { active: true });
    expect(res.status).toBe(403);
    expect(H.lockResponseArchive).not.toHaveBeenCalled();
    expect(H.restoreByTexts).not.toHaveBeenCalled();
  });

  it("워크스페이스 잠금 대기 한도 초과(55P03) → 409 + 쉬운 안내, SQL 원문 없음(결함 대장 RV1)", async () => {
    seedPrompt(uid(25), WS_A, { text: "잠금 경합 질문", active: false });
    // postgres.js 가 lock_timeout 만료 시 던지는 오류를 drizzle-orm 0.45 가 DrizzleQueryError 로
    // 감싼 모양을 재현 — 원래 postgres 오류(code 포함)는 err.cause 에 남는다.
    H.lockResponseArchive.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Failed query: select 1 from pg_advisory_xact_lock(hashtextextended('geo:response-archive:' || $1::text, 0))",
        ),
        { cause: { code: "55P03", message: "canceling statement due to lock timeout" } },
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await patchReq(uid(25), { active: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "archive_lock_busy",
      hint: "다른 정리 작업이 진행 중이에요. 잠시 후 다시 시도해 주세요.",
    });
    expect(JSON.stringify(body)).not.toMatch(/pg_advisory_xact_lock|Failed query|lock_timeout/);
    // 수정도 되돌리기도 일어나지 않는다(트랜잭션 전체 롤백) — 씨딩한 값 그대로.
    expect(H.store.prompts.find((p) => p.id === uid(25))!.active).toBe(false);
    expect(H.restoreByTexts).not.toHaveBeenCalled();
  });
});
