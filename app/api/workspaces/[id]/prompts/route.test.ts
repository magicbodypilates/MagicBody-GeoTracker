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
  createdAt: Date;
};

const H = vi.hoisted(() => {
  const store: { prompts: PromptRow[] } = { prompts: [] };
  let seq = 1;

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
          Object.assign(existing, conflictSet);
          return Promise.resolve([{ ...existing }]);
        }
        const row: PromptRow = {
          id: `id-${seq++}`,
          workspaceId: vals!.workspaceId!,
          text: vals!.text!,
          tags: vals!.tags ?? [],
          active: vals!.active ?? true,
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
  };

  const schema = {
    prompts: {
      workspaceId: { __col: true, name: "workspaceId" },
      text: { __col: true, name: "text" },
    },
  };

  return {
    store,
    db,
    schema,
    reset: () => {
      store.prompts = [];
      seq = 1;
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "admin", role: 0 }),
  assertWorkspaceAccess: async () => null,
}));

const { POST } = await import("./route");

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
  vi.spyOn(console, "error").mockImplementation(() => {});
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
