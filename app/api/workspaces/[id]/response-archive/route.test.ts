/**
 * route.test.ts — GET/POST /api/workspaces/:id/response-archive (계획 geotracker-response-archive-260924 §4-2 · §6-1).
 *
 * 라우트의 책임만 본다 — 가드 호출·입력 검사(400)·실행 함수 호출 인자·트랜잭션 안에서 부르는지·
 * 오류 본문. SQL 정렬·건수·경계는 lib/server/run-archive.int.test.ts(실제 DB)가 본다.
 * 실행 함수는 가짜, 입력 검사(스키마·쪽 넘김 표시 해석)는 실제 함수다.
 * ⚠️ PUBLIC 저장소 — 문구는 가짜 값이다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const H = vi.hoisted(() => {
  const state = { inTx: false, txCount: 0 };
  const fakeTx = { __tx: true };
  const db = {
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      state.txCount += 1;
      state.inTx = true;
      try {
        return await fn(fakeTx);
      } finally {
        state.inTx = false;
      }
    },
  };
  const result = { affectedRuns: 5, affectedQuestions: 2, skippedInList: [] as string[] };
  const mk = <A extends unknown[]>(name: string) =>
    vi.fn(async (...args: A) => {
      void args;
      if (!state.inTx) throw new Error(`${name} 은 트랜잭션 안에서만 불려야 한다`);
      return result;
    });
  return {
    state,
    fakeTx,
    db,
    result,
    archiveByTexts: mk<[unknown, string, string[]]>("archiveByTexts"),
    archiveAllUntracked: mk<[unknown, string, string]>("archiveAllUntracked"),
    restoreByTexts: mk<[unknown, string, string[]]>("restoreByTexts"),
    applyArchiveTxTimeouts: vi.fn(async () => {}),
    applyArchiveReadTimeout: vi.fn(async () => {}),
    readDbNow: vi.fn(async () => "2026-05-05T03:00:30.123456Z"),
    listArchiveQuestions: vi.fn(async () => ({ items: [], nextCursor: null })),
    countArchiveQuestions: vi.fn(async () => ({ archivedQuestions: 1, untrackedQuestions: 2, untrackedRuns: 9 })),
  };
});

vi.mock("@/lib/server/db", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, db: H.db };
});
vi.mock("@/lib/server/run-archive", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    archiveByTexts: H.archiveByTexts,
    archiveAllUntracked: H.archiveAllUntracked,
    restoreByTexts: H.restoreByTexts,
    applyArchiveTxTimeouts: H.applyArchiveTxTimeouts,
    applyArchiveReadTimeout: H.applyArchiveReadTimeout,
    readDbNow: H.readDbNow,
    listArchiveQuestions: H.listArchiveQuestions,
    countArchiveQuestions: H.countArchiveQuestions,
  };
});

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", () => ({
  getSession: () => getSessionMock(),
  assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
}));

const { GET, POST } = await import("./route");
const { encodeArchiveCursor } = await import("@/lib/server/run-archive");

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = { kind: "user", role: 1, uid: "u1" };

function get(qs: string, id = WS) {
  return GET(new NextRequest(`http://localhost/api/workspaces/${id}/response-archive${qs}`), {
    params: Promise.resolve({ id }),
  });
}
function post(body: unknown, raw = false, id = WS) {
  return POST(
    new NextRequest(`http://localhost/api/workspaces/${id}/response-archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  H.state.txCount = 0;
  getSessionMock.mockResolvedValue(USER);
  assertWorkspaceAccessMock.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("GET — 보관함 조회", () => {
  it("로그인 → 워크스페이스 권한을 확인하고, 한 트랜잭션에서 목록·건수·기준 시각을 준다", async () => {
    const res = await get("?view=untracked");
    expect(res.status).toBe(200);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS, USER);
    expect(H.state.txCount).toBe(1);
    expect(H.applyArchiveReadTimeout).toHaveBeenCalledTimes(1);
    expect(H.listArchiveQuestions).toHaveBeenCalledWith(H.fakeTx, WS, "untracked", null);
    expect(await res.json()).toEqual({
      view: "untracked",
      items: [],
      nextCursor: null,
      asOf: "2026-05-05T03:00:30.123456Z",
      counts: { archivedQuestions: 1, untrackedQuestions: 2, untrackedRuns: 9 },
    });
  });

  it("쪽 넘김 표시를 해석해 넘긴다", async () => {
    const cursor = { k: "2026-05-05T03:00:30.123456Z", h: "0123456789abcdef0123456789abcdef" };
    const res = await get(`?view=archived&cursor=${encodeArchiveCursor(cursor)}`);
    expect(res.status).toBe(200);
    expect(H.listArchiveQuestions).toHaveBeenCalledWith(H.fakeTx, WS, "archived", cursor);
  });

  it("권한이 거부되면 그 응답 그대로 · 조회 없음", async () => {
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await get("?view=untracked");
    expect(res.status).toBe(403);
    expect(H.state.txCount).toBe(0);
  });

  for (const qs of ["", "?view=all", "?view=ARCHIVED", "?view=archived&cursor=", "?view=archived&cursor=%21%21", "?view=untracked&cursor=abc"]) {
    it(`잘못된 인자 ${qs || "(없음)"} → 400 invalid_input, 조회 없음`, async () => {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_input" });
      expect(H.state.txCount).toBe(0);
    });
  }

  it("경로 id 가 UUID 가 아니면 400 invalid_id, 세션도 안 본다", async () => {
    const res = await get("?view=untracked", "not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_id" });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("조회 오류 → 500 고정 코드, 본문에 원문 없음", async () => {
    H.listArchiveQuestions.mockRejectedValueOnce(new Error('Failed query: select … from "runs"'));
    const res = await get("?view=untracked");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "archive_list_failed" });
  });
});

describe("POST — 보관·일괄 보관·되돌리기", () => {
  it("archive → 중복 제거한 문구로 archiveByTexts(tx, wsId, texts) · 트랜잭션 안 · 결과 형식", async () => {
    const res = await post({ action: "archive", promptTexts: ["가짜 질문 1", "가짜 질문 2", "가짜 질문 1"] });
    expect(res.status).toBe(200);
    expect(H.applyArchiveTxTimeouts).toHaveBeenCalledTimes(1);
    expect(H.archiveByTexts).toHaveBeenCalledWith(H.fakeTx, WS, ["가짜 질문 1", "가짜 질문 2"]);
    expect(await res.json()).toEqual({ ok: true, action: "archive", affectedRuns: 5, affectedQuestions: 2, skippedInList: [] });
  });

  it("archive_all_untracked → archiveAllUntracked(tx, wsId, asOf)", async () => {
    const res = await post({ action: "archive_all_untracked", asOf: "2026-05-05T03:00:30.123456Z" });
    expect(res.status).toBe(200);
    expect(H.archiveAllUntracked).toHaveBeenCalledWith(H.fakeTx, WS, "2026-05-05T03:00:30.123456Z");
    expect((await res.json()).action).toBe("archive_all_untracked");
  });

  it("restore → restoreByTexts(tx, wsId, texts)", async () => {
    const res = await post({ action: "restore", promptTexts: ["가짜 질문 3"] });
    expect(res.status).toBe(200);
    expect(H.restoreByTexts).toHaveBeenCalledWith(H.fakeTx, WS, ["가짜 질문 3"]);
  });

  it("건너뛴(켜진) 문구를 그대로 알린다", async () => {
    H.archiveByTexts.mockResolvedValueOnce({ affectedRuns: 0, affectedQuestions: 0, skippedInList: ["켜진 질문"] });
    const res = await post({ action: "archive", promptTexts: ["켜진 질문"] });
    expect((await res.json()).skippedInList).toEqual(["켜진 질문"]);
  });

  it("JSON 형식 오류 → 400 invalid_input, 실행 없음", async () => {
    const res = await post("{not json", true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input" });
    expect(H.state.txCount).toBe(0);
  });

  for (const body of [
    {},
    { action: "purge", promptTexts: ["가"] },
    { action: "archive", promptTexts: [] },
    { action: "archive", promptTexts: Array.from({ length: 201 }, (_, i) => `q${i}`) },
    { action: "archive", promptTexts: ["가".repeat(2001)] },
    { action: "archive_all_untracked", asOf: "yesterday" },
    { action: "archive_all_untracked", asOf: "2026-05-05T03:00:30Z", promptTexts: ["가"] },
  ]) {
    it(`잘못된 본문 ${JSON.stringify(body).slice(0, 60)} → 400, 실행 없음`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(H.state.txCount).toBe(0);
    });
  }

  it("권한이 거부되면 실행 없음", async () => {
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await post({ action: "archive", promptTexts: ["가짜 질문"] });
    expect(res.status).toBe(403);
    expect(H.archiveByTexts).not.toHaveBeenCalled();
  });

  it("실행 오류 → 500 고정 코드, 본문에 원문 없음", async () => {
    H.restoreByTexts.mockRejectedValueOnce(new Error('Failed query: update "runs" set archived_at = null'));
    const res = await post({ action: "restore", promptTexts: ["가짜 질문"] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "archive_action_failed" });
  });
});
