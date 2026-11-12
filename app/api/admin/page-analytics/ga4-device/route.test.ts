/**
 * route.test.ts — /api/admin/page-analytics/ga4-device 권한·입력·상태 응답 (구글·DB 연결 없음)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SessionInfo } from "@/lib/server/auth-guard";

const getSessionMock = vi.fn<() => Promise<SessionInfo>>();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  requireAdmin: (session: SessionInfo): NextResponse | null => {
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (session.kind !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return null;
  },
}));

const propertyIdMock = vi.fn<() => string | null>();
vi.mock("@/lib/server/ga4-client", () => ({
  getDefaultPropertyId: () => propertyIdMock(),
}));

const fetchMock = vi.fn();
vi.mock("@/lib/server/ga4-device", () => ({
  fetchDeviceCategoryReport: (...args: unknown[]) => fetchMock(...args),
}));

import { GET } from "./route";

const req = (qs: string) => new NextRequest(`http://localhost/api/admin/page-analytics/ga4-device?${qs}`);

beforeEach(() => {
  getSessionMock.mockReset();
  propertyIdMock.mockReset();
  fetchMock.mockReset();
  propertyIdMock.mockReturnValue("123");
});

describe("권한", () => {
  it("미로그인 → 401, 구글·보관 조회 안 함", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("상위 권한 아님 → 403, 구글·보관 조회 안 함", async () => {
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u" } as SessionInfo);
    const res = await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("입력", () => {
  beforeEach(() => getSessionMock.mockResolvedValue({ kind: "admin", role: 0 } as SessionInfo));
  it.each([
    "",
    "fromKst=2026-11-01",
    "fromKst=2026-11-10&toKst=2026-11-01",
    "fromKst=2026-02-30&toKst=2026-03-01",
    "fromKst=2023-01-01&toKst=2026-11-10",
    "fromKst=20261101&toKst=20261110",
  ])("범위·형식 밖 → 400 (%s)", async (qs) => {
    const res = await GET(req(qs));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("상태 응답", () => {
  beforeEach(() => getSessionMock.mockResolvedValue({ kind: "admin", role: 0 } as SessionInfo));

  it("속성 설정 없음 → 200 not_connected", async () => {
    propertyIdMock.mockReturnValue(null);
    const res = await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_connected" });
  });

  it("미연결 → 200 not_connected · 저장 안 되게 no-store", async () => {
    fetchMock.mockResolvedValue({ status: "not_connected" });
    const res = await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_connected" });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("불러오기 실패 → 200 unavailable(오류 원문 없음)", async () => {
    fetchMock.mockResolvedValue({ status: "unavailable" });
    const res = await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "unavailable" });
  });

  it("접근 감사 — 기간·결과 상태·추적 번호만 남기고 결과 내용은 남기지 않는다", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      status: "ok",
      startDate: "2026-11-01",
      endDate: "2026-11-10",
      rows: [{ category: "mobile", label: "모바일", sessions: 777123, screenPageViews: 1 }],
      timeZone: "Asia/Seoul",
    });
    await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    const lines = info.mock.calls.map((c) => String(c[0]));
    info.mockRestore();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[page-analytics\]\[audit\] kind=admin view=ga4-device range=2026-11-01~2026-11-10 cid=\S+ at=/);
    expect(lines[1]).toMatch(/ga4-device status=ok rows=1 cid=\S+/);
    const cid0 = /cid=(\S+)/.exec(lines[0])![1];
    expect(lines[1]).toContain(`cid=${cid0}`);
    expect(lines.join("\n")).not.toContain("777123");
    expect(lines.join("\n")).not.toContain("모바일");
  });

  it("입력 오류 응답에도 추적 번호", async () => {
    const res = await GET(req("fromKst=bad&toKst=bad"));
    expect(res.status).toBe(400);
    expect((await res.json()).correlationId).toEqual(expect.any(String));
  });

  it("정상 → 고른 한국 날짜 그대로 구글에 넘긴다", async () => {
    fetchMock.mockResolvedValue({ status: "ok", startDate: "2026-11-01", endDate: "2026-11-10", rows: [], timeZone: "Asia/Seoul" });
    const res = await GET(req("fromKst=2026-11-01&toKst=2026-11-10"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith({ propertyId: "123", startDate: "2026-11-01", endDate: "2026-11-10" });
    expect((await res.json()).status).toBe("ok");
  });
});
