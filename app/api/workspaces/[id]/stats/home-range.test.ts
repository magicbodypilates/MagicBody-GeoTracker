/**
 * home-range.test.ts — 홈 화면이 쓰는 stats 라우트 6종의 조회 구간 계약 테스트.
 *
 * 왜 라우트 핸들러를 직접 호출하나:
 *   로컬에는 GeoTracker DB 가 없어 숫자를 눈으로 확인할 수 없다. 그래서 DB·인증만 대역으로
 *   바꾸고 **파싱·분기·WHERE 조립·응답 조립은 실제 코드가 돌게** 해서 두 가지를 고정한다.
 *     1) 기존 `?days=N` 동작 무회귀 — 홈이 지금 이 계약으로 돌아가고 있다.
 *     2) 신규 `?from=&to=` 가 KST 일자 양끝 포함 구간으로 번역되는지.
 *     3) 넓은 구간 방어(skipped) · 부분 실패(failed) 가 200 을 유지하는지.
 *
 * WHERE 에 실제로 들어간 시각은 drizzle SQL 객체를 재귀 순회해 Date 값만 모아 확인한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 각 라우트가 조립한 WHERE 에서 뽑아낸 Date 값들 (호출 순서대로) */
const capturedDates: Date[][] = [];
/** runs 테이블 조회가 반환할 행 · 예외 제어 */
const runsBehavior: { rows: unknown[]; throwOnFullRows: boolean } = {
  rows: [],
  throwOnFullRows: false,
};
/** benchmark 가 읽는 경쟁사 목록 */
let competitorRows: unknown[] = [];

/** 순환 참조를 피하며 객체 트리에서 Date 만 모은다. */
function collectDates(node: unknown, out: Date[] = [], seen = new Set<unknown>()): Date[] {
  if (node === null || typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (node instanceof Date) {
    out.push(node);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) collectDates(v, out, seen);
  return out;
}

vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => ({ user: { id: "u1" } }),
  assertWorkspaceAccess: async () => null,
}));

/** 워크스페이스에 설정된 브랜드 별칭 — 테스트에서 "미설정" 상태를 만들 수 있게 변수로 둔다. */
let brandTerms: string[] = ["매직바디"];

vi.mock("@/lib/server/branded-query-filter", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/branded-query-filter")>()),
  getBrandTermsForWorkspace: async () => brandTerms,
}));

vi.mock("@/lib/server/brand-youtube-videos", () => ({
  getOwnedYoutubeVideoIds: async () => new Set<string>(),
}));

vi.mock("@/lib/server/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/server/db")>();
  const { schema } = actual;

  /** 어떤 테이블을 조회했는지에 따라 행을 돌려주는 체이너블 대역 */
  function makeSelect(fields?: Record<string, unknown>) {
    let table: unknown = null;
    let fullRowRead = false;
    const builder = {
      from(t: unknown) {
        table = t;
        // answer/citations 등 행 자체를 읽는 조회인지 판별 (무거운 쿼리 실패 시뮬레이션용)
        fullRowRead = !!fields && Object.keys(fields).some((k) => k === "answer" || k === "citations");
        return builder;
      },
      where(w: unknown) {
        capturedDates.push(collectDates(w));
        return builder;
      },
      groupBy: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      then(res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) {
        if (table === schema.runs && fullRowRead && runsBehavior.throwOnFullRows) {
          return Promise.reject(
            new Error("canceling statement due to statement timeout"),
          ).then(res, rej);
        }
        if (table === schema.runs) return Promise.resolve(runsBehavior.rows).then(res, rej);
        if (table === schema.competitors) return Promise.resolve(competitorRows).then(res, rej);
        if (table === schema.workspaces) {
          return Promise.resolve([{ brandConfig: { websites: [] } }]).then(res, rej);
        }
        if (table === schema.schedules) return Promise.resolve([{ count: 0 }]).then(res, rej);
        return Promise.resolve([]).then(res, rej);
      },
    };
    return builder;
  }

  const tx = { execute: async () => [], select: makeSelect };
  // 집계는 트랜잭션이 아니라 runStatsQuery(읽기 전용 연결) 를 거친다 — 대역도 같은 형태로 준다.
  const statsClient = { execute: async () => [], select: makeSelect };
  return {
    ...actual,
    db: {
      select: makeSelect,
      transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    },
    statsDb: statsClient,
    runStatsQuery: (fn: (q: unknown) => Promise<unknown>) => Promise.resolve(fn(statsClient)),
  };
});

const { GET: ranking } = await import("./ranking/route");
const { GET: benchmark } = await import("./benchmark/route");
const { GET: heatmap } = await import("./heatmap/route");
const { GET: citations } = await import("./citations/route");
const { GET: providers } = await import("./providers/route");
const { GET: branded } = await import("./branded/route");

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

const ROUTES: Array<[string, Handler]> = [
  ["ranking", ranking as Handler],
  ["benchmark", benchmark as Handler],
  ["heatmap", heatmap as Handler],
  ["citations", citations as Handler],
  ["providers", providers as Handler],
  ["branded", branded as Handler],
];

function call(name: string, handler: Handler, qs: string) {
  return handler(
    new NextRequest(`http://localhost/api/workspaces/ws-1/stats/${name}?${qs}`),
    { params: Promise.resolve({ id: "ws-1" }) },
  );
}

/** WHERE 에 들어간 구간 — 라우트마다 같은 조건을 여러 번 쓰므로 첫 조회 기준. */
function firstRange(): { from: Date; to: Date } {
  const dates = capturedDates.find((d) => d.length >= 2);
  if (!dates) throw new Error("WHERE 에서 구간을 찾지 못했습니다");
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

beforeEach(() => {
  capturedDates.length = 0;
  runsBehavior.rows = [];
  runsBehavior.throwOnFullRows = false;
  competitorRows = [];
  brandTerms = ["매직바디"];
});

describe("홈 stats 6종 — 기존 days 계약 무회귀", () => {
  for (const [name, handler] of ROUTES) {
    it(`${name}: ?days=7 은 지금으로부터 7×24시간 롤링 윈도우 그대로`, async () => {
      const before = Date.now();
      const res = await call(name, handler, "days=7&auto=true&branded=false");
      expect(res.status).toBe(200);
      const { from, to } = firstRange();
      expect(to.getTime() - from.getTime()).toBe(7 * DAY_MS);
      // 끝은 "지금" — 호출 전후 시각 사이에 있어야 한다
      expect(to.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(to.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      const body = await res.json();
      expect(body.days).toBe(7);
    });

    it(`${name}: days 미지정이면 기본 30일`, async () => {
      const res = await call(name, handler, "auto=true");
      expect(res.status).toBe(200);
      const { from, to } = firstRange();
      expect(to.getTime() - from.getTime()).toBe(30 * DAY_MS);
      expect((await res.json()).days).toBe(30);
    });
  }
});

describe("홈 stats 6종 — from/to 직접 선택", () => {
  for (const [name, handler] of ROUTES) {
    it(`${name}: KST 양끝 포함 구간으로 번역된다`, async () => {
      const res = await call(name, handler, "from=2026-08-01&to=2026-08-03&auto=true");
      expect(res.status).toBe(200);
      const { from, to } = firstRange();
      // 2026-08-01 00:00 KST = 2026-07-31T15:00Z / 종료일 포함 → 2026-08-04 00:00 KST
      expect(from.toISOString()).toBe("2026-07-31T15:00:00.000Z");
      expect(to.toISOString()).toBe("2026-08-03T15:00:00.000Z");
      const body = await res.json();
      expect(body.days).toBe(3);
      expect(body.range.mode).toBe("range");
      expect(body.range.fromDate).toBe("2026-08-01");
      expect(body.range.toDate).toBe("2026-08-03");
    });

    it(`${name}: 시작일만 주면 400`, async () => {
      const res = await call(name, handler, "from=2026-08-01");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("함께 지정");
    });

    it(`${name}: 시작일이 종료일보다 늦으면 400`, async () => {
      const res = await call(name, handler, "from=2026-08-05&to=2026-08-01");
      expect(res.status).toBe(400);
    });

    it(`${name}: 날짜 형식이 틀리면 400`, async () => {
      const res = await call(name, handler, "from=2026-8-1&to=2026-08-03");
      expect(res.status).toBe(400);
    });
  }
});

describe("넓은 구간 방어 — 행을 통째로 읽는 라우트만 계산을 건너뛴다", () => {
  it("citations: 상한(365일) 초과 구간은 계산하지 않고 skipped 로 알린다", async () => {
    const res = await call("citations", citations as Handler, "from=2025-06-01&to=2026-08-21");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("skipped");
    expect(body.domains).toEqual([]);
    // 무거운 쿼리를 아예 돌리지 않았다
    expect(capturedDates.length).toBe(0);
  });

  it("citations: 인용 로드가 실패해도 200 — 이 카드만 계산 불가", async () => {
    runsBehavior.throwOnFullRows = true;
    const res = await call("citations", citations as Handler, "days=30");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.domains).toEqual([]);
  });

  it("benchmark: 상한 초과 구간은 경쟁사 집계만 건너뛰고 브랜드 지표는 그대로", async () => {
    competitorRows = [{ name: "경쟁사A", aliases: [], websites: ["https://a.example"] }];
    runsBehavior.rows = [{ sampleCount: 10, mentionCount: 4, citedCount: 2 }];
    const res = await call("benchmark", benchmark as Handler, "from=2025-06-01&to=2026-08-21");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.competitorStatus).toBe("skipped");
    expect(body.competitors).toEqual([]);
    expect(body.brand.sampleCount).toBe(10);
    expect(body.brand.mentionRate).toBe(0.4);
  });

  it("benchmark: 경쟁사 집계가 실패해도 200 — 브랜드 지표는 그대로", async () => {
    competitorRows = [{ name: "경쟁사A", aliases: [], websites: ["https://a.example"] }];
    runsBehavior.rows = [{ sampleCount: 10, mentionCount: 4, citedCount: 2 }];
    runsBehavior.throwOnFullRows = true;
    const res = await call("benchmark", benchmark as Handler, "days=30");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.competitorStatus).toBe("failed");
    expect(body.competitors).toEqual([]);
    expect(body.brand.sampleCount).toBe(10);
  });

  it("heatmap: 그룹 집계만 하므로 넓은 구간에서도 그대로 계산한다", async () => {
    const res = await call("heatmap", heatmap as Handler, "from=2025-06-01&to=2026-08-21");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range.mode).toBe("range");
    expect(capturedDates.length).toBeGreaterThan(0);
  });
});

/**
 * 검수 지적 MINOR 6 — 계약이 있는데 테스트로 고정돼 있지 않던 세 지점.
 */
describe("남은 계약 고정", () => {
  it("branded: 브랜드 별칭 미설정이면 쿼리를 돌리지 않고 0 통계 + 구간 메타를 돌려준다", async () => {
    brandTerms = [];
    const res = await call("branded", branded as Handler, "from=2026-08-01&to=2026-08-03");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sampleCount).toBe(0);
    expect(body.range.fromDate).toBe("2026-08-01");
    expect(body.range.toDate).toBe("2026-08-03");
    // 조기 반환이므로 집계 쿼리 자체가 나가지 않는다.
    expect(capturedDates.length).toBe(0);
  });

  it("branded: 별칭 미설정이어도 구간이 잘못됐으면 400 이 먼저 나간다", async () => {
    brandTerms = [];
    const res = await call("branded", branded as Handler, "from=2026-08-05&to=2026-08-01");
    expect(res.status).toBe(400);
  });

  it("ranking: limit 기본값은 5, 상한은 20", async () => {
    runsBehavior.rows = Array.from({ length: 30 }, (_, i) => ({
      promptText: `질문 ${i}`,
      sampleCount: 10,
      avgVisibility: i,
      mentionCount: 1,
      citedCount: 0,
    }));

    const dflt = await (await call("ranking", ranking as Handler, "days=30")).json();
    expect(dflt.top).toHaveLength(5);
    expect(dflt.bottom).toHaveLength(5);

    const capped = await (await call("ranking", ranking as Handler, "days=30&limit=999")).json();
    expect(capped.top).toHaveLength(20);

    const asked = await (await call("ranking", ranking as Handler, "days=30&limit=7")).json();
    expect(asked.top).toHaveLength(7);
  });

  it("days 는 365 로 클램프된다 (상한 초과 요청)", async () => {
    const before = Date.now();
    const res = await call("providers", providers as Handler, "days=400");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(365);
    const { from, to } = firstRange();
    expect(to.getTime() - from.getTime()).toBe(365 * DAY_MS);
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
  });
});
