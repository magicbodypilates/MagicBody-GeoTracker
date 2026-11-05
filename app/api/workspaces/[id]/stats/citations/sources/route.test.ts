/**
 * route.test.ts — /api/workspaces/[id]/stats/citations/sources (2026-11-05 · 검수 C4).
 * DB 연결 없이 묶음 조회 결과를 주입해 응답 모양·신규 판정·신규만 보기 실패 처리를 확인한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SessionInfo } from "@/lib/server/auth-guard";

const getSessionMock = vi.fn<() => Promise<SessionInfo>>();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: async (_wsId: string, s: SessionInfo) =>
    s ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 }),
}));

// runStatsQuery 첫 호출 = URL 별 묶음, 두 번째 = 상위 URL 질문
let groupRows: Array<Record<string, unknown>> = [];
let promptRows: Array<Record<string, unknown>> = [];
let queryCalls = 0;
vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/drizzle/schema")>("@/drizzle/schema");
  return {
    schema: actual,
    runStatsQuery: async (fn: (q: { execute: () => Promise<unknown> }) => unknown) =>
      fn({
        execute: async () => {
          queryCalls += 1;
          return queryCalls === 1 ? groupRows : promptRows;
        },
      }),
  };
});

const firstSeenGetMock = vi.fn();
vi.mock("@/lib/server/citation-first-seen", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/citation-first-seen")>(
    "@/lib/server/citation-first-seen",
  );
  // 결과 캐시는 이 테스트에서 끈다(지문 조회 실패 → 캐시 없이 계산) — 캐시 규칙은 citation-rows-cache.test.ts
  return {
    ...actual,
    getFirstSeenCache: () => ({ get: firstSeenGetMock }),
    dbRunsFingerprint: async () => {
      throw new Error("fingerprint off in test");
    },
  };
});

import { GET } from "./route";
import { emptyFirstSeenIndex, mergeFirstSeenRows } from "@/lib/server/citation-first-seen";

const ctx = { params: Promise.resolve({ id: "ws-1" }) };
const req = (q = "") => new NextRequest(`http://localhost/api/workspaces/ws-1/stats/citations/sources${q}`);

beforeEach(() => {
  queryCalls = 0;
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
  firstSeenGetMock.mockReset();
  groupRows = [
    { url: "https://a.com/old", cite_count: 3, first_at: "2026-11-02T00:00:00Z", last_at: "2026-11-04T00:00:00Z", providers: ["chatgpt"] },
    { url: "https://b.com/new", cite_count: 1, first_at: "2026-11-03T00:00:00Z", last_at: "2026-11-03T00:00:00Z", providers: ["gemini"] },
    { url: "https://cdn.jsdelivr.net/x.js", cite_count: 9, first_at: "2026-11-03T00:00:00Z", last_at: "2026-11-03T00:00:00Z", providers: ["gemini"] },
  ];
  promptRows = [
    { url: "https://a.com/old", prompt_text: "질문1", last_at: "2026-11-04T00:00:00Z" },
    { url: "https://b.com/new", prompt_text: "질문2", last_at: "2026-11-03T00:00:00Z" },
  ];
});

describe("/stats/citations/sources", () => {
  it("로그인 없음 401 · 모르는 모델 400 · 시작일만 400", async () => {
    getSessionMock.mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(401);
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    expect((await GET(req("?provider=zzz"), ctx)).status).toBe(400);
    expect((await GET(req("?from=2026-11-01"), ctx)).status).toBe(400);
  });

  it("기간 검색 — 잡 주소 거름 · 질문 붙임 · 신규 판정", async () => {
    const idx = mergeFirstSeenRows(emptyFirstSeenIndex(), [
      { key: "https://a.com/old", provider: "chatgpt", ms: Date.parse("2026-09-01T00:00:00Z") },
    ]);
    firstSeenGetMock.mockResolvedValue({ index: idx, action: "hit" });
    const res = await GET(req("?from=2026-11-01&to=2026-11-05"), ctx);
    const body = await res.json();
    expect(body.newStatus).toBe("ok");
    expect(body.items.map((i: { url: string }) => i.url)).toEqual(["https://a.com/old", "https://b.com/new"]);
    expect(body.items[0].isNew).toBe(false);
    expect(body.items[1].isNew).toBe(true);
    expect(body.items[0].prompts).toEqual(["질문1"]);
    expect(body.newUrlCount).toBe(1);
  });

  it("C4: 신규만 보기 + 최초 인용 계산 실패 → 거르지 않은 목록을 주지 않는다", async () => {
    firstSeenGetMock.mockRejectedValue(new Error("statement timeout"));
    const res = await GET(req("?from=2026-11-01&to=2026-11-05&newOnly=true"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newOnly).toBe(true);
    expect(body.newStatus).toBe("unavailable");
    expect(body.items).toEqual([]);
  });

  it("신규만 보기가 아니면 계산 실패여도 목록은 보여준다(신규 표시만 빠짐)", async () => {
    firstSeenGetMock.mockRejectedValue(new Error("timeout"));
    const body = await (await GET(req("?from=2026-11-01&to=2026-11-05"), ctx)).json();
    expect(body.newStatus).toBe("unavailable");
    expect(body.items).toHaveLength(2);
    expect(body.items[0].isNew).toBeUndefined();
  });
});
