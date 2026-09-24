/**
 * route.test.ts — POST /api/workspaces/:id/reset-responses 범위값·권한 (계획 geotracker-response-archive-260924
 * §S5 · §6-1 · 결함 대장 A10).
 *
 * 예전 결함: all·auto 일 때만 권한을 확인하고, 그 밖의 값은 마지막 "전체 삭제" 분기로 떨어졌다 —
 * 일반관리자가 ?scope=아무값 한 번으로 운영 워크스페이스 이력을 전부 지울 수 있었다.
 *
 * DB 는 삭제 호출을 기록만 하는 가짜(스키마는 실제), 삭제 조건은 실제 PgDialect 로 렌더해 본다.
 * auth-guard 는 getSession·assertWorkspaceAccess 만 스파이로 바꾸고 requireAdmin 은 실제 함수다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const H = vi.hoisted(() => {
  const deletes: { table: unknown; where?: unknown }[] = [];
  let failWith: Error | null = null;
  const db = {
    delete: (table: unknown) => {
      const call: { table: unknown; where?: unknown } = { table };
      deletes.push(call);
      const api = {
        where: (w: unknown) => {
          call.where = w;
          return api;
        },
        returning: () => (failWith ? Promise.reject(failWith) : Promise.resolve([{ id: "x" }])),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          (failWith ? Promise.reject(failWith) : Promise.resolve([])).then(resolve, reject),
      };
      return api;
    },
  };
  return {
    deletes,
    db,
    setFail: (e: Error | null) => {
      failWith = e;
    },
  };
});

vi.mock("@/lib/server/db", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, db: H.db };
});

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: () => getSessionMock(),
    assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
  };
});

const { POST } = await import("./route");
const { schema } = await import("@/lib/server/db");

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = { kind: "user", role: 1, uid: "u1" };
const ADMIN = { kind: "admin", role: 0 };
const dialect = new PgDialect();

function post(qs: string) {
  return POST(new NextRequest(`http://localhost/api/workspaces/${WS}/reset-responses${qs}`, { method: "POST" }), {
    params: Promise.resolve({ id: WS }),
  });
}

beforeEach(() => {
  H.deletes.length = 0;
  H.setFail(null);
  getSessionMock.mockReset();
  assertWorkspaceAccessMock.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("일반관리자(kind=user)", () => {
  beforeEach(() => getSessionMock.mockResolvedValue(USER));

  for (const qs of ["", "?scope=all", "?scope=auto", "?scope=ALL", "?scope=Auto"]) {
    it(`${qs || "(인자 없음)"} → 403(중립 안내), 아무것도 지우지 않는다`, async () => {
      const res = await post(qs);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden", hint: "이 작업을 할 권한이 없습니다" });
      expect(H.deletes).toHaveLength(0);
    });
  }

  for (const qs of ["?scope=invalid", "?scope=manualx", "?scope=", "?scope=all%20", "?scope=%EC%A0%84%EC%B2%B4"]) {
    it(`${qs} → 400 invalid_scope, 아무것도 지우지 않는다`, async () => {
      const res = await post(qs);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_scope" });
      expect(H.deletes).toHaveLength(0);
    });
  }

  it("?scope=manual → 허용, 수동이면서 보관되지 않은 응답만 지운다", async () => {
    const res = await post("?scope=manual");
    expect(res.status).toBe(200);
    expect(H.deletes).toHaveLength(1);
    expect(H.deletes[0].table).toBe(schema.runs);
    const q = dialect.sqlToQuery(H.deletes[0].where as SQL);
    expect(q.sql).toContain('"archived_at" is null');
    expect(q.sql).toContain('"is_auto" =');
    expect(q.params).toContain(WS);
    expect(q.params).toContain(false);
  });

  it("?scope=MANUAL(대문자) → manual 과 같다", async () => {
    const res = await post("?scope=MANUAL");
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe("manual");
  });

  it("워크스페이스 권한이 먼저 — 거부되면 범위값과 무관하게 그 응답", async () => {
    const { NextResponse } = await import("next/server");
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await post("?scope=invalid");
    expect(res.status).toBe(403);
    expect(H.deletes).toHaveLength(0);
  });
});

describe("삭제 권한(kind=admin)", () => {
  beforeEach(() => getSessionMock.mockResolvedValue(ADMIN));

  it("알 수 없는 값 → 400, 아무것도 지우지 않는다", async () => {
    const res = await post("?scope=everything");
    expect(res.status).toBe(400);
    expect(H.deletes).toHaveLength(0);
  });

  it("?scope=all → 응답·감사·알림·일별 집계를 모두 지운다(보관 응답 포함)", async () => {
    const res = await post("?scope=all");
    expect(res.status).toBe(200);
    expect(H.deletes.map((d) => d.table)).toEqual([schema.runs, schema.auditHistory, schema.driftAlerts, schema.dailyStats]);
    const runsWhere = dialect.sqlToQuery(H.deletes[0].where as SQL).sql;
    expect(runsWhere).not.toContain("archived_at");
  });

  it("인자 없음 → all 로 실행", async () => {
    const res = await post("");
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe("all");
  });

  it("?scope=auto → 자동 응답(보관 포함)·일별 집계를 지운다", async () => {
    const res = await post("?scope=auto");
    expect(res.status).toBe(200);
    expect(H.deletes.map((d) => d.table)).toEqual([schema.runs, schema.dailyStats]);
    expect(dialect.sqlToQuery(H.deletes[0].where as SQL).sql).not.toContain("archived_at");
  });

  it("DB 오류 → 500 고정 코드, 본문에 원문 없음", async () => {
    H.setFail(new Error('Failed query: delete from "runs" where ...'));
    const res = await post("?scope=manual");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "reset_failed" });
  });
});
