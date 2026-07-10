/**
 * route.test.ts — /api/workspaces/[id]/stats/citations/urls/prompts 권한 게이트 + 응답 shape 테스트.
 *
 * 목적: 특정 브랜드 URL(canonicalUrlKey)의 프롬프트 전수 조회 라우트를 DB 연결 없이 검증.
 *   ① 미인증(session=null)             → 401
 *   ② 일반관리자 + 비프로덕션 WS        → 403 (assertWorkspaceAccess)
 *   ③ canonicalUrlKey 누락             → 400 missing_canonical_url_key
 *   ④ 최고관리자 + 유효 key            → 200 + 응답 shape 필드 존재 (프롬프트 집계)
 *   ⑤ 잘못된 cursor                    → 400 invalid_cursor
 *
 * 회귀 고정(reviewer HIGH — urls/route.test.ts 와 동형):
 *   ⑥ 소유 영상 빈 Set → 유튜브 쿼리 미실행(tx.execute 2회)·capped=false·legacy 브랜드 단일 경로와 동일
 *   ⑦ 소유 영상 있음 → 유튜브 쿼리 실행(tx.execute 3회)·union 경로로 소유 영상 프롬프트 드릴다운
 *
 * 모킹 전략은 urls/route.test.ts 와 동일:
 *   - @/lib/server/auth-guard: getSession 케이스별 주입, assertWorkspaceAccess 는 원본과 동일한
 *     순수 분기(401/403/404/null)를 재현(원본은 db 를 transitively import).
 *   - @/lib/server/db: db.select().from().where().limit() 체인 + db.transaction 을 모킹해
 *     실제 DB 없이 브랜드 프롬프트 집계 경로까지 통과.
 *   - @/lib/server/branded-query-filter: getBrandTermsForWorkspace 모킹(빈 배열).
 *   - citation-url-aggregate / run-stats-where / citation-utils 는 실제 순수함수 그대로 사용.
 *
 * 검증 범위: 권한 게이트 + 필수 파라미터 + 정상 응답 shape + 유튜브 쿼리 실행 여부 회귀.
 * SQL 펼침·페이지네이션 계약은 tester 단계(라이브).
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

// ── 모킹: db — select 체인 + transaction + execute ──
// 워크스페이스 brandConfig 조회 + 소유영상 로더(select().from().where()) +
// 펼친 citation 행 방출(transaction 내 2쿼리 또는 3쿼리)을 흉내낸다.
const brandWebsites = ["https://magicbodypilates.com"];
// 드릴다운 대상 브랜드 URL key (urls 라우트가 노출하는 canonicalUrlKey 형식)
const BRAND_KEY = "magicbodypilates.com/online/regular-class";
const baseExpandedRows = [
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
  // 비브랜드 — canonicalUrlKey 불일치로 이 URL 의 프롬프트 집계에서 제외되어야 함
  {
    run_id: "run-3",
    url: "https://competitor.com/course",
    domain: "competitor.com",
    prompt_text: "필라테스 자격증",
    provider: "gemini",
    created_at: "2026-06-25T00:00:00.000Z",
  },
];

// 테스트별 조정 가능 상태 — beforeEach 에서 기본값으로 리셋.
let txRows: Array<Record<string, unknown>> = [...baseExpandedRows];
let ownedVideoRows: Array<{ videoId: string }> = [];
// 트랜잭션 내부 tx.execute 호출 횟수 — 유튜브 쿼리 실행 여부 회귀 검증용(reviewer HIGH).
// SET LOCAL(1) + 브랜드 쿼리(1) = 2. 소유 영상이 있으면 유튜브 쿼리(1)가 더해져 3.
let txExecuteCalls = 0;

vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/drizzle/schema")>("@/drizzle/schema");
  // where() 결과 — brandConfig 조회는 .limit() 로, 소유영상 로더는 await(thenable)로 소비한다.
  const whereResult = {
    limit: async () => [{ brandConfig: { websites: brandWebsites } }],
    then: (resolve: (v: Array<{ videoId: string }>) => void) => resolve(ownedVideoRows),
  };
  const selectChain = {
    from: () => selectChain,
    where: () => whereResult,
  };
  return {
    schema: actual,
    db: {
      select: () => selectChain,
      // prompts 라우트는 getOwnedVideosMeta 를 호출하지 않지만, 모듈 계약 유지를 위해 둔다.
      execute: async () => [{ active_count: 0, last_synced_at: null }],
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        // 첫 execute 는 SET LOCAL statement_timeout(반환값 없음), 이후 두 번(브랜드·유튜브 cap 쿼리)이
        // 펼친 citation 행을 방출한다(계획 v2 §5 결정 E). SET LOCAL 이 bind 파라미터로 렌더되면 실 DB 에서
        // 실패하므로(B-1), 라이브 tester 단계가 별도로 이를 고정한다.
        let call = 0;
        const tx = {
          execute: async () => {
            call += 1;
            txExecuteCalls += 1;
            return call === 1 ? [] : txRows;
          },
        };
        return fn(tx);
      },
    },
  };
});

// route 는 위 모킹 모듈에 의존 — mock 선언 이후 import.
import { GET } from "./route";
// 소유영상 로더는 모듈 TTL 캐시를 쓰므로 테스트 격리를 위해 매 테스트 캐시 초기화.
import { _clearOwnedVideoCache } from "@/lib/server/brand-youtube-videos";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/workspaces/ws-1/stats/citations/urls/prompts${query}`,
  );
}

// canonicalUrlKey 는 슬래시·물음표를 포함하므로 쿼리 값으로 넣을 때 encodeURIComponent 필수.
function keyQuery(key: string, extra = ""): string {
  return `?canonicalUrlKey=${encodeURIComponent(key)}${extra}`;
}

const ctx = { params: Promise.resolve({ id: "ws-1" }) };

beforeEach(() => {
  getSessionMock.mockReset();
  assertAccessMock.mockReset();
  // 모킹 상태 기본값 리셋 (테스트 격리)
  txRows = [...baseExpandedRows];
  ownedVideoRows = [];
  txExecuteCalls = 0; // 트랜잭션 execute 호출 카운터 리셋
  _clearOwnedVideoCache(); // 소유영상 로더 TTL 캐시 초기화 (테스트 간 누수 방지)
  // 기본: assertWorkspaceAccess 는 원본과 동일한 순수 분기 재현
  assertAccessMock.mockImplementation(async (_wsId, s) => {
    if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (s.kind === "admin") return null;
    // user + 비프로덕션 WS 가정 → 403
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  });
});

describe("/api/workspaces/[id]/stats/citations/urls/prompts 권한 게이트 + 프롬프트 집계", () => {
  it("① 미인증(session=null) → 401", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await GET(makeRequest(keyQuery(BRAND_KEY)), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("② 일반관리자 + 비프로덕션 WS → 403", async () => {
    getSessionMock.mockResolvedValue({ kind: "user", role: 1, uid: "u-1" });
    const res = await GET(makeRequest(keyQuery(BRAND_KEY)), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
  });

  it("③ canonicalUrlKey 누락 → 400 missing_canonical_url_key", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await GET(makeRequest(), ctx); // 쿼리 없음
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("missing_canonical_url_key");
  });

  it("④ 최고관리자 + 유효 key → 200 + 응답 shape (브랜드 URL 프롬프트 전수, 비브랜드 제외)", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await GET(makeRequest(keyQuery(BRAND_KEY, "&auto=true&branded=false&pageSize=100")), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    // 최상위 필드 존재·타입
    expect(body.canonicalUrlKey).toBe(BRAND_KEY);
    expect(typeof body.promptCount).toBe("number");
    expect(typeof body.capped).toBe("boolean");
    expect(Array.isArray(body.prompts)).toBe(true);
    expect("nextCursor" in body).toBe(true);

    // 브랜드 URL(regular-class)을 인용한 프롬프트 2건(run-1, run-2). 비브랜드(competitor)는 key 불일치로 제외.
    expect(body.capped).toBe(false);
    expect(body.promptCount).toBe(2);
    expect(body.nextCursor).toBeNull();

    // 프롬프트 항목 shape
    const p = body.prompts[0];
    expect(typeof p.promptText).toBe("string");
    expect(typeof p.count).toBe("number");
    expect(Array.isArray(p.providers)).toBe(true);
    expect(typeof p.lastSeen).toBe("string");

    // 두 프롬프트 텍스트가 모두 포함(정렬 무관)
    const texts = body.prompts.map((x: { promptText: string }) => x.promptText);
    expect(texts).toContain("부산 필라테스 강사 자격증 추천");
    expect(texts).toContain("필라테스 자격증 온라인");
    expect(texts).not.toContain("필라테스 자격증"); // 비브랜드 프롬프트
  });

  it("⑤ 잘못된 cursor → 400 invalid_cursor", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const res = await GET(makeRequest(keyQuery(BRAND_KEY, "&cursor=@@@not-valid@@@")), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_cursor");
  });

  it("⑥ 소유 영상 빈 Set → 유튜브 쿼리 미실행(tx.execute 2회) + capped=false + 브랜드 단일 경로와 동일 (reviewer HIGH)", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    // 기본 상태: ownedVideoRows=[] (소유 0개). 유튜브 쿼리를 아예 돌리지 않아야 한다.
    const res = await GET(makeRequest(keyQuery(BRAND_KEY, "&auto=true&branded=false&pageSize=100")), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    // 트랜잭션 내 execute 는 SET LOCAL(1) + 브랜드 쿼리(1) = 2회. 유튜브 쿼리(+1)는 실행 안 됨.
    expect(txExecuteCalls).toBe(2);
    // 유튜브 쿼리를 안 돌렸으므로 capped 는 브랜드 cap 만으로 판정 → false (cursor 잠금 회귀 차단).
    expect(body.capped).toBe(false);

    // 결과는 브랜드 단일 쿼리(legacy) 경로와 동일: 브랜드 URL 프롬프트 2건, 비브랜드 제외.
    expect(body.canonicalUrlKey).toBe(BRAND_KEY);
    expect(body.promptCount).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it("⑦ 소유 영상 있음 → 유튜브 쿼리 실행(tx.execute 3회) + 소유 영상 프롬프트 union 드릴다운", async () => {
    getSessionMock.mockResolvedValue({ kind: "admin", role: 0 });
    const OWNED = "dQw4w9WgXcQ";
    ownedVideoRows = [{ videoId: OWNED }];
    // 소유 영상을 youtu.be 로 인용한 행을 추가 (두 cap 쿼리 모두 이 행 집합을 방출 → 앱단 dedup).
    txRows = [
      ...baseExpandedRows,
      {
        run_id: "run-yt",
        url: `https://youtu.be/${OWNED}`,
        domain: "youtu.be",
        prompt_text: "매직바디 영상 어디서 봐요",
        provider: "chatgpt",
        created_at: "2026-06-28T00:00:00.000Z",
      },
    ];
    // 드릴다운 target 은 소유 영상의 canonical watch URL key.
    const OWNED_KEY = `youtube.com/watch?v=${OWNED}`;
    const res = await GET(makeRequest(keyQuery(OWNED_KEY, "&auto=true&pageSize=100")), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    // 소유 영상이 있으므로 유튜브 superset 쿼리도 실행: SET LOCAL(1)+브랜드(1)+유튜브(1) = 3.
    expect(txExecuteCalls).toBe(3);

    // 3형태(youtu.be)가 canonical watch URL 로 병합되어 target key 에 매칭 → 프롬프트 1건 드릴다운.
    expect(body.canonicalUrlKey).toBe(OWNED_KEY);
    expect(body.promptCount).toBe(1);
    expect(body.prompts[0].promptText).toBe("매직바디 영상 어디서 봐요");
    expect(body.capped).toBe(false);
  });
});
