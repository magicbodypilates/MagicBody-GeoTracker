/**
 * overview/route.test.ts — 넓은 구간 방어(M1)·폴링 생략(M4) 동작 테스트.
 *
 * 검수 지적의 핵심은 "연관 출처 쿼리 하나가 실패하면 화면이 통째로 비어 버린다" 였다.
 * 그 동작은 문서로는 확인되지 않으므로 라우트 핸들러를 **실제로 호출해** 확인한다.
 * DB·인증만 대역으로 바꾸고 파싱·분기·응답 조립은 실제 코드가 돈다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const AGG = {
  sampleCount: 100,
  avgVisibility: 42.5,
  mainMentioned: 30,
  cited: 12,
  positive: 40,
  neutral: 50,
  negative: 5,
  notMentioned: 5,
};

/** 연관 출처(확장) 쿼리 호출 횟수·동작 제어 */
const relatedCalls = { count: 0, shouldThrow: false };

vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ user: { id: "u1" } }),
  assertWorkspaceAccess: async () => null,
}));

vi.mock("@/lib/server/branded-query-filter", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/branded-query-filter")>()),
  getBrandTermsForWorkspace: async () => ["매직바디"],
}));

vi.mock("@/lib/server/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/server/db")>();
  /** drizzle SQL 객체에서 리터럴 문자열 조각만 모은다(순환 참조 회피). */
  const literals = (stmt: unknown): string => {
    const chunks = (stmt as { queryChunks?: unknown[] })?.queryChunks ?? [];
    let out = "";
    for (const ch of chunks) {
      const v = (ch as { value?: unknown })?.value;
      if (typeof v === "string") out += v;
      else if (Array.isArray(v)) out += v.filter((x) => typeof x === "string").join("");
    }
    return out;
  };
  return {
    ...actual,
    db: {
      transaction: async (cb: (t: unknown) => Promise<unknown>) => {
        const local = {
          execute: vi.fn(async (stmt: unknown) => {
            const text = literals(stmt);
            if (text.includes("SET LOCAL")) return [];
            // 연관 출처 확장 쿼리만 센다
            if (text.includes("jsonb_array_elements")) {
              relatedCalls.count += 1;
              if (relatedCalls.shouldThrow) {
                throw new Error("canceling statement due to statement timeout");
              }
            }
            return [];
          }),
          select: () => ({ from: () => ({ where: async () => [AGG] }) }),
        };
        return cb(local);
      },
    },
  };
});

const { GET } = await import("./route");

const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/workspaces/ws-1/stats/overview?${qs}`), {
    params: Promise.resolve({ id: "ws-1" }),
  });

beforeEach(() => {
  relatedCalls.count = 0;
  relatedCalls.shouldThrow = false;
});

describe("overview — 넓은 구간 방어(M1)", () => {
  it("구간이 상한(365일)을 넘으면 연관 출처를 계산하지 않고 나머지는 정상 반환", async () => {
    const res = await call("from=2024-09-01&to=2026-08-21");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relatedStatus).toBe("skipped");
    expect(body.brandSignals.related).toBeNull();
    // 카드가 통째로 비지 않는다 — 기본 집계는 그대로
    expect(body.sampleCount).toBe(100);
    expect(body.brandSignals.mainMentioned).toBe(30);
    expect(body.sentiment.positive).toBe(40);
    expect(relatedCalls.count).toBe(0); // 무거운 쿼리 자체를 돌리지 않았다
  });

  it("연관 출처 쿼리가 실패해도 200 — 그 카드만 계산 불가로 떨어진다", async () => {
    relatedCalls.shouldThrow = true;
    const res = await call("from=2026-08-01&to=2026-08-21");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relatedStatus).toBe("failed");
    expect(body.brandSignals.related).toBeNull();
    expect(body.sampleCount).toBe(100);
    expect(body.avgVisibility).toBe(42.5);
  });

  it("상한 안쪽 구간은 평소대로 계산한다", async () => {
    const res = await call("from=2026-08-01&to=2026-08-21");
    const body = await res.json();
    expect(body.relatedStatus).toBe("ok");
    expect(body.brandSignals.related).toBe(0);
    expect(relatedCalls.count).toBe(1);
  });
});

describe("overview — 폴링 부하 분리(M4)", () => {
  it("includeRelated=false 면 확장 쿼리를 돌리지 않는다", async () => {
    const res = await call("from=2026-08-01&to=2026-08-21&includeRelated=false");
    const body = await res.json();
    expect(body.relatedStatus).toBe("omitted");
    expect(body.brandSignals.related).toBeNull();
    expect(relatedCalls.count).toBe(0);
    // 기본 집계는 폴링에서도 갱신된다
    expect(body.sampleCount).toBe(100);
  });
});

describe("overview — runMode 폴백 통일(m4)", () => {
  it("미지정이면 auto, auto=false 면 all (timeseries 와 같은 규칙)", async () => {
    expect((await (await call("days=7")).json()).runMode).toBe("auto");
    expect((await (await call("days=7&auto=false")).json()).runMode).toBe("all");
    expect((await (await call("days=7&runMode=manual")).json()).runMode).toBe("manual");
  });
});

describe("overview — 미래 종료일(m3)", () => {
  it("종료일이 미래면 오늘로 잘라 조회한다(400 아님)", async () => {
    const res = await call("from=2026-08-01&to=2099-01-01");
    expect(res.status).toBe(200);
  });

  it("시작일이 미래면 400", async () => {
    const res = await call("from=2099-01-01&to=2099-01-02");
    expect(res.status).toBe(400);
  });
});
