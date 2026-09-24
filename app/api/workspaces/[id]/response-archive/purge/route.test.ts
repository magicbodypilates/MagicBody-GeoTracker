/**
 * route.test.ts — POST /api/workspaces/:id/response-archive/purge (계획 geotracker-response-archive-260924 §4-3 · §6-1).
 *
 * 영구 삭제는 삭제 권한(kind=admin)만 — 권한 확인을 **DB 접근 전에** 한다(워크스페이스 조회·실행 함수
 * 모두 미호출). 실행 함수는 트랜잭션 안에서 불리고, 안에서 오류가 나면 500 고정 코드.
 * auth-guard 는 getSession·assertWorkspaceAccess 만 스파이, requireAdmin 은 실제 함수다.
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
  return {
    state,
    fakeTx,
    db,
    purgeUntracked: vi.fn(async (...args: [unknown, string, string[]]) => {
      void args;
      if (!state.inTx) throw new Error("purgeUntracked 는 트랜잭션 안에서만 불려야 한다");
      return { affectedRuns: 4, affectedQuestions: 1, skippedInList: [] as string[], deletedAlerts: 2 };
    }),
    applyArchiveTxTimeouts: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/server/db", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, db: H.db };
});
vi.mock("@/lib/server/run-archive", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, purgeUntracked: H.purgeUntracked, applyArchiveTxTimeouts: H.applyArchiveTxTimeouts };
});

const getSessionMock = vi.fn();
const assertWorkspaceAccessMock = vi.fn();
vi.mock("@/lib/server/auth-guard", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: () => getSessionMock(),
    assertWorkspaceAccess: (wsId: string, session: unknown) => assertWorkspaceAccessMock(wsId, session),
  };
});

const { POST } = await import("./route");

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = { kind: "user", role: 1, uid: "u1" };
const ADMIN = { kind: "admin", role: 0 };

function post(body: unknown, raw = false, id = WS) {
  return POST(
    new NextRequest(`http://localhost/api/workspaces/${id}/response-archive/purge`, {
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
  assertWorkspaceAccessMock.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("영구 삭제 — 삭제 권한만", () => {
  it("kind=user → 403(중립 안내) · 워크스페이스 조회·트랜잭션·실행 함수 모두 미호출", async () => {
    getSessionMock.mockResolvedValue(USER);
    const res = await post({ promptTexts: ["가짜 질문"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", hint: "이 작업을 할 권한이 없습니다" });
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(H.state.txCount).toBe(0);
    expect(H.purgeUntracked).not.toHaveBeenCalled();
  });

  it("세션 없음 → 401 · DB 미호출", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await post({ promptTexts: ["가짜 질문"] });
    expect(res.status).toBe(401);
    expect(assertWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(H.state.txCount).toBe(0);
  });

  it("kind=admin → 워크스페이스 권한 → 트랜잭션 안에서 purgeUntracked(tx, wsId, 중복 제거 문구)", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    const res = await post({ promptTexts: ["가짜 질문", "가짜 질문", "다른 가짜 질문"] });
    expect(res.status).toBe(200);
    expect(assertWorkspaceAccessMock).toHaveBeenCalledWith(WS, ADMIN);
    expect(H.state.txCount).toBe(1);
    expect(H.applyArchiveTxTimeouts).toHaveBeenCalledTimes(1);
    expect(H.purgeUntracked).toHaveBeenCalledWith(H.fakeTx, WS, ["가짜 질문", "다른 가짜 질문"]);
    expect(await res.json()).toEqual({
      ok: true,
      action: "purge",
      affectedRuns: 4,
      affectedQuestions: 1,
      skippedInList: [],
      deletedAlerts: 2,
    });
  });

  it("kind=admin · 권한 없는 워크스페이스면 그 응답 · 실행 없음", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    assertWorkspaceAccessMock.mockResolvedValue(NextResponse.json({ error: "workspace_not_found" }, { status: 404 }));
    const res = await post({ promptTexts: ["가짜 질문"] });
    expect(res.status).toBe(404);
    expect(H.purgeUntracked).not.toHaveBeenCalled();
  });

  it("JSON 형식 오류·빈 배열·모르는 칸 → 400, 실행 없음", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    for (const [body, raw] of [
      ["{broken", true],
      [{ promptTexts: [] }, false],
      [{ promptTexts: ["가"], action: "purge" }, false],
      [{ texts: ["가"] }, false],
    ] as const) {
      const res = await post(body, raw);
      expect(res.status).toBe(400);
    }
    expect(H.state.txCount).toBe(0);
  });

  it("경로 id 가 UUID 가 아니면 400 invalid_id", async () => {
    const res = await post({ promptTexts: ["가"] }, false, "../other");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_id" });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("트랜잭션 안에서 오류 → 500 고정 코드, 본문에 원문 없음", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    H.purgeUntracked.mockRejectedValueOnce(new Error('Failed query: delete from "drift_alerts" …'));
    const res = await post({ promptTexts: ["가짜 질문"] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "archive_purge_failed" });
  });
});
