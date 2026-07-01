/**
 * route.test.ts — /api/workspaces/[id]/stats/citations/urls 권한 게이트 + 응답 shape 테스트.
 *
 * 목적(계획 v2 M-5): 라우트 핸들러의 인증 분기 3케이스를 DB 연결 없이 검증.
 *   ① 미인증(session=null)            → 401
 *   ② 일반관리자 + 비프로덕션 WS       → 403 (assertWorkspaceAccess)
 *   ③ 최고관리자                       → 200 + 응답 shape 필드 존재
 *
 * 모킹 전략:
 *   - @/lib/server/auth-guard: getSession 케이스별 주입, assertWorkspaceAccess 는 원본과 동일한
 *     순수 분기(401/403/404/null)를 재현(원본은 db 를 transitively import).
 *   - @/lib/server/db: db.select().from().where().limit() 체인 + db.transaction 을 모킹해
 *     실제 DB 없이 브랜드 URL 집계 경로까지 통과.
 *   - @/lib/server/branded-query-filter: getBrandTermsForWorkspace 모킹(빈 배열).
 *   - citation-url-aggregate / run-stats-where / citation-utils 는 실제 순수함수 그대로 사용.
 *
 * 검증 범위: 권한 게이트 분기 + 정상 응답 shape. SQL 펼침·페이지네이션 계약은 tester 단계(라이브).
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

// ── 모킹: branded-query-filter — getBrandTermsForWorkspace(DB 조회)만 차단, 순수함수는 실제 유지 ──
vi.mock("@/lib/server/branded-query-filter", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/branded-query-filter")>(
    "@/lib/server/branded-query-filter",
  );
  return {
    ...actual,
    getBrandTermsForWorkspace: vi.fn(async () => [] as string[]),
  };
});

// ── 모킹: db — select 체인 + transaction ──
// 워크스페이스 brandConfig 조회 + 펼친 citation 행 방출을 흉내낸다.
const brandWebsites = ["https://magicbodypilates.com"];
const expandedRows = [
  {
    run_id: "run-1",
    url: "https://magicbodypilates.com/online/regular-class",
    domain: "magicbodypilates.com",
    prompt_text: "부산 필라테스 강사 자격증 추천",
    provider: "chatgpt",
    created_at: "2026-06-20T00:00:00.000Z",
  },
  {
    run_id: "run-2",
    url: "https://magicbodypilates.com/online/regular-class",
    domain: "magicbodypilates.com",
    prompt_text: "필라테스 자격증 온라인",
    provider: "perplexity",
    created_at: "2026-06-25T00:00:00.000Z",
  },
  // 비브랜드 — 집계에서 제외되어야 함
  {
    run_id: "run-3",
    url: "https://competitor.com/course",
    domain: "competitor.com",
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
        // 실제 흐름 재현: 첫 execute 는 SET LOCAL statement_timeout(반환값 없음),
        // 두 번째 execute 가 펼친 citation 행을 방출한다. SET LOCAL 이 bind 파라미터로
        // 렌더되면 실 DB 에서 실패하므로(계획 B-1), 컴파일 단정 테스트가 별도로 이를 고정한다.
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

// route 는 위 모킹 모듈에 의존 — mock 선언 이후 import.
import { GET } from "./route";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/ws-1/stats/citations/urls${query}`);
}

const ctx = { params: Promise.resolve({ id: "ws-1" }) };

beforeEach(() => {
  getSessionMock.mockReset();
  assertAccessMock.mockReset();
  // 기본: assertWorkspaceAccess 는 원본과 동일한 순수 분기 재현
  assertAccessMock.mockImplementation(async (_wsId, s) => {
    if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (s.kind === "admin") return null;
    // user + 비프로덕션 WS 가정 → 403
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  });
});

describe("/api/workspaces/[id]/stats/citations/urls 권한 게이트", () => {
  it("① 미인증(session=null) → 401", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("② 일반관리자 + 비프로덕션 WS → 403", async () => {
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u-1" });
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
  });

  it("③ 최고관리자 → 200 + 응답 shape (브랜드 URL 집계, 비브랜드 제외)", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await GET(makeRequest("?auto=true&branded=false&pageSize=100"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    // 최상위 필드 존재
    expect(body.allTime).toBe(true);
    expect(typeof body.maxLookbackDays).toBe("number");
    expect(typeof body.uniqueUrlCount).toBe("number");
    expect(typeof body.invalidCitationCount).toBe("number");
    // scannedRunCount 는 응답에서 제거됨 (계획 M-2 — "스캔 run 수" 의미 불일치)
    expect("scannedRunCount" in body).toBe(false);
    expect(Array.isArray(body.urls)).toBe(true);

    // 브랜드 URL 1개(regular-class), 비브랜드(competitor) 제외
    expect(body.uniqueUrlCount).toBe(1);
    expect(body.urls[0].canonicalUrlKey).toBe("magicbodypilates.com/online/regular-class");
    expect(body.urls[0].totalCount).toBe(2); // run-1, run-2
    // URL 항목 shape
    const u = body.urls[0];
    expect(typeof u.displayUrl).toBe("string");
    expect(typeof u.domain).toBe("string");
    expect(Array.isArray(u.providers)).toBe(true);
    expect(Array.isArray(u.prompts)).toBe(true);
    expect(typeof u.hasMorePrompts).toBe("boolean");
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
