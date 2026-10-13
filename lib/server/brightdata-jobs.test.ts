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
// OpenRouter Perplexity 경로 추가 테스트용(계획 geotracker-pplx-openrouter-261012 v2 §8-2 — 파일 끝 묶음)
import { ScrapeFailure, clearScrapeCache, redactErrorText, runAiScraper } from "./brightdata-scraper";
import { __resetOpenRouterStateForTest, type DailyCapStore } from "./perplexity-openrouter";

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

describe("수동 조회 라우트(/api/scrape) — 국가 기본값 KR (2026-10-14 · 검수 1회차 결함 3)", () => {
  it.each([
    ["국가 칸 없음", undefined],
    ["빈 문자열", ""],
    ["공백·소문자", " kr "],
  ])("%s → ChatGPT·Gemini 요청에 KR 을 싣는다", async (_name, country) => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/scrape/route");
    for (const provider of ["chatgpt", "gemini"] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(respond(200, [{ answer_text: "충분히 긴 테스트 답변 문장입니다. 예시 기관 소개와 수업 안내." }]));
      const body: Record<string, unknown> = { provider, prompt: PROMPT, forceRefresh: true };
      if (country !== undefined) body.country = country;
      const res = await POST(new NextRequest("http://localhost/api/scrape", { method: "POST", body: JSON.stringify(body) }));
      expect(res.status).toBe(200);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).input[0].country).toBe("KR");
    }
  });
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

/* ------------------------------------------------------------------
 * OpenRouter Perplexity 경로 (계획 geotracker-pplx-openrouter-261012 v2 §1-3 · §8-2)
 * 설정 PERPLEXITY_BACKEND=openrouter 일 때 Perplexity 만 OpenRouter 로 간다. 하루 상한 저장소는 메모리 가짜.
 * ------------------------------------------------------------------ */
describe("OpenRouter Perplexity 경로 — 설정 PERPLEXITY_BACKEND=openrouter", () => {
  const OR_KEY = "or-jobs-fake-key-0001";
  const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
  const OR_ANSWER = "가짜 답변 첫 문장입니다 [1]. 둘째 문장은 예시 기관의 교육 과정을 소개합니다 [3].";
  const orAnn = (url: string, title: string) => ({ type: "url_citation", url_citation: { url, title } });
  const orOk = (content = OR_ANSWER) => ({
    model: "perplexity/sonar",
    provider: "Perplexity",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content,
          annotations: [
            orAnn("https://example-a.test/one", "가짜 제목 하나"),
            orAnn("https://example-b.test/two", "본문이 참조하지 않은 검색 결과"),
            orAnn("https://example-c.test/three", "가짜 제목 셋"),
          ],
        },
      },
    ],
    usage: { cost: 0.003 },
  });
  const orErr = (status: number) => ({ error: { code: status, message: "가짜 오류" } });
  const BD_PAYLOAD = [{ answer_text: "충분히 긴 테스트 답변 문장입니다. 예시 기관 소개 — Bright Data 경로." }];

  let capLeft = 100;
  const store: DailyCapStore = {
    reserve: async () => (capLeft-- > 0 ? 1 : null),
    addCost: async () => {},
  };

  beforeEach(() => {
    capLeft = 100;
    __resetOpenRouterStateForTest({ store });
    clearScrapeCache();
    vi.stubEnv("OPENROUTER_KEY", OR_KEY);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    __resetOpenRouterStateForTest();
    clearScrapeCache();
  });

  it("submitScrape(perplexity) → OpenRouter 로 보내고 200 즉시 결과(kind:payload) · Bright Data 레코드 모양", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    fetchMock.mockImplementation(async () => respond(200, orOk()));
    const r = await submitScrape({ provider: "perplexity", prompt: PROMPT, country: "KR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OR_URL);
    expect(r.ok && r.kind).toBe("payload");
    if (!r.ok || r.kind !== "payload") return;
    const [rec] = r.payload as { answer_text: string; citations: { url: string }[]; backend_meta: Record<string, unknown> }[];
    expect(rec.answer_text).toBe(OR_ANSWER);
    expect(rec.citations.map((c) => c.url)).toEqual(["https://example-a.test/one", "https://example-c.test/three"]);
    expect(rec.backend_meta).toMatchObject({ backend: "openrouter", model: "perplexity/sonar", annotationsTotal: 3, referenced: 2 });
  });

  it("같은 설정에서도 다른 AI(chatgpt)는 Bright Data 로 간다", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    fetchMock.mockImplementation(async () => respond(200, BD_PAYLOAD));
    await submitScrape({ provider: "chatgpt", prompt: PROMPT });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.brightdata\.com\/datasets\/v3\/scrape\?/);
  });

  it.each([undefined, "", "open-router", "brightdata"])("설정 %j → Perplexity 도 Bright Data (회귀)", async (value) => {
    if (value !== undefined) vi.stubEnv("PERPLEXITY_BACKEND", value);
    fetchMock.mockImplementation(async () => respond(200, BD_PAYLOAD));
    const r = await submitScrape({ provider: "perplexity", prompt: PROMPT });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.brightdata\.com\//);
    expect(r).toEqual({ ok: true, kind: "payload", payload: BD_PAYLOAD });
  });

  it("BRIGHT_DATA_KEY 가 없어도 OpenRouter 경로는 동작한다", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    vi.stubEnv("BRIGHT_DATA_KEY", "");
    fetchMock.mockImplementation(async () => respond(200, orOk()));
    const r = await submitScrape({ provider: "perplexity", prompt: PROMPT });
    expect(r).toMatchObject({ ok: true, kind: "payload" });
  });

  it("실패 코드는 모듈 값 그대로 — 401→BACKEND_BLOCKED · 429→RATE_LIMITED · 상한→DAILY_CAP · 인증 오류 코드 없음", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    fetchMock.mockImplementationOnce(async () => respond(401, orErr(401)));
    expect(await submitScrape({ provider: "perplexity", prompt: PROMPT })).toMatchObject({ ok: false, code: "BACKEND_BLOCKED" });

    __resetOpenRouterStateForTest({ store });
    fetchMock.mockImplementationOnce(async () => respond(429, orErr(429), { "Retry-After": "20" }));
    expect(await submitScrape({ provider: "perplexity", prompt: PROMPT })).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
      retryAfterMs: 20_000,
    });

    __resetOpenRouterStateForTest({ store });
    capLeft = 0;
    const calls = fetchMock.mock.calls.length;
    expect(await submitScrape({ provider: "perplexity", prompt: PROMPT })).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect(fetchMock.mock.calls.length).toBe(calls); // 상한에 걸리면 요청하지 않는다
  });

  it("실패 문구에 OpenRouter 키가 남지 않는다", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    fetchMock.mockImplementationOnce(async () =>
      respond(500, { error: { code: 500, message: `echo ${OR_KEY} and Bearer ${OR_KEY}` } }),
    );
    const r = await submitScrape({ provider: "perplexity", prompt: PROMPT });
    if (r.ok) throw new Error("실패여야 한다");
    expect(r.code).toBe("SUBMIT_UNKNOWN");
    expect(r.message).not.toContain(OR_KEY);
  });

  it("runAiScraper — OpenRouter 결과는 본문에서 참조한 인용만 저장 형식으로 돌려준다", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    fetchMock.mockImplementation(async () => respond(200, orOk()));
    const res = await runAiScraper({ provider: "perplexity", prompt: PROMPT, country: "KR" });
    expect(res.answer).toBe(OR_ANSWER);
    expect(res.cached).toBe(false);
    expect(res.citations).toEqual([
      { url: "https://example-a.test/one", domain: "example-a.test", title: "가짜 제목 하나", description: "" },
      { url: "https://example-c.test/three", domain: "example-c.test", title: "가짜 제목 셋", description: "" },
    ]);
    expect(res.sources).toEqual(["https://example-a.test/one", "https://example-c.test/three"]);
  });

  it("runAiScraper — 실패는 원인 코드가 붙은 ScrapeFailure(문구에 키 없음)", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    fetchMock.mockImplementationOnce(async () => respond(402, { error: { code: 402, message: `no credits ${OR_KEY}` } }));
    const err = await runAiScraper({ provider: "perplexity", prompt: PROMPT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrapeFailure);
    expect((err as ScrapeFailure).code).toBe("BACKEND_BLOCKED");
    expect((err as ScrapeFailure).message.startsWith("[BACKEND_BLOCKED] OpenRouter Perplexity 수집 실패:")).toBe(true);
    expect((err as ScrapeFailure).message).not.toContain(OR_KEY);
  });

  it("캐시 키에 수집 방식이 들어간다 — 방식을 바꾸면 20분 캐시가 섞이지 않는다", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith(OR_URL) ? respond(200, orOk()) : respond(200, BD_PAYLOAD),
    );
    const viaBd = await runAiScraper({ provider: "perplexity", prompt: PROMPT });
    expect(viaBd.answer).toBe(BD_PAYLOAD[0].answer_text);

    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    const viaOr = await runAiScraper({ provider: "perplexity", prompt: PROMPT });
    expect(viaOr.cached).toBe(false);
    expect(viaOr.answer).toBe(OR_ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubEnv("PERPLEXITY_BACKEND", "");
    const again = await runAiScraper({ provider: "perplexity", prompt: PROMPT });
    expect(again.cached).toBe(true);
    expect(again.answer).toBe(BD_PAYLOAD[0].answer_text);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redactErrorText 가 OpenRouter 키 두 개(공백 정리 후 8자 이상)를 가린다", () => {
    const shared = "or-shared-key-12345";
    const dedicated = "or-dedicated-key-6789";
    vi.stubEnv("OPENROUTER_KEY", ` ${shared} `);
    vi.stubEnv("PERPLEXITY_OPENROUTER_KEY", dedicated);
    const out = redactErrorText(`upstream said ${shared} / ${dedicated}`);
    expect(out).not.toContain(shared);
    expect(out).not.toContain(dedicated);
    expect(out).toContain("[가림]");
  });
});

/* ------------------------------------------------------------------
 * 1회차 검수 반영 — S-4(수동·자동 하루 상한 분리) · S-1(키 모양 조각 가림)
 * ------------------------------------------------------------------ */
describe("OpenRouter Perplexity — 수동 수집과 자동 수집은 하루 상한 행을 따로 쓴다 (S-4)", () => {
  const OR_KEY = "or-jobs-fake-key-0002";
  const orOk = () =>
    respond(200, {
      model: "perplexity/sonar",
      provider: "Perplexity",
      choices: [{ finish_reason: "stop", message: { content: "가짜 답변 문장입니다 — 용도별 상한 시험용으로 충분히 깁니다.", annotations: [] } }],
      usage: { cost: 0.001 },
    });
  let reservedKeys: string[] = [];
  const recordingStore: DailyCapStore = {
    reserve: async (key) => {
      reservedKeys.push(key);
      return reservedKeys.length;
    },
    addCost: async () => {},
  };

  beforeEach(() => {
    reservedKeys = [];
    __resetOpenRouterStateForTest({ store: recordingStore });
    clearScrapeCache();
    vi.stubEnv("OPENROUTER_KEY", OR_KEY);
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => orOk());
  });

  afterEach(() => {
    __resetOpenRouterStateForTest();
    clearScrapeCache();
  });

  it("runAiScraper 기본(수동 수집 화면) → 수동 행 · purpose auto(예전 엔진) → 자동 행 · submitScrape(새 엔진) → 자동 행", async () => {
    await runAiScraper({ provider: "perplexity", prompt: `${PROMPT} 1` });
    await runAiScraper({ provider: "perplexity", prompt: `${PROMPT} 2`, purpose: "auto" });
    await submitScrape({ provider: "perplexity", prompt: `${PROMPT} 3` });
    expect(reservedKeys.map((k) => k.split(":")[0])).toEqual([
      "openrouter_pplx_manual_daily",
      "openrouter_pplx_daily",
      "openrouter_pplx_daily",
    ]);
  });

  it("수동 수집 라우트(/api/scrape)는 본문에 purpose:auto 를 넣어도 수동 행으로 센다(입력 규칙이 그 칸을 버린다)", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/scrape/route");
    const res = await POST(
      new NextRequest("http://localhost/api/scrape", {
        method: "POST",
        body: JSON.stringify({ provider: "perplexity", prompt: PROMPT, purpose: "auto", forceRefresh: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(reservedKeys).toHaveLength(1);
    expect(reservedKeys[0].startsWith("openrouter_pplx_manual_daily:")).toBe(true);
  });

  it("용도는 캐시 키에 들어가지 않는다 — 자동이 받은 결과를 20분 안 수동 조회가 그대로 쓴다(추가 요청 0)", async () => {
    await runAiScraper({ provider: "perplexity", prompt: PROMPT, purpose: "auto" });
    const again = await runAiScraper({ provider: "perplexity", prompt: PROMPT });
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redactErrorText 가 키 모양 조각(sk- + 8자 이상)을 일부만 나와도 가린다 (S-1)", () => {
    // 진짜 키가 아니다(단어가 섞인 가짜 조각). 소스 점검이 이 고정값을 키로 오인하지 않게 나눠 쓴다.
    const fragment = "sk-" + "or-v1-" + "fakefragment4567";
    const out = redactErrorText(`provider said key ${fragment}... is invalid`);
    expect(out).not.toContain("fakefragment4567");
    expect(out).toContain("[가림]");
    expect(redactErrorText("task-runner risk-assessment sk-short")).toBe("task-runner risk-assessment sk-short");
  });
});
