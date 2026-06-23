/**
 * route.test.ts — /api/admin/attribution 권한 게이트(2차 requireAdmin) 통합 단위 테스트.
 *
 * 목적(security Info#1 / reviewer M2): route 핸들러의 권한 분기 3케이스를 DB·CMS 연결 없이 검증.
 *   ① 미인증(session=null)          → 401
 *   ② 일반관리자(session.kind="user") → 403 (최고관리자 전용)
 *   ③ 최고관리자(session.kind="admin") → byMonth 정상 경로 진입 → 200 (정상 형태 반환)
 *
 * 모킹 전략(DB 불필요):
 *   - @/lib/server/auth-guard : getSession 은 케이스별 세션 주입, requireAdmin 은 실제와 동일한
 *     순수 분기(401/403/null)를 재현(원본은 @/lib/server/db 를 transitively import 하므로 모듈 전체 모킹).
 *   - @/lib/server/cms-api    : postCmsPayment 를 모킹해 .NET·CMS 호출 없이 byMonth 정상 봉투 반환.
 *   - normalizeByMonth 는 실제 순수함수 그대로 사용(게이트 통과 후 정상 응답 형태까지 확인).
 *
 * 검증 범위는 "권한 게이트 분기"에 한정. DB 합계 smoke·SQL 월버킷 계약은 tester 단계(별도).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SessionInfo } from "@/lib/server/auth-guard";

// ── 모킹: auth-guard (getSession 주입형 + requireAdmin 순수 재현) ──
const getSessionMock = vi.fn<() => Promise<SessionInfo>>();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  // 원본 requireAdmin 과 동일한 분기(순수). DB 의존 없는 헬퍼만 노출.
  requireAdmin: (session: SessionInfo): NextResponse | null => {
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (session.kind !== "admin")
      return NextResponse.json({ error: "forbidden", hint: "최고관리자 권한 필요" }, { status: 403 });
    return null;
  },
}));

// ── 모킹: cms-api (postCmsPayment) — .NET·CMS 호출 차단 ──
const postCmsPaymentMock = vi.fn();
vi.mock("@/lib/server/cms-api", () => ({
  postCmsPayment: (...args: unknown[]) => postCmsPaymentMock(...args),
}));

// route 는 위 모킹된 모듈에 의존하므로 mock 선언 이후 import.
import { GET } from "./route";

/** byMonth 쿼리스트링이 붙은 NextRequest 생성(searchParams 만 사용). */
function makeByMonthRequest(): NextRequest {
  const url =
    "http://localhost/api/admin/attribution?view=byMonth&start=2026-06-01&end=2026-06-30&groupBy=channel";
  // route 는 req.nextUrl.searchParams 만 읽음 — NextRequest 생성자로 충분(미들웨어 컨텍스트 불필요).
  return new NextRequest(url);
}

beforeEach(() => {
  getSessionMock.mockReset();
  postCmsPaymentMock.mockReset();
});

describe("/api/admin/attribution 권한 게이트(2차 requireAdmin)", () => {
  it("① 미인증(session=null) → 401, CMS 미호출", async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await GET(makeByMonthRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    // 게이트에서 차단됐으므로 upstream(.NET) 호출은 절대 없어야 한다.
    expect(postCmsPaymentMock).not.toHaveBeenCalled();
  });

  it("② 일반관리자(kind=user) → 403, CMS 미호출", async () => {
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u-1" });

    const res = await GET(makeByMonthRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
    expect(postCmsPaymentMock).not.toHaveBeenCalled();
  });

  it("③ 최고관리자(kind=admin) → byMonth 정상 경로 진입 → 200, 정상 형태 반환", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    // .NET 응답 봉투(datas) 모방 — items + valueConverted + groupBy.
    postCmsPaymentMock.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { bucket: "2026-06", dim: "", rowType: "total", salesCount: 5, revenue: 23_400_000, rawRevenue: 8_600_000 },
          { bucket: "2026-06", dim: "google", rowType: "series", salesCount: 3, revenue: 19_500_000, rawRevenue: 5_000_000 },
        ],
        valueConverted: true,
        groupBy: "channel",
      },
    });

    const res = await GET(makeByMonthRequest());
    expect(res.status).toBe(200);

    // byMonth 액션으로 프록시됐는지(게이트 통과 후 정상 경로 진입 확인).
    expect(postCmsPaymentMock).toHaveBeenCalledTimes(1);
    expect(postCmsPaymentMock.mock.calls[0][0]).toBe("/api/Payment/GetAttributionByMonth/");

    // normalizeByMonth(실제 순수함수)를 거친 정상 응답 형태.
    const body = await res.json();
    expect(body.view).toBe("byMonth");
    expect(body.groupBy).toBe("channel");
    expect(body.valueConverted).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
  });
});
