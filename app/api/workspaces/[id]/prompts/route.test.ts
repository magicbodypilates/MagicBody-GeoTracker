/**
 * route.test.ts — POST /api/workspaces/:id/prompts "추가 = 없으면 생성, 있으면 재활성화" 계약.
 *
 * 운영에서 확인된 결함: 과거엔 UNIQUE(workspace_id, text) 위반을 err.message.includes(...)
 * 로 판정했는데, drizzle-orm 0.45 가 DB 오류를 DrizzleQueryError("Failed query: ...")로
 * 감싸 그 판정이 항상 거짓이 됐다 → 409 대신 500. 게다가 클라이언트(addPromptIfNew)는
 * 409 를 "이미 있음 = 성공"으로 넘겨서, 꺼져 있던(active=false) 프롬프트를 재추가해도
 * 다시 켜지지 않고 화면(active 만 보여줌)에서 영영 사라진 채로 남았다.
 *
 * 이 테스트는 새 POST 구현(ON CONFLICT DO UPDATE)이 세 가지 경우를 실제로 만족하는지
 * 본다 — 새 문구 생성 / 꺼진 문구 재활성화(태그는 기존 유지) / 켜진 문구 재추가는 그대로
 * 성공. DB 는 in-memory fake 로 대체하고 insert().values().onConflictDoUpdate().returning()
 * 체인만 실제 라우트 코드가 기대하는 모양대로 재현한다(실제 postgres 미사용).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type PromptRow = {
  id: string;
  workspaceId: string;
  text: string;
  tags: string[];
  active: boolean;
  setId: string;
  createdAt: Date;
};

/** 세트 번호(유효한 UUID v4 모양) — 기본 세트와 다른 세트 하나. */
const SET_DEFAULT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SET_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const H = vi.hoisted(() => {
  const store: { prompts: PromptRow[] } = { prompts: [] };
  /** alreadyInSet 조회가 돌려줄 세트 — 테스트가 정한다. */
  let lastLookedUpSet: { id: string; name: string } | null = null;
  let seq = 1;
  /** 호출 순서 기록 — 보관 잠금 → 추가(upsert) → 보관 응답 되돌리기(응답 보관 §S8). */
  const order: string[] = [];
  let restoredRunsNext = 0;
  /** GET 목록 조회가 실패해야 하면 여기에 담는다 — 결함 대장 F1 재현용. */
  let selectFailWith: Error | null = null;

  const insertBuilder = () => {
    let vals: Partial<PromptRow> | null = null;
    let conflictSet: Record<string, unknown> | null = null;
    const api = {
      values(v: Partial<PromptRow>) {
        vals = v;
        return api;
      },
      onConflictDoUpdate(cfg: { set: Record<string, unknown> }) {
        conflictSet = cfg.set;
        return api;
      },
      returning() {
        order.push("upsert");
        const existing = store.prompts.find(
          (r) => r.workspaceId === vals!.workspaceId && r.text === vals!.text,
        );
        if (existing) {
          if (!conflictSet) {
            // 실제 postgres 의 UNIQUE 위반 재현 — 이 스위트의 모든 호출은 라우트가
            // 항상 onConflictDoUpdate 를 거치므로 이 분기에 도달하면 그 자체가 결함이다.
            return Promise.reject(
              new Error('duplicate key value violates unique constraint "uq_prompts_workspace_text"'),
            );
          }
          // 세트 칸은 라우트가 SQL CASE 로 보낸다 — 실제 postgres 와 같은 뜻으로 흉내 낸다:
          // 켜진 기존 행은 세트를 유지하고, 꺼진 행은 요청한 세트로 옮긴다.
          const plain = { ...(conflictSet as Record<string, unknown>) };
          delete plain.setId;
          const nextSetId = existing.active ? existing.setId : (vals!.setId as string);
          Object.assign(existing, plain, { setId: nextSetId });
          return Promise.resolve([{ ...existing }]);
        }
        const row: PromptRow = {
          id: `id-${seq++}`,
          workspaceId: vals!.workspaceId!,
          text: vals!.text!,
          tags: vals!.tags ?? [],
          active: vals!.active ?? true,
          setId: vals!.setId as string,
          createdAt: new Date(),
        };
        store.prompts.push(row);
        return Promise.resolve([{ ...row }]);
      },
    };
    return api;
  };

  const db = {
    insert: (_table: unknown) => insertBuilder(),
    // GET 목록 조회 — select().from().where().orderBy(). F1(오류 시 원문 노출) 재현용으로 실패를 주입할 수 있다.
    // 다른 세트 이름 조회(alreadyInSet) — select().from().where().limit(). 돌려줄 세트는 setLookup 으로 정한다.
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_pred: unknown) => ({
          orderBy: (_o: unknown) =>
            selectFailWith ? Promise.reject(selectFailWith) : Promise.resolve([...store.prompts]),
          limit: (_n: number) => Promise.resolve(lastLookedUpSet ? [lastLookedUpSet] : []),
        }),
      }),
    }),
    // 라우트는 잠금·추가·되돌리기를 한 트랜잭션으로 묶는다 — 가짜는 같은 가짜 db 로 콜백을 부른다.
    transaction: <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };

  const schema = {
    prompts: {
      workspaceId: { __col: true, name: "workspaceId" },
      text: { __col: true, name: "text" },
    },
    promptSets: {
      id: { __col: true, name: "id" },
      name: { __col: true, name: "name" },
    },
  };

  return {
    store,
    db,
    schema,
    order,
    setLookup: (v: { id: string; name: string } | null) => {
      lastLookedUpSet = v;
    },
    // 넣을 세트 고르기 — setId 가 오면 그 세트, 없으면 기본 세트. 「다른 워크스페이스 세트」는 테스트가 실패를 주입한다.
    resolveTargetSet: vi.fn(async (_tx: unknown, _ws: string, setId?: string | null) => ({
      id: setId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: setId ? "새 세트" : "기존 세트",
      isDefault: !setId,
    })),
    setRestoredRuns: (n: number) => {
      restoredRunsNext = n;
    },
    setSelectFail: (e: Error | null) => {
      selectFailWith = e;
    },
    lockResponseArchive: vi.fn(async (_tx: unknown, wsId: string) => {
      order.push(`lock:${wsId}`);
    }),
    restoreByTexts: vi.fn(async (_tx: unknown, wsId: string, texts: string[]) => {
      order.push(`restore:${wsId}:${texts.join("|")}`);
      return { affectedRuns: restoredRunsNext, affectedQuestions: restoredRunsNext > 0 ? 1 : 0, skippedInList: [] };
    }),
    // RV1 수정 전에는 없던 단계 — 워크스페이스 잠금을 잡기 전에 대기 한도를 건다. 순서 검증용
    // order 에는 넣지 않는다(기존 lock/upsert/restore 순서 단언을 그대로 유지하기 위함) — 호출
    // 여부·횟수는 별도 단언으로 확인한다.
    applyPromptLockTimeout: vi.fn(async () => {}),
    reset: () => {
      store.prompts = [];
      seq = 1;
      order.length = 0;
      restoredRunsNext = 0;
      selectFailWith = null;
      lastLookedUpSet = null;
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

// isLockTimeoutError 는 실제 구현(순수 함수)을 그대로 쓴다 — 로직을 이 파일에 다시 베끼면
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

// 세트 고르기만 가짜로 — 오류 판별(isPromptSetFkViolation)·PromptSetError 는 실제 구현을 쓴다.
vi.mock("@/lib/server/prompt-sets", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, resolveTargetSet: H.resolveTargetSet };
});

vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "admin", role: 0 }),
  assertWorkspaceAccess: async () => null,
}));

const { GET, POST } = await import("./route");

const WS = "11111111-1111-1111-1111-111111111111";

function post(body: unknown) {
  return POST(
    new NextRequest(`http://localhost/api/workspaces/${WS}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: WS }) },
  );
}

beforeEach(() => {
  H.reset();
  H.resolveTargetSet.mockClear();
  H.lockResponseArchive.mockClear();
  H.restoreByTexts.mockClear();
  H.applyPromptLockTimeout.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST /api/workspaces/:id/prompts — 추가 = 없으면 생성, 있으면 재활성화", () => {
  it("새 문구 → 생성", async () => {
    const res = await post({ text: "새 프롬프트", tags: ["a"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt.text).toBe("새 프롬프트");
    expect(body.prompt.tags).toEqual(["a"]);
    expect(body.prompt.active).toBe(true);
    expect(H.store.prompts).toHaveLength(1);
  });

  it("꺼진 문구 재추가 → 켜짐, 태그는 기존 값 유지(재추가 요청의 tags 로 덮어쓰지 않음)", async () => {
    H.store.prompts.push({
      id: "existing-1",
      workspaceId: WS,
      text: "이미 있음",
      tags: ["old-tag"],
      active: false,
      setId: SET_DEFAULT,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await post({ text: "이미 있음", tags: ["new-tag-should-be-ignored"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt.active).toBe(true);
    expect(body.prompt.tags).toEqual(["old-tag"]);
    // 새 행을 만들지 않고 기존 행 하나만 재활성화한다.
    expect(H.store.prompts).toHaveLength(1);
    expect(H.store.prompts[0].active).toBe(true);
    expect(H.store.prompts[0].id).toBe("existing-1");
  });

  it("켜진 문구 재추가 → 그대로 성공(중복 행이 생기지 않는다)", async () => {
    H.store.prompts.push({
      id: "existing-2",
      workspaceId: WS,
      text: "이미 켜짐",
      tags: [],
      active: true,
      setId: SET_DEFAULT,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await post({ text: "이미 켜짐", tags: [] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt.active).toBe(true);
    expect(H.store.prompts).toHaveLength(1);
  });

  it("다른 워크스페이스의 같은 문구는 서로 간섭하지 않는다", async () => {
    const otherWs = "22222222-2222-2222-2222-222222222222";
    H.store.prompts.push({
      id: "other-ws-1",
      workspaceId: otherWs,
      text: "공통 문구",
      tags: [],
      active: false,
      setId: SET_DEFAULT,
      createdAt: new Date(),
    });

    const res = await post({ text: "공통 문구", tags: [] });
    expect(res.status).toBe(201);
    expect(H.store.prompts).toHaveLength(2);
    // 다른 워크스페이스의 행은 건드리지 않는다(비활성 그대로).
    expect(H.store.prompts.find((p) => p.workspaceId === otherWs)!.active).toBe(false);
  });

  it("빈 text 는 400 (기존 zod 검증 유지)", async () => {
    const res = await post({ text: "" });
    expect(res.status).toBe(400);
    expect(H.store.prompts).toHaveLength(0);
  });

  it("DB 오류 시 응답 본문에 SQL 원문을 싣지 않는다", async () => {
    // drizzle-orm 0.45 가 실제로 던지는 모양(DrizzleQueryError 가 SQL 전문을 message 에
    // 담음)을 흉내내, 라우트가 이걸 그대로 클라이언트에 돌려주지 않는지 확인한다.
    const original = H.db.insert;
    H.db.insert = (() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.reject(
              new Error(
                'Failed query: insert into "prompts" ("workspace_id", "text") values ($1, $2) on conflict ... — duplicate key value violates unique constraint "uq_prompts_workspace_text"',
              ),
            ),
        }),
      }),
    })) as unknown as typeof H.db.insert;
    try {
      const res = await post({ text: "충돌 유발", tags: [] });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/uq_prompts_workspace_text|Failed query/);
      expect(body.error).toBe("prompt_create_failed");
    } finally {
      H.db.insert = original;
    }
  });
});

describe("POST /api/workspaces/:id/prompts — 보관 응답 자동 복원 (응답 보관 §S8)", () => {
  it("한 트랜잭션에서 잠금 → 추가 → 그 문구 되돌리기 순서로 부르고, 되돌린 건수를 restoredRuns 로 싣는다", async () => {
    H.setRestoredRuns(7);
    const res = await post({ text: "다시 추가한 질문", tags: [] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.restoredRuns).toBe(7);
    expect(body.prompt.text).toBe("다시 추가한 질문");
    expect(H.order).toEqual([`lock:${WS}`, "upsert", `restore:${WS}:다시 추가한 질문`]);
    // 워크스페이스 잠금을 잡기 전에 대기 한도를 건다(결함 대장 RV1).
    expect(H.applyPromptLockTimeout).toHaveBeenCalledTimes(1);
  });

  it("되돌릴 응답이 없으면 restoredRuns = 0", async () => {
    const res = await post({ text: "처음 추가하는 질문", tags: [] });
    expect(res.status).toBe(201);
    expect((await res.json()).restoredRuns).toBe(0);
  });

  it("추가가 실패하면 되돌리기를 부르지 않는다(트랜잭션 전체 실패 → 500)", async () => {
    const original = H.db.insert;
    H.db.insert = (() => ({
      values: () => ({ onConflictDoUpdate: () => ({ returning: () => Promise.reject(new Error("Failed query: x")) }) }),
    })) as unknown as typeof H.db.insert;
    try {
      const res = await post({ text: "실패 질문", tags: [] });
      expect(res.status).toBe(500);
      expect(H.restoreByTexts).not.toHaveBeenCalledWith(expect.anything(), WS, ["실패 질문"]);
    } finally {
      H.db.insert = original;
    }
  });

  it("워크스페이스 잠금 대기 한도 초과(55P03) → 409 + 쉬운 안내, SQL 원문 없음(결함 대장 RV1)", async () => {
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
    const res = await post({ text: "잠금 경합 질문", tags: [] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "archive_lock_busy",
      hint: "다른 정리 작업이 진행 중이에요. 잠시 후 다시 시도해 주세요.",
    });
    expect(JSON.stringify(body)).not.toMatch(/pg_advisory_xact_lock|Failed query|lock_timeout/);
    // 추가 자체도, 되돌리기도 일어나지 않는다(트랜잭션 전체 롤백).
    expect(H.store.prompts).toHaveLength(0);
    expect(H.restoreByTexts).not.toHaveBeenCalled();
  });

  it("잠금 관련이 아닌 postgres 오류(예: 42703)는 여전히 일반 500 으로 떨어진다", async () => {
    H.lockResponseArchive.mockRejectedValueOnce(
      Object.assign(new Error("Failed query: select 1 from prompts"), {
        cause: { code: "42703", message: 'column "x" does not exist' },
      }),
    );
    const res = await post({ text: "다른 오류 질문", tags: [] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "prompt_create_failed" });
  });
});

describe("GET /api/workspaces/:id/prompts — 목록 조회", () => {
  function get() {
    return GET(new NextRequest(`http://localhost/api/workspaces/${WS}/prompts`), {
      params: Promise.resolve({ id: WS }),
    });
  }

  it("정상 조회 시 프롬프트 배열을 반환한다", async () => {
    H.store.prompts.push({
      id: "g1",
      workspaceId: WS,
      text: "조회용 질문",
      tags: [],
      active: true,
      setId: SET_DEFAULT,
      createdAt: new Date(),
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompts).toHaveLength(1);
    expect(body.prompts[0].text).toBe("조회용 질문");
  });

  it("DB 오류 시 응답 본문에 원문 메시지 없이 고정 오류 코드만 반환한다(보안 점검 F1)", async () => {
    // 실제로 postgres 오류 문구엔 테이블·컬럼명 등 내부 스키마 정보가 담길 수 있다(CWE-209).
    H.setSelectFail(
      new Error(
        'Failed query: select * from "prompts" where "workspace_id" = $1 -- params: ["' +
          WS +
          '"] — column "workspace_id" does not exist',
      ),
    );
    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/Failed query|select .* from|does not exist|params:/i);
    expect(body).toEqual({ error: "prompts_list_failed" });
  });
});

describe("POST /api/workspaces/:id/prompts — 세트 (계획 prompt-sets-plan-v2 §4)", () => {
  it("setId 없이 추가 → 기본 세트로 들어간다", async () => {
    const res = await post({ text: "기본 세트 질문" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt.setId).toBe(SET_DEFAULT);
    expect(body.alreadyInSet).toBeUndefined();
    expect(H.resolveTargetSet).toHaveBeenCalledWith(expect.anything(), WS, undefined);
  });

  it("setId 를 주면 그 세트로 들어간다", async () => {
    const res = await post({ text: "새 세트 질문", setId: SET_OTHER });
    expect(res.status).toBe(201);
    expect((await res.json()).prompt.setId).toBe(SET_OTHER);
    expect(H.resolveTargetSet).toHaveBeenCalledWith(expect.anything(), WS, SET_OTHER);
  });

  it("다른 세트에 켜진 같은 문장 → 세트를 바꾸지 않고 alreadyInSet 으로 알린다", async () => {
    H.store.prompts.push({
      id: "on-1", workspaceId: WS, text: "이미 기존 세트", tags: [], active: true, setId: SET_DEFAULT, createdAt: new Date(),
    });
    H.setLookup({ id: SET_DEFAULT, name: "기존 세트" });
    const res = await post({ text: "이미 기존 세트", setId: SET_OTHER });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt.setId).toBe(SET_DEFAULT);
    expect(body.alreadyInSet).toEqual({ id: SET_DEFAULT, name: "기존 세트" });
    expect(H.store.prompts[0].setId).toBe(SET_DEFAULT);
  });

  it("꺼진 같은 문장 → 다시 켜지고 요청한 세트로 옮겨진다", async () => {
    H.store.prompts.push({
      id: "off-1", workspaceId: WS, text: "꺼진 문장", tags: [], active: false, setId: SET_DEFAULT, createdAt: new Date(),
    });
    const res = await post({ text: "꺼진 문장", setId: SET_OTHER });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt.active).toBe(true);
    expect(body.prompt.setId).toBe(SET_OTHER);
    expect(body.alreadyInSet).toBeUndefined();
  });

  it("세트 번호 형식이 틀리면 DB 를 타기 전에 400", async () => {
    const res = await post({ text: "형식 틀림", setId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(H.resolveTargetSet).not.toHaveBeenCalled();
    expect(H.store.prompts).toHaveLength(0);
  });

  it("다른 워크스페이스 세트 → 400 invalid_set + 쉬운 안내", async () => {
    const { PromptSetError, SET_HINTS } = await import("@/lib/server/prompt-sets");
    H.resolveTargetSet.mockRejectedValueOnce(new PromptSetError(400, "invalid_set", SET_HINTS.invalidSet));
    const res = await post({ text: "남의 세트", setId: SET_OTHER });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_set", hint: SET_HINTS.invalidSet });
  });

  it("세트가 방금 지워졌다(외래 키 위반) → 409 set_gone, SQL 원문 없음", async () => {
    const original = H.db.insert;
    H.db.insert = (() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.reject(
              Object.assign(new Error('Failed query: insert into "prompts" ...'), {
                cause: { code: "23503", constraint_name: "prompts_set_id_prompt_sets_id_fk" },
              }),
            ),
        }),
      }),
    })) as unknown as typeof H.db.insert;
    try {
      const res = await post({ text: "지워진 세트로", setId: SET_OTHER });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("set_gone");
      expect(JSON.stringify(body)).not.toMatch(/Failed query|prompts_set_id/);
    } finally {
      H.db.insert = original;
    }
  });
});
