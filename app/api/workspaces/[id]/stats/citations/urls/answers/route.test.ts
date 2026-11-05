/**
 * route.test.ts — /stats/citations/{urls,brand-mentions}/answers (질문별 AI 답변 목록) 라우트 계약.
 *
 *   ① 미인증 401 · 필수 값 누락 400 · 잘못된 cursor 400
 *   ② 캐시 경로 — 기간·모델 거름 + 같은 판정으로 찾은 응답을 최신순으로, 본문은 찾은 순서대로
 *   ③ 쪽 넘김 cursor 로 다음 쪽 · 본문 조회에서 빠진(보관된) 응답은 목록에서 빠진다
 *   ④ 캐시 실패 → SQL 경로(트랜잭션)로 같은 결과
 *   ⑤ 브랜드 언급 출처 라우트도 같은 처리(언급 판정)
 * DB·캐시는 모킹한다. 판정·기간·쪽 넘김은 실제 순수함수.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SessionInfo } from "@/lib/server/auth-guard";
import type { CandidateRow } from "@/lib/server/citation-rows-cache";

const getSessionMock = vi.fn<() => Promise<SessionInfo>>();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: async (_id: string, s: SessionInfo) =>
    s ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 }),
}));
vi.mock("@/lib/server/branded-query-filter", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/branded-query-filter")>(
    "@/lib/server/branded-query-filter",
  );
  return { ...actual, getBrandTermsForWorkspace: vi.fn(async () => ["매직바디"]) };
});
vi.mock("@/lib/server/brand-youtube-videos", () => ({
  getOwnedYoutubeVideoIds: vi.fn(async () => new Set<string>()),
}));

let cacheRows: CandidateRow[] | null = [];
vi.mock("@/lib/server/citation-rows-cache", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/citation-rows-cache")>(
    "@/lib/server/citation-rows-cache",
  );
  return {
    ...actual,
    getCitationRowsCache: () => ({
      get: async () => {
        if (cacheRows === null) throw new Error("cache down");
        return { index: cacheRows };
      },
    }),
  };
});

/** 본문 조회에서 돌려줄 응답 id (보관된 응답은 여기서 빠진다고 가정) */
let bodyIds: Set<string> = new Set();
/** 지금 보관된 응답 id — 살아 있는 응답 확인 조회에서 빠진다 (A-C1) */
let archivedIds: Set<string> = new Set();
let sqlRows: CandidateRow[] = [];
const txExecute = vi.fn();
vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/db")>("@/lib/server/db");
  const select = (cols?: Record<string, unknown>) => ({
    from: () => ({
      where: () => {
        if (cols && "brandConfig" in cols) {
          return { limit: async () => [{ brandConfig: { websites: ["https://www.magicbodypilates.co.kr"] } }] };
        }
        // 살아 있는 응답 확인(id 만) — 캐시에 남은 후보 중 보관되지 않은 것
        if (cols && Object.keys(cols).length === 1 && "id" in cols) {
          const all = [...(cacheRows ?? sqlRows)].map((r) => r.run_id);
          return Promise.resolve([...new Set(all)].filter((rid) => !archivedIds.has(rid)).map((rid) => ({ id: rid })));
        }
        // 본문 조회 — 일부러 순서를 뒤집어 돌려준다(라우트가 찾은 순서로 다시 세워야 한다)
        return Promise.resolve(
          [...bodyIds].reverse().map((id) => ({ id, promptText: Q, provider: "chatgpt", answer: `답변 ${id}`, createdAt: "x" })),
        );
      },
    }),
  });
  return {
    ...actual,
    db: {
      select,
      transaction: async (fn: (tx: { execute: typeof txExecute }) => Promise<unknown>) => fn({ execute: txExecute }),
    },
  };
});

import { GET as GET_URLS } from "./route";
import { GET as GET_MENTIONS } from "../../brand-mentions/answers/route";

const WS = "11111111-1111-1111-1111-111111111111";
const Q = "필라테스 자격증 어디서 따나요";
const KEY = "magicbodypilates.co.kr/pilates-certification";

function cand(run: string, at: string, p: Partial<CandidateRow> = {}): CandidateRow {
  return {
    run_id: run,
    url: "https://www.magicbodypilates.co.kr/pilates-certification",
    domain: "magicbodypilates.co.kr",
    prompt_text: Q,
    provider: "chatgpt",
    created_at: at,
    ...p,
  };
}

function req(path: string, q: Record<string, string>) {
  return new NextRequest(`http://localhost/api/workspaces/${WS}/stats/citations/${path}/answers?${new URLSearchParams(q)}`);
}
const ctx = { params: Promise.resolve({ id: WS }) };

beforeEach(() => {
  getSessionMock.mockResolvedValue({ role: 0, kind: "admin" } as unknown as SessionInfo);
  txExecute.mockReset();
  txExecute.mockImplementation(async (q: unknown) => (typeof q === "object" && q && "queryChunks" in q ? sqlRows : []));
  // 최근 7일 밖 1건(r-old) · 다른 모델 1건(r-gem) · 7일 안 chatgpt 12건
  cacheRows = [
    ...Array.from({ length: 12 }, (_, i) => cand(`r-${String(i).padStart(2, "0")}`, new Date(Date.now() - i * 3_600_000 - 60_000).toISOString())),
    cand("r-gem", new Date(Date.now() - 2 * 3_600_000).toISOString(), { provider: "gemini" }),
    cand("r-old", new Date(Date.now() - 20 * 86_400_000).toISOString()),
  ];
  sqlRows = cacheRows;
  bodyIds = new Set();
  archivedIds = new Set();
});

async function json(res: Response) {
  return JSON.parse(await res.text());
}

describe("answers 라우트", () => {
  it("미인증 401 · 필수 값 누락 400 · 잘못된 cursor 400", async () => {
    getSessionMock.mockResolvedValueOnce(null as unknown as SessionInfo);
    expect((await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptText: Q }), ctx)).status).toBe(401);
    expect((await GET_URLS(req("urls", { promptText: Q }), ctx)).status).toBe(400);
    expect((await GET_URLS(req("urls", { canonicalUrlKey: KEY }), ctx)).status).toBe(400);
    expect((await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptText: Q, cursor: "zz" }), ctx)).status).toBe(400);
  });

  it("최근 7일 · chatgpt — 12건 중 첫 10건, 본문은 최신순", async () => {
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const from = new Date(Date.now() + 9 * 3_600_000 - 6 * 86_400_000).toISOString().slice(0, 10);
    bodyIds = new Set(Array.from({ length: 10 }, (_, i) => `r-${String(i).padStart(2, "0")}`));
    const res = await GET_URLS(
      req("urls", { canonicalUrlKey: KEY, promptText: Q, from, to: today, provider: "chatgpt", pageSize: "10" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.answerCount).toBe(12);
    expect(body.providerCounts).toEqual([{ provider: "chatgpt", count: 12 }]);
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual([...bodyIds]);
    expect(body.nextCursor).toBeTruthy();

    // 다음 쪽 — 남은 2건. 그중 r-11 이 보관돼 본문이 없으면 목록에서 빠진다
    bodyIds = new Set(["r-10"]);
    const res2 = await GET_URLS(
      req("urls", { canonicalUrlKey: KEY, promptText: Q, from, to: today, provider: "chatgpt", cursor: body.nextCursor }),
      ctx,
    );
    const body2 = await json(res2);
    expect(body2.runs.map((r: { id: string }) => r.id)).toEqual(["r-10"]);
    expect(body2.nextCursor).toBeNull();
  });

  it("전체 기간 · 전체 모델 — 기간 밖·다른 모델 응답도 센다", async () => {
    const body = await json(await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptText: Q }), ctx));
    expect(body.answerCount).toBe(14);
    expect(body.period.allTime).toBe(true);
  });

  it("캐시 실패 → SQL 경로로 같은 수", async () => {
    cacheRows = null;
    const body = await json(await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptText: Q }), ctx));
    expect(txExecute).toHaveBeenCalled();
    expect(body.answerCount).toBe(14);
  });

  it("브랜드 언급 출처 — 제목에 브랜드가 있는 제3자 페이지 인용만", async () => {
    const MK = "news.example.com/a/1";
    cacheRows = [
      cand("m1", new Date(Date.now() - 60_000).toISOString(), { url: "https://news.example.com/a/1", domain: "news.example.com", title: "매직바디 보도" }),
      cand("m2", new Date(Date.now() - 60_000).toISOString(), { url: "https://news.example.com/a/1", domain: "news.example.com", title: "다른 기사" }),
    ];
    const body = await json(await GET_MENTIONS(req("brand-mentions", { canonicalUrlKey: MK, promptText: Q }), ctx));
    expect(body.answerCount).toBe(1);
  });

  it("A-C1: 캐시에 남은 방금 보관한 응답은 총수·쪽 넘김에서 빠진다", async () => {
    archivedIds = new Set(["r-00", "r-01", "r-gem"]);
    bodyIds = new Set(["r-02"]);
    const body = await json(await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptText: Q, pageSize: "1" }), ctx));
    expect(body.answerCount).toBe(11);
    expect(body.providerCounts).toEqual([{ provider: "chatgpt", count: 11 }]);
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(["r-02"]);
  });

  it("A-C3: 질문 해시로 조회 · 해시 형식이 틀리면 400", async () => {
    const { hashPromptText } = await import("@/lib/server/citation-url-answers");
    const body = await json(await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptHash: hashPromptText(Q) }), ctx));
    expect(body.answerCount).toBe(14);
    expect((await GET_URLS(req("urls", { canonicalUrlKey: KEY, promptHash: "zz" }), ctx)).status).toBe(400);
  });
});
