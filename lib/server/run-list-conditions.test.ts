/**
 * run-list-conditions.test.ts — 응답 목록 조건 조립 (계획 geotracker-response-archive-260924 §6-1).
 *
 * ① 순수 함수 — 실제 PgDialect 로 렌더해 archived 인자별 조건을 고정한다.
 * ② 라우트 — GET /api/workspaces/:id/runs 의 목록 쿼리와 건수 쿼리가 **같은 조건**을 쓰는지
 *    (두 WHERE 의 렌더 결과·파라미터가 완전히 같은지) 가짜 DB 로 확인한다.
 * ⚠️ PUBLIC 저장소 — 문구는 가짜 값이다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildRunsListConditions, parseRunsArchivedFilter } from "./run-list-conditions";

const H = vi.hoisted(() => {
  const wheres: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          wheres.push(w);
          const chain = {
            orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve([{ count: 0 }]).then(resolve, reject),
          };
          return chain;
        },
      }),
    }),
  };
  return { wheres, db };
});

vi.mock("@/lib/server/db", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, db: H.db };
});
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "user", role: 1, uid: "u1" }),
  assertWorkspaceAccess: async () => null,
}));

const dialect = new PgDialect();
const WS = "11111111-1111-4111-8111-111111111111";
const render = (conds: SQL[]) => dialect.sqlToQuery(and(...conds)!);
const sp = (q: string) => new URLSearchParams(q);

describe("archived 인자 해석", () => {
  it("only · include 외에는 기본(보관 제외)", () => {
    expect(parseRunsArchivedFilter(null)).toBe("exclude");
    expect(parseRunsArchivedFilter("only")).toBe("only");
    expect(parseRunsArchivedFilter("include")).toBe("include");
    expect(parseRunsArchivedFilter("ONLY")).toBe("exclude");
    expect(parseRunsArchivedFilter("true")).toBe("exclude");
    expect(parseRunsArchivedFilter("")).toBe("exclude");
  });
});

describe("buildRunsListConditions — 보관 조건", () => {
  it("인자 없음 → 보관 제외(archived_at is null)", () => {
    const q = render(buildRunsListConditions(WS, sp("")));
    expect(q.sql).toContain('"archived_at" is null');
    expect(q.sql).not.toContain('"archived_at" is not null');
  });

  it("archived=only → 보관만(archived_at is not null)", () => {
    const q = render(buildRunsListConditions(WS, sp("archived=only")));
    expect(q.sql).toContain('"archived_at" is not null');
  });

  it("archived=include → 보관 조건 없음", () => {
    const q = render(buildRunsListConditions(WS, sp("archived=include")));
    expect(q.sql).not.toContain("archived_at");
  });

  it("모르는 값 → 기본(보관 제외)", () => {
    const q = render(buildRunsListConditions(WS, sp("archived=all")));
    expect(q.sql).toContain('"archived_at" is null');
  });

  it("prompt 필터와 함께 — 문구는 정확 일치 파라미터로, 보관 조건도 함께", () => {
    const text = " 가짜 질문 A ";
    const q = render(buildRunsListConditions(WS, sp(`archived=only&prompt=${encodeURIComponent(text)}`)));
    expect(q.sql).toContain('"prompt_text" = $');
    expect(q.sql).toContain('"archived_at" is not null');
    expect(q.params).toContain(text);
    expect(q.params).toContain(WS);
  });

  it("기존 필터(from·to·provider·auto)는 그대로 — 틀린 날짜는 무시", () => {
    const q = render(
      buildRunsListConditions(WS, sp("from=2031-01-01T00:00:00Z&to=nope&provider=chatgpt&auto=false")),
    );
    expect(q.sql).toContain('"created_at" >=');
    expect(q.sql).not.toContain('"created_at" <=');
    expect(q.sql).toContain('"provider" =');
    expect(q.sql).toContain('"is_auto" =');
    expect(q.params).toContain("chatgpt");
    expect(q.params).toContain(false);
  });
});

describe("GET /api/workspaces/:id/runs — 목록·건수가 같은 조건을 쓴다", () => {
  beforeEach(() => {
    H.wheres.length = 0;
  });

  async function get(query: string) {
    const { GET } = await import("@/app/api/workspaces/[id]/runs/route");
    return GET(new NextRequest(`http://localhost/api/workspaces/${WS}/runs?${query}`), {
      params: Promise.resolve({ id: WS }),
    });
  }

  for (const query of ["limit=20", "archived=only&prompt=%EA%B0%80%EC%A7%9C", "archived=include&auto=true"]) {
    it(`?${query} → 두 쿼리의 WHERE 가 글자·파라미터까지 같다`, async () => {
      const res = await get(query);
      expect(res.status).toBe(200);
      expect(H.wheres).toHaveLength(2);
      const [a, b] = H.wheres.map((w) => dialect.sqlToQuery(w as SQL));
      expect(a.sql).toBe(b.sql);
      expect(a.params).toEqual(b.params);
    });
  }

  it("기본 호출은 보관 응답을 빼고 센다", async () => {
    await get("limit=20");
    const [a] = H.wheres.map((w) => dialect.sqlToQuery(w as SQL));
    expect(a.sql).toContain('"archived_at" is null');
  });
});
