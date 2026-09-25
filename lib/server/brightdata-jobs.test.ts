/**
 * brightdata-jobs.test.ts — 자동 수집 엔진용 Bright Data 단계별 호출(제출·진행 확인·내려받기·취소)
 * 단위 테스트. 계획 geotracker-collect-speed-260924 Step 1 (§4 테스트).
 *
 * 전역 fetch 를 가짜로 바꿔 실제 Bright Data 에는 한 건도 요청하지 않는다(수집 1건마다 과금).
 * 키 값도 테스트 전용 가짜 값이다. 이 저장소는 PUBLIC 이라 실제 질문 문구·키·운영 식별자를 쓰지 않는다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BRIGHTDATA_TIMEOUTS_MS,
  cancelSnapshot,
  downloadSnapshotPayload,
  getSnapshotProgress,
  parseRetryAfterMs,
  submitScrape,
} from "./brightdata-scraper";

/** 테스트 전용 가짜 키 — 오류 문구에 새어 나가지 않는지 확인하는 표식으로도 쓴다. */
const FAKE_KEY = "fake-test-key-0123456789abcdefghijklmnopqrstuvwxyz";
const PROMPT = "테스트 질문 — 예시 교육기관을 추천해 주세요";

const fetchMock = vi.fn();

function respond(status: number, body?: unknown, headers?: Record<string, string>): Response {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("BRIGHT_DATA_KEY", FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("submitScrape — 지금 쓰는 동기 요청(/scrape)과 같은 호출", () => {
  it("요청 형식: POST /datasets/v3/scrape + notify=false·include_errors=true·format=json + { input: [레코드] } + 시간 제한", async () => {
    fetchMock.mockResolvedValue(respond(200, [{ answer_text: "충분히 긴 테스트 답변 문장입니다. 예시 기관 소개." }]));
    await submitScrape({ provider: "perplexity", prompt: PROMPT, country: "KR" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.brightdata\.com\/datasets\/v3\/scrape\?dataset_id=[^&]+&notify=false&include_errors=true&format=json$/);
    expect(init.method).toBe("POST");
    // Perplexity 는 국가를 넘겨받아도 싣지 않는다(2026-09-25 § PERPLEXITY_NO_COUNTRY — 안전망).
    expect(JSON.parse(String(init.body))).toEqual({
      input: [{ url: "https://www.perplexity.ai", prompt: PROMPT, index: 1 }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(BRIGHTDATA_TIMEOUTS_MS.submit).toBe(90_000);
  });

  it("Google AI 는 국가 KR 을 그대로 싣는다(Perplexity 변경과 무관)", async () => {
    fetchMock.mockResolvedValue(respond(200, [{ answer_text: "충분히 긴 테스트 답변 문장입니다. 예시 기관 소개." }]));
    await submitScrape({ provider: "google_ai", prompt: PROMPT, country: "KR" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).input[0].country).toBe("KR");
  });

  it("200 → 결과 본문(payload) — 요청 번호 없음", async () => {
    const payload = [{ answer_text: "충분히 긴 테스트 답변 문장입니다." }];
    fetchMock.mockResolvedValue(respond(200, payload));
    const r = await submitScrape({ provider: "gemini", prompt: PROMPT });
    expect(r).toEqual({ ok: true, kind: "payload", payload });
  });

  it("202 → 요청 번호(snapshotId)", async () => {
    fetchMock.mockResolvedValue(respond(202, { snapshot_id: "s_test_0001" }));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r).toEqual({ ok: true, kind: "snapshot", snapshotId: "s_test_0001" });
  });

  it("202 인데 요청 번호가 없으면 접수 여부 불명(SUBMIT_UNKNOWN) — 이어받을 수 없다", async () => {
    fetchMock.mockResolvedValue(respond(202, { message: "accepted" }));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUBMIT_UNKNOWN");
  });

  it("429 + Retry-After: 30 → RATE_LIMITED · 30000ms", async () => {
    fetchMock.mockResolvedValue(respond(429, { message: "too many running jobs" }, { "Retry-After": "30" }));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: 30_000 });
  });

  it("429 + Retry-After HTTP 날짜 → 남은 시간(ms)", async () => {
    const at = new Date(Date.now() + 120_000).toUTCString();
    fetchMock.mockResolvedValue(respond(429, "", { "Retry-After": at }));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "RATE_LIMITED") {
      expect(r.retryAfterMs).not.toBeNull();
      expect(r.retryAfterMs!).toBeGreaterThan(115_000);
      expect(r.retryAfterMs!).toBeLessThanOrEqual(120_000);
    } else {
      throw new Error("RATE_LIMITED 가 아니다");
    }
  });

  it("429 + 읽을 수 없는 Retry-After → retryAfterMs null", async () => {
    fetchMock.mockResolvedValue(respond(429, "", { "Retry-After": "soon" }));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: null });
  });

  it("401·403 → AUTH_ERROR (작업 안 생김)", async () => {
    fetchMock.mockResolvedValueOnce(respond(401, "unauthorized"));
    fetchMock.mockResolvedValueOnce(respond(403, "forbidden"));
    expect(await submitScrape({ provider: "chatgpt", prompt: PROMPT })).toMatchObject({ ok: false, code: "AUTH_ERROR" });
    expect(await submitScrape({ provider: "chatgpt", prompt: PROMPT })).toMatchObject({ ok: false, code: "AUTH_ERROR" });
  });

  it("400 → HTTP_4XX (입력 거절)", async () => {
    fetchMock.mockResolvedValue(respond(400, { error: "country is not available for this scraper" }));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r).toMatchObject({ ok: false, code: "HTTP_4XX" });
    if (!r.ok) expect(r.message.startsWith("400 ")).toBe(true);
  });

  it("500 → SUBMIT_UNKNOWN (작업이 생겼을 수 있다)", async () => {
    fetchMock.mockResolvedValue(respond(500, "internal error"));
    expect(await submitScrape({ provider: "chatgpt", prompt: PROMPT })).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
  });

  it("네트워크 예외 → SUBMIT_UNKNOWN", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await submitScrape({ provider: "chatgpt", prompt: PROMPT })).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
  });

  it("시간 초과로 중단 → SUBMIT_UNKNOWN", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
    if (!r.ok) expect(r.message).toContain("TimeoutError");
  });

  it("200 인데 본문을 해석하지 못하면 SUBMIT_UNKNOWN (결과를 받을 방법이 없어 다시 보낸다)", async () => {
    fetchMock.mockResolvedValue(respond(200, "<html>not json</html>"));
    expect(await submitScrape({ provider: "chatgpt", prompt: PROMPT })).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
  });

  it("키가 없으면 요청하지 않고 AUTH_ERROR", async () => {
    vi.stubEnv("BRIGHT_DATA_KEY", "");
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r).toMatchObject({ ok: false, code: "AUTH_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("모르는 AI 이름이면 요청하지 않고 HTTP_4XX", async () => {
    const r = await submitScrape({ provider: "unknown_ai" as never, prompt: PROMPT });
    expect(r).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getSnapshotProgress — 진행 확인", () => {
  it.each(["starting", "running", "ready", "failed", "canceled"] as const)("status=%s 를 그대로 돌려준다", async (status) => {
    fetchMock.mockResolvedValue(respond(200, { status }));
    expect(await getSnapshotProgress("s_test_0002")).toEqual({ ok: true, status });
  });

  it("영국식 표기 cancelled 도 canceled 로 본다", async () => {
    fetchMock.mockResolvedValue(respond(200, { status: "cancelled" }));
    expect(await getSnapshotProgress("s_test_0002")).toEqual({ ok: true, status: "canceled" });
  });

  it("records·errors 숫자가 있으면 함께 돌려준다 (M2 실측 필드)", async () => {
    fetchMock.mockResolvedValue(respond(200, { status: "ready", records: 0, errors: 1 }));
    expect(await getSnapshotProgress("s_test_0003")).toEqual({ ok: true, status: "ready", records: 0, errors: 1 });
  });

  it("모르는 상태 문자열은 running 으로 본다", async () => {
    fetchMock.mockResolvedValue(respond(200, { status: "collecting" }));
    expect(await getSnapshotProgress("s_test_0004")).toEqual({ ok: true, status: "running" });
  });

  it("요청 주소 — GET /datasets/v3/progress/<id> · 15초 제한", async () => {
    fetchMock.mockResolvedValue(respond(200, { status: "running" }));
    await getSnapshotProgress("s_test_0005");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brightdata.com/datasets/v3/progress/s_test_0005");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(BRIGHTDATA_TIMEOUTS_MS.progress).toBe(15_000);
  });

  it("404 → SNAPSHOT_MISSING · 401 → AUTH_ERROR · 400 → HTTP_4XX · 500 → NETWORK · 예외 → NETWORK", async () => {
    fetchMock.mockResolvedValueOnce(respond(404, "not found"));
    fetchMock.mockResolvedValueOnce(respond(401, "unauthorized"));
    fetchMock.mockResolvedValueOnce(respond(400, "bad"));
    fetchMock.mockResolvedValueOnce(respond(500, "boom"));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await getSnapshotProgress("a")).toMatchObject({ ok: false, code: "SNAPSHOT_MISSING" });
    expect(await getSnapshotProgress("a")).toMatchObject({ ok: false, code: "AUTH_ERROR" });
    expect(await getSnapshotProgress("a")).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(await getSnapshotProgress("a")).toMatchObject({ ok: false, code: "NETWORK" });
    expect(await getSnapshotProgress("a")).toMatchObject({ ok: false, code: "NETWORK" });
  });
});

describe("downloadSnapshotPayload — 결과 내려받기", () => {
  it("200 → payload · 요청 주소 GET /datasets/v3/snapshot/<id>?format=json · 60초 제한", async () => {
    const payload = [{ answer_text: "충분히 긴 테스트 답변 문장입니다." }];
    fetchMock.mockResolvedValue(respond(200, payload));
    expect(await downloadSnapshotPayload("s_test_0006")).toEqual({ ok: true, payload });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brightdata.com/datasets/v3/snapshot/s_test_0006?format=json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(BRIGHTDATA_TIMEOUTS_MS.download).toBe(60_000);
  });

  it("202 → NOT_READY", async () => {
    fetchMock.mockResolvedValue(respond(202, { status: "building" }));
    expect(await downloadSnapshotPayload("s")).toMatchObject({ ok: false, code: "NOT_READY" });
  });

  it("500 → DOWNLOAD_FAILED · 403 → AUTH_ERROR · 예외 → NETWORK", async () => {
    fetchMock.mockResolvedValueOnce(respond(500, "boom"));
    fetchMock.mockResolvedValueOnce(respond(403, "forbidden"));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await downloadSnapshotPayload("s")).toMatchObject({ ok: false, code: "DOWNLOAD_FAILED" });
    expect(await downloadSnapshotPayload("s")).toMatchObject({ ok: false, code: "AUTH_ERROR" });
    expect(await downloadSnapshotPayload("s")).toMatchObject({ ok: false, code: "NETWORK" });
  });
});

describe("cancelSnapshot — 실패는 삼킨다", () => {
  it("요청 주소 POST /datasets/v3/snapshot/<id>/cancel", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    await cancelSnapshot("s_test_0007");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brightdata.com/datasets/v3/snapshot/s_test_0007/cancel");
    expect(init.method).toBe("POST");
  });

  it("500·예외여도 예외 없이 끝나고, 로그에는 코드만 남는다(요청 번호·키 없음)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(respond(500, `boom ${FAKE_KEY}`));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(cancelSnapshot("s_secretish_0008")).resolves.toBeUndefined();
    await expect(cancelSnapshot("s_secretish_0008")).resolves.toBeUndefined();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("HTTP 500");
    expect(logged).toContain("NETWORK");
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).not.toContain("s_secretish_0008");
  });
});

describe("오류 문구 — 키 값·URL 쿼리·긴 토큰이 남지 않는다", () => {
  it("응답 본문에 키·Bearer 값·쿼리 있는 URL 이 있어도 가린다", async () => {
    const body =
      `upstream failure: Authorization: Bearer ${FAKE_KEY} while calling ` +
      "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_test&token=abc123 " +
      "trace=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-zz";
    fetchMock.mockResolvedValue(respond(500, body));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain(FAKE_KEY);
    expect(r.message).not.toContain("token=abc123");
    expect(r.message).not.toContain("?");
    expect(r.message).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(r.message).toContain("https://api.brightdata.com/datasets/v3/scrape");
    expect(r.message.startsWith("500 ")).toBe(true);
  });

  it("예외 메시지에 들어온 키도 가린다", async () => {
    fetchMock.mockRejectedValue(new Error(`socket closed for Bearer ${FAKE_KEY}`));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    if (r.ok) throw new Error("실패여야 한다");
    expect(r.message).not.toContain(FAKE_KEY);
  });

  it("긴 본문은 300자(+상태 코드)로 자른다", async () => {
    fetchMock.mockResolvedValue(respond(500, "가".repeat(1000)));
    const r = await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    if (r.ok) throw new Error("실패여야 한다");
    expect(Array.from(r.message).length).toBeLessThanOrEqual(304);
  });
});

describe("parseRetryAfterMs", () => {
  const NOW = Date.parse("2026-01-01T00:00:00Z");
  it("초 → ms", () => {
    expect(parseRetryAfterMs("30", NOW)).toBe(30_000);
    expect(parseRetryAfterMs(" 0 ", NOW)).toBe(0);
  });
  it("HTTP 날짜 → 남은 ms, 과거는 0", () => {
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:02:00 GMT", NOW)).toBe(120_000);
    expect(parseRetryAfterMs("Wed, 31 Dec 2025 23:00:00 GMT", NOW)).toBe(0);
  });
  it("비었거나 못 읽으면 null", () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs("", NOW)).toBeNull();
    expect(parseRetryAfterMs("soon", NOW)).toBeNull();
  });
});
