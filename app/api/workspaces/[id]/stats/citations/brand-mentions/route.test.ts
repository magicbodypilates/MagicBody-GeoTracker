/**
 * route.test.ts — /api/workspaces/[id]/stats/citations/brand-mentions 권한 게이트 + 응답 shape 테스트.
 *
 * 목적: 라우트 핸들러의 인증 분기 + 언급 필터/소유 제외 경로를 DB 연결 없이 검증.
 *   ① 미인증(session=null)            → 401
 *   ② 일반관리자 + 비프로덕션 WS       → 403
 *   ③ 최고관리자                       → 200 + 제3자 언급만(소유·미언급 제외) + title 노출
 *
 * 모킹 전략은 urls/route.test.ts 와 동일 — auth-guard / db / branded-query-filter 를 모킹하고
 * citation-url-aggregate / run-stats-where / citation-utils / citation-brand-host-filter 순수함수는 실제 사용.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SessionInfo } from "@/lib/server/auth-guard";

// ── 모킹: auth-guard ──
const getSessionMock = vi.fn<() => Promise<SessionInfo>>();
const assertAccessMock = vi.fn<(wsId: string, s: SessionInfo) => Promise<NextResponse | null>>();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, s: SessionInfo) => assertAccessMock(wsId, s),
}));

// ── 모킹: branded-query-filter — getBrandTermsForWorkspace(DB 조회)만 브랜드 용어 주입, 순수함수는 실제 ──
vi.mock("@/lib/server/branded-query-filter", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/branded-query-filter")>(
    "@/lib/server/branded-query-filter",
  );
  return {
    ...actual,
    getBrandTermsForWorkspace: vi.fn(async () => ["매직바디"] as string[]),
  };
});

// ── 모킹: db — select 체인 + transaction ──
const brandWebsites = ["https://magicbodypilates.com"];
const expandedRows = [
  // 제3자(viva100) + 제목 브랜드 언급 → 포함
  {
    run_id: "run-1",
    url: "https://www.viva100.com/article/12345",
    domain: "viva100.com",
    title: "매직바디, 국제재활필라테스 강사 과정 개설",
    description: "보도자료",
    prompt_text: "필라테스 강사 자격증 추천",
    provider: "chatgpt",
    created_at: "2026-06-20T00:00:00.000Z",
  },
  // 소유(내 사이트) — 제목이 브랜드를 언급해도 제외
  {
    run_id: "run-2",
    url: "https://magicbodypilates.com/online/regular-class",
    domain: "magicbodypilates.com",
    title: "매직바디 정규 과정",
    description: "",
    prompt_text: "매직바디 후기",
    provider: "perplexity",
    created_at: "2026-06-25T00:00:00.000Z",
  },
  // 제3자지만 제목/설명에 브랜드 미언급 → 제외 (JS 재판정)
  {
    run_id: "run-3",
    url: "https://competitor.com/course",
    domain: "competitor.com",
    title: "일반 필라테스 자격증 안내",
    description: "타 업체",
    prompt_text: "필라테스 자격증",
    provider: "gemini",
    created_at: "2026-06-25T00:00:00.000Z",
  },
];

vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/drizzle/schema")>("@/drizzle/schema");
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [{ brandConfig: { websites: brandWebsites } }],
  };
  return {
    schema: actual,
    db: {
      select: () => selectChain,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        let call = 0;
        const tx = {
          execute: async () => {
            call += 1;
            return call === 1 ? [] : expandedRows;
          },
        };
        return fn(tx);
      },
    },
  };
});

import { GET } from "./route";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/workspaces/ws-1/stats/citations/brand-mentions${query}`,
  );
}

const ctx = { params: Promise.resolve({ id: "ws-1" }) };

beforeEach(() => {
  getSessionMock.mockReset();
  assertAccessMock.mockReset();
  assertAccessMock.mockImplementation(async (_wsId, s) => {
    if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (s.kind === "admin") return null;
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  });
});

describe("/api/workspaces/[id]/stats/citations/brand-mentions 권한 게이트", () => {
  it("① 미인증(session=null) → 401", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(401);
  });

  it("② 일반관리자 + 비프로덕션 WS → 403", async () => {
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u-1" });
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(403);
  });

  it("③ 최고관리자 → 200 + 제3자 언급만(소유·미언급 제외) + title 노출", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await GET(makeRequest("?auto=true&branded=false&pageSize=100"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.allTime).toBe(true);
    expect(Array.isArray(body.urls)).toBe(true);
    // 제3자 언급 1개(viva100), 소유(magicbodypilates) + 미언급(competitor) 제외
    expect(body.uniqueUrlCount).toBe(1);
    expect(body.urls[0].domain).toBe("viva100.com");
    expect(body.urls[0].title).toBe("매직바디, 국제재활필라테스 강사 과정 개설");
    expect(body.urls[0].totalCount).toBe(1);
    expect("nextCursor" in body).toBe(true);
  });

  it("잘못된 cursor → 400 invalid_cursor", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await GET(makeRequest("?cursor=@@@not-valid@@@"), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_cursor");
  });
});
