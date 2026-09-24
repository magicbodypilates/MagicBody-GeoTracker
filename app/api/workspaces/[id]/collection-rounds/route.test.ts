/**
 * route.test.ts — GET /api/workspaces/:id/collection-rounds 단위 테스트 (계획 geotracker-collect-speed-260924 §8-2 · §11).
 * 권한·입력 검사·엔진 분기를 확인한다. 요청 번호·원문 오류 미노출은 실제 DB 로
 * lib/server/collector-routes.int.test.ts 가 확인한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
}));

const overviewMock = vi.fn();
vi.mock("@/lib/server/collector-engine", () => ({
  getRoundsOverview: (...args: unknown[]) => overviewMock(...args),
}));

const { GET } = await import("./route");

const WS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SCHED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function get(query = "") {
  return GET(new NextRequest(`http://localhost/api/workspaces/${WS}/collection-rounds${query}`), {
    params: Promise.resolve({ id: WS }),
  });
}

beforeEach(() => {
  getSessionMock.mockReset().mockResolvedValue({ kind: "user", role: 1, uid: "u1" });
  assertWorkspaceAccessMock.mockReset().mockResolvedValue(null);
  overviewMock.mockReset().mockResolvedValue([]);
  vi.stubEnv("GEO_COLLECTOR_ENGINE", "queue");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/workspaces/:id/collection-rounds", () => {
  it("권한 없음 → 그 응답 그대로(403), 조회하지 않는다", async () => {
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await get();
    expect(res.status).toBe(403);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS, { kind: "user", role: 1, uid: "u1" });
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("로그인 없음 → 401", async () => {
    getSessionMock.mockResolvedValue(null);
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("기본 limit 10, scheduleId 전달", async () => {
    await get();
    expect(overviewMock).toHaveBeenLastCalledWith(WS, { limit: 10 });
    await get(`?limit=5&scheduleId=${SCHED}`);
    expect(overviewMock).toHaveBeenLastCalledWith(WS, { limit: 5, scheduleId: SCHED });
  });

  it.each(["?limit=0", "?limit=51", "?limit=abc", "?scheduleId=not-a-uuid"])("잘못된 입력 %s → 400", async (q) => {
    const res = await get(q);
    expect(res.status).toBe(400);
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("엔진이 legacy 면 빈 목록(회차 표를 조회하지 않는다)", async () => {
    vi.stubEnv("GEO_COLLECTOR_ENGINE", "legacy");
    const res = await get();
    expect(await res.json()).toEqual({ engine: "legacy", rounds: [] });
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("queue 면 { engine, rounds } 그대로", async () => {
    overviewMock.mockResolvedValue([{ id: "r1", counts: { saved: 1 } }]);
    const body = await (await get()).json();
    expect(body).toEqual({ engine: "queue", rounds: [{ id: "r1", counts: { saved: 1 } }] });
  });

  it("조회 오류 → 500 고정 코드(SQL 원문 없음)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    overviewMock.mockRejectedValue(new Error("Failed query: select ... params: 비밀"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "collection_rounds_failed" });
  });
});
