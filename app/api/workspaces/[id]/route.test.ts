/**
 * route.test.ts — PATCH /api/workspaces/:id 의 채점 스위치(brandConfig.scoringSetSwitch) 계약.
 *
 * 2026-09-25 결함 D2 — 이 라우트의 검증은 ["v14a","v15a"] 만 받아, 운영 값 "v17a" 를 PATCH 로
 * 저장하거나 그대로 되돌려 보내면 400 으로 튕겼다. 확인하는 것:
 *   1. 허용 값 정본(SCORING_SET_SWITCH_VALUES) 네 값을 모두 저장할 수 있다.
 *   2. 화면 설정 저장(스위치 없이 브랜드 6칸만 보냄)은 기존 스위치를 지우지 않는다(병합 보존).
 *   3. 현재 값 "v17a" 를 담아 되돌려 보내도 저장된다.
 *   4. 모르는 값은 400 이고 저장 값은 그대로다.
 * DB·인증은 가짜다. ⚠️ PUBLIC 저장소 — 브랜드·도메인은 가짜 값만 쓴다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type WsRow = { id: string; name: string; brandConfig: Record<string, unknown> };

const H = vi.hoisted(() => {
  const store: { workspaces: WsRow[] } = { workspaces: [] };
  type Pred = { op: "eq"; col: { name: string }; val: unknown };
  const col = (name: string) => ({ __col: true as const, name });
  const schema = { workspaces: { __table: "workspaces", id: col("id") } };
  const match = (row: Record<string, unknown>, pred?: Pred) => !pred || row[pred.col.name] === pred.val;

  const db = {
    select: () => {
      let pred: Pred | undefined;
      const api = {
        from: () => api,
        where: (p: Pred) => {
          pred = p;
          return api;
        },
        limit: (n: number) =>
          Promise.resolve(
            store.workspaces
              .filter((r) => match(r, pred))
              .slice(0, n)
              .map((r) => structuredClone(r)),
          ),
      };
      return api;
    },
    update: () => {
      let vals: Record<string, unknown> = {};
      let pred: Pred | undefined;
      const api = {
        set: (v: Record<string, unknown>) => {
          vals = v;
          return api;
        },
        where: (p: Pred) => {
          pred = p;
          return api;
        },
        returning: () => {
          const rows = store.workspaces.filter((r) => match(r, pred));
          for (const r of rows) Object.assign(r, vals);
          return Promise.resolve(rows.map((r) => structuredClone(r)));
        },
      };
      return api;
    },
  };
  return { store, schema, db, eq: (c: { name: string }, val: unknown): Pred => ({ op: "eq", col: c, val }) };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, eq: H.eq };
});
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ kind: "admin", role: 0 }),
  assertWorkspaceAccess: async () => null,
  requireAdmin: () => null,
}));

import { PATCH } from "./route";
import { SCORING_SET_SWITCH_VALUES } from "@/drizzle/schema";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND_6 = {
  brandName: "예시브랜드",
  brandAliases: "ExampleBrand",
  websites: ["https://brand.example"],
  industry: "",
  keywords: "",
  description: "",
};

function patch(body: unknown) {
  const req = new NextRequest(`http://127.0.0.1:3000/api/workspaces/${WS}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id: WS }) });
}

beforeEach(() => {
  H.store.workspaces = [{ id: WS, name: "시험", brandConfig: { ...BRAND_6, scoringSetSwitch: "v17a" } }];
});

describe("PATCH /api/workspaces/:id — 채점 스위치 (결함 D2)", () => {
  it.each([...SCORING_SET_SWITCH_VALUES])("허용 값 %s 를 저장할 수 있다", async (v) => {
    const res = await patch({ brandConfig: { scoringSetSwitch: v } });
    expect(res.status).toBe(200);
    expect(H.store.workspaces[0].brandConfig.scoringSetSwitch).toBe(v);
  });

  it("화면 설정 저장(브랜드 6칸만)은 기존 스위치 v17a 를 지우지 않는다", async () => {
    const res = await patch({ brandConfig: { ...BRAND_6, keywords: "새 키워드" } });
    expect(res.status).toBe(200);
    expect(H.store.workspaces[0].brandConfig).toMatchObject({ keywords: "새 키워드", scoringSetSwitch: "v17a" });
  });

  it("현재 값 v17a 를 담아 통째로 되돌려 보내도 저장된다(예전엔 400)", async () => {
    const res = await patch({ brandConfig: { ...BRAND_6, description: "소개", scoringSetSwitch: "v17a" } });
    expect(res.status).toBe(200);
    expect(H.store.workspaces[0].brandConfig).toMatchObject({ description: "소개", scoringSetSwitch: "v17a" });
  });

  it("모르는 값은 400 이고 저장 값은 그대로다", async () => {
    const res = await patch({ brandConfig: { scoringSetSwitch: "v99a" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_input");
    expect(H.store.workspaces[0].brandConfig.scoringSetSwitch).toBe("v17a");
  });
});
