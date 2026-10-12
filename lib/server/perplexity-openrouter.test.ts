/**
 * perplexity-openrouter.test.ts — Perplexity 를 OpenRouter(perplexity/sonar)로 묻는 시험 경로 단위 테스트.
 * 계획 geotracker-pplx-openrouter-261012 v2 §8-2.
 *
 * 전역 fetch 는 가짜다 — 실제 OpenRouter 에는 한 건도 요청하지 않는다(호출마다 과금).
 * 하루 상한 저장소는 메모리 가짜다(DB 저장소는 perplexity-openrouter.int.test.ts 가 시험한다).
 * ⚠️ PUBLIC 저장소 — 질문·답·주소·키는 전부 가짜 값이다(도메인은 .test).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PPLX_OR_BLOCK_MS,
  PPLX_OR_MODEL,
  PPLX_OR_TIMEOUT_MS,
  __resetOpenRouterStateForTest,
  callPerplexityViaOpenRouter,
  classifyOpenRouterError,
  dailyCapKey,
  extractReferencedCitations,
  getPerplexityBackend,
  getPerplexityDailyCap,
  getPerplexityManualDailyCap,
  isPerplexityOncePerDay,
  parseOpenRouterRetryAfterMs,
  resolveOpenRouterKey,
  shouldLimitPerplexityDaily,
  toScrapeRecord,
  type DailyCapStore,
  type OpenRouterCallResult,
} from "./perplexity-openrouter";

/** 테스트 전용 가짜 키 — 32자 미만이라 "긴 토큰 가림" 규칙에 기대지 않고 키 가림 자체를 시험한다. */
const FAKE_SHARED = "or-shared-fake-key-0001";
const FAKE_DEDICATED = "or-dedicated-fake-key-02";
const PROMPT = "가짜 질문 — 예시 교육기관을 추천해 주세요";
const T0 = Date.parse("2031-03-01T12:00:00+09:00");

/* ------------------------------------------------------------------
 * 도우미
 * ------------------------------------------------------------------ */

type Row = { count: number; costed: number; costUsd: number };

function memStore(opts: { failReserve?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const calls = { reserve: 0, addCost: 0 };
  const store: DailyCapStore = {
    async reserve(key, cap) {
      calls.reserve++;
      if (opts.failReserve) throw new Error("가짜 저장소 오류");
      const r = rows.get(key) ?? { count: 0, costed: 0, costUsd: 0 };
      if (r.count >= cap) return null;
      r.count++;
      rows.set(key, r);
      return r.count;
    },
    async addCost(key, costUsd) {
      calls.addCost++;
      const r = rows.get(key) ?? { count: 0, costed: 0, costUsd: 0 };
      r.costed++;
      r.costUsd += costUsd;
      rows.set(key, r);
    },
  };
  return { store, rows, calls };
}

function ann(url: unknown, title = "가짜 제목") {
  return { type: "url_citation", url_citation: { url, title, start_index: 0, end_index: 0 } };
}

function orBody(over: {
  model?: unknown;
  content?: unknown;
  annotations?: unknown;
  finish?: unknown;
  refusal?: unknown;
  cost?: unknown;
  provider?: unknown;
} = {}) {
  return {
    id: "gen-test-0001",
    object: "chat.completion",
    model: "model" in over ? over.model : PPLX_OR_MODEL,
    provider: "provider" in over ? over.provider : "Perplexity",
    choices: [
      {
        index: 0,
        finish_reason: "finish" in over ? over.finish : "stop",
        message: {
          role: "assistant",
          content: "content" in over ? over.content : "가짜 답변 첫 문장입니다 [1]. 둘째 문장입니다 [2].",
          refusal: "refusal" in over ? over.refusal : null,
          annotations:
            "annotations" in over
              ? over.annotations
              : [ann("https://example-a.test/one", "가짜 제목 하나"), ann("https://example-b.test/two", "가짜 제목 둘")],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 120, cost: "cost" in over ? over.cost : 0.004 },
  };
}

function respond(status: number, body?: unknown, headers?: Record<string, string>): Response {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

const fetchMock = vi.fn();
let logs: string[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENROUTER_KEY", FAKE_SHARED);
  vi.stubEnv("PERPLEXITY_OPENROUTER_KEY", "");
  vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "");
  __resetOpenRouterStateForTest();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetOpenRouterStateForTest();
});

/** 가짜 시계 — 호출마다 now 를 바꿀 수 있다 */
function clock(start = T0) {
  const c = { t: start, now: () => c.t };
  return c;
}

async function call(
  m: ReturnType<typeof memStore>,
  c = clock(),
  prompt = PROMPT,
  purpose: "auto" | "manual" = "auto",
): Promise<OpenRouterCallResult> {
  return callPerplexityViaOpenRouter(prompt, { store: m.store, now: c.now, purpose });
}

/* ------------------------------------------------------------------ */

describe("설정 읽기", () => {
  it.each([
    [undefined, "brightdata"],
    ["", "brightdata"],
    ["   ", "brightdata"],
    ["openrouter", "openrouter"],
    [" OpenRouter ", "openrouter"],
    ["OPENROUTER", "openrouter"],
    ["openruter", "brightdata"],
    ["brightdata", "brightdata"],
    ["openrouter2", "brightdata"],
  ])("PERPLEXITY_BACKEND=%j → %s", (value, expected) => {
    expect(getPerplexityBackend({ PERPLEXITY_BACKEND: value })).toBe(expected);
  });

  it.each([
    [undefined, 30],
    ["", 30],
    ["0", 0],
    ["10", 10],
    [" 7 ", 7],
    ["500", 500],
    ["501", 30],
    ["-1", 30],
    ["3.5", 30],
    ["abc", 30],
  ])("PERPLEXITY_OPENROUTER_DAILY_CAP=%j → %i", (value, expected) => {
    expect(getPerplexityDailyCap({ PERPLEXITY_OPENROUTER_DAILY_CAP: value })).toBe(expected);
  });

  it.each([
    [undefined, true],
    ["", true],
    ["1", true],
    ["no", true],
    ["0", false],
    ["false", false],
    [" OFF ", false],
    ["off", false],
  ])("PERPLEXITY_OPENROUTER_ONCE_PER_DAY=%j → %s", (value, expected) => {
    expect(isPerplexityOncePerDay({ PERPLEXITY_OPENROUTER_ONCE_PER_DAY: value })).toBe(expected);
  });

  it("하루 1회는 perplexity · openrouter · 켬 세 조건이 모두 맞을 때만", () => {
    const on = { PERPLEXITY_BACKEND: "openrouter" };
    expect(shouldLimitPerplexityDaily("perplexity", on)).toBe(true);
    expect(shouldLimitPerplexityDaily("chatgpt", on)).toBe(false);
    expect(shouldLimitPerplexityDaily("perplexity", {})).toBe(false);
    expect(shouldLimitPerplexityDaily("perplexity", { ...on, PERPLEXITY_OPENROUTER_ONCE_PER_DAY: "off" })).toBe(false);
  });

  it("키 — 공백 정리 후 비어 있지 않은 첫 키(전용 → 공용)", () => {
    expect(resolveOpenRouterKey({ PERPLEXITY_OPENROUTER_KEY: ` ${FAKE_DEDICATED} `, OPENROUTER_KEY: FAKE_SHARED })).toEqual({
      key: FAKE_DEDICATED,
      source: "dedicated",
    });
    expect(resolveOpenRouterKey({ PERPLEXITY_OPENROUTER_KEY: "   ", OPENROUTER_KEY: ` ${FAKE_SHARED}` })).toEqual({
      key: FAKE_SHARED,
      source: "shared",
    });
    expect(resolveOpenRouterKey({ PERPLEXITY_OPENROUTER_KEY: " ", OPENROUTER_KEY: "  " })).toBeNull();
    expect(resolveOpenRouterKey({})).toBeNull();
  });
});

describe("요청 모양 · 키 · 질문 길이", () => {
  it("POST /chat/completions · 인증 헤더 · 모델 고정 · max_tokens 4096 · usage · 국가·시스템 문장 없음 · 시간 제한", async () => {
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    const r = await call(m);
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_SHARED}`);
    expect(headers["HTTP-Referer"]).toBe("https://cms.magicbodypilates.co.kr/geo-tracker");
    expect(headers["X-Title"]).toBe("MagicBody GeoTracker");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "perplexity/sonar",
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: 4096,
      usage: { include: true },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(PPLX_OR_TIMEOUT_MS).toBe(60_000);
  });

  it("어떤 설정으로도 모델이 바뀌지 않는다", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_MODEL", "perplexity/sonar-pro");
    vi.stubEnv("OPENROUTER_MODEL", "perplexity/sonar-deep-research");
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    await call(memStore());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("perplexity/sonar");
  });

  it("전용 키가 있으면 전용 키로, 공백이면 공용 키로 보낸다", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_KEY", ` ${FAKE_DEDICATED} `);
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    await call(memStore());
    expect((fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      `Bearer ${FAKE_DEDICATED}`,
    );
    __resetOpenRouterStateForTest();
    vi.stubEnv("PERPLEXITY_OPENROUTER_KEY", "   ");
    await call(memStore());
    expect((fetchMock.mock.calls[1][1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      `Bearer ${FAKE_SHARED}`,
    );
  });

  it("두 키가 모두 공백이면 BACKEND_BLOCKED · 요청 0 · 예약 0", async () => {
    vi.stubEnv("OPENROUTER_KEY", "   ");
    vi.stubEnv("PERPLEXITY_OPENROUTER_KEY", " ");
    const m = memStore();
    const r = await call(m);
    expect(r).toMatchObject({ ok: false, code: "BACKEND_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.calls.reserve).toBe(0);
    // 키가 없다고 차단기를 켜지 않는다 — 키를 넣으면 바로 나간다
    vi.stubEnv("OPENROUTER_KEY", FAKE_SHARED);
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    expect((await call(m)).ok).toBe(true);
  });

  it("질문 1,001자 → HTTP_4XX · 요청 0 · 예약 0 / 1,000자는 보낸다", async () => {
    const m = memStore();
    const r = await call(m, clock(), "가".repeat(1001));
    expect(r).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.calls.reserve).toBe(0);
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    expect((await call(m, clock(), "가".repeat(1000))).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("extractReferencedCitations — 본문 [n] 참조분만, 원래 순서 목록으로 대응", () => {
  const A = ann("https://example-a.test/a", "제목 A");
  const B = ann("https://example-b.test/b", "제목 B");
  const C = ann("https://example-c.test/c", "제목 C");

  it("정상 — 번호 오름차순, 제목 유지, 설명은 빈 문자열", () => {
    const r = extractReferencedCitations("둘째 [3] 와 첫째 [1].", [A, B, C]);
    expect(r.citations).toEqual([
      { url: "https://example-a.test/a", title: "제목 A", description: "" },
      { url: "https://example-c.test/c", title: "제목 C", description: "" },
    ]);
    expect(r).toMatchObject({ annotationsTotal: 3, referenced: 2, outOfRange: 0, invalidRef: 0 });
  });

  it("붙은 번호 [1][2] 도 각각 · 같은 번호 여러 번은 한 번", () => {
    const r = extractReferencedCitations("문장 [1][2]. 다시 [1].", [A, B, C]);
    expect(r.citations.map((c) => c.url)).toEqual(["https://example-a.test/a", "https://example-b.test/b"]);
  });

  it("0번·범위 밖 번호는 outOfRange", () => {
    const r = extractReferencedCitations("영 [0] 다섯 [5] 하나 [1]", [A, B, C]);
    expect(r.citations).toHaveLength(1);
    expect(r.outOfRange).toBe(2);
  });

  it("중간 무효 항목이 뒤 번호를 밀지 않는다 — [A, 무효, C] 에 [2][3] → C 하나 · invalidRef 1", () => {
    const r = extractReferencedCitations("본문 [2][3]", [A, { type: "file", file: {} }, C]);
    expect(r.citations.map((c) => c.url)).toEqual(["https://example-c.test/c"]);
    expect(r.invalidRef).toBe(1);
  });

  it("주소가 http(s) 가 아니거나 비었으면 무효", () => {
    const r = extractReferencedCitations("[1][2][3][4]", [
      ann("ftp://example-a.test/x"),
      ann(""),
      ann(123),
      { type: "url_citation" },
    ]);
    expect(r.citations).toEqual([]);
    expect(r.invalidRef).toBe(4);
  });

  it("같은 주소는 처음 것만", () => {
    const r = extractReferencedCitations("[1][2]", [ann("https://example-a.test/a", "처음"), ann("https://example-a.test/a", "나중")]);
    expect(r.citations).toEqual([{ url: "https://example-a.test/a", title: "처음", description: "" }]);
    expect(r.referenced).toBe(1);
  });

  it("번호표가 없으면 빈 목록 · 목록이 배열이 아니면 전체 0", () => {
    expect(extractReferencedCitations("번호 없는 답", [A, B]).citations).toEqual([]);
    const r = extractReferencedCitations("[1]", null);
    expect(r).toMatchObject({ annotationsTotal: 0, outOfRange: 1, citations: [] });
  });

  it("[1234] 처럼 네 자리는 번호표가 아니다", () => {
    expect(extractReferencedCitations("연도 [2026] 와 [1]", [A]).outOfRange).toBe(0);
    expect(extractReferencedCitations("[1234]", [A]).citations).toEqual([]);
  });
});

describe("toScrapeRecord — 응답 검증·변환 (§5)", () => {
  it("정상 → answer_text · 참조분 인용 · backend_meta", () => {
    const r = toScrapeRecord(orBody({ cost: 0.0071 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.answer_text).toBe("가짜 답변 첫 문장입니다 [1]. 둘째 문장입니다 [2].");
    expect(r.record.citations).toHaveLength(2);
    expect(r.record.backend_meta).toEqual({
      backend: "openrouter",
      model: "perplexity/sonar",
      upstream: "Perplexity",
      costUsd: 0.0071,
      annotationsTotal: 2,
      referenced: 2,
      outOfRange: 0,
      invalidRef: 0,
      truncated: false,
    });
  });

  it.each([
    ["perplexity/sonar-pro"],
    ["Perplexity/Sonar"],
    [""],
    [undefined],
  ])("응답 모델 %j 는 정확히 같지 않아 HTTP_4XX", (model) => {
    expect(toScrapeRecord(orBody({ model }))).toMatchObject({ ok: false, code: "HTTP_4XX" });
  });

  it("거절문 → HTTP_4XX · 빈 거절문은 정상", () => {
    expect(toScrapeRecord(orBody({ refusal: "답할 수 없습니다" }))).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(toScrapeRecord(orBody({ refusal: "" })).ok).toBe(true);
  });

  it("content_filter → HTTP_4XX · error → SUBMIT_UNKNOWN", () => {
    expect(toScrapeRecord(orBody({ finish: "content_filter" }))).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(toScrapeRecord(orBody({ finish: "error" }))).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
  });

  it("length → 저장하되 truncated 표시", () => {
    const r = toScrapeRecord(orBody({ finish: "length" }));
    expect(r.ok && r.record.backend_meta.truncated).toBe(true);
  });

  it("본문이 문자열이 아니면 빈 답으로 넘긴다(정규화가 PARSE_FAILURE 로 실패시킨다)", () => {
    for (const content of [null, 42, [{ text: "x" }]]) {
      const r = toScrapeRecord(orBody({ content }));
      expect(r.ok && r.record.answer_text).toBe("");
    }
  });

  it("종료 사유 없음·stop·그 밖 → 정상 · 비용 없으면 null", () => {
    for (const finish of [undefined, "stop", "tool_calls"]) {
      const r = toScrapeRecord(orBody({ finish, cost: undefined }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.record.backend_meta.costUsd).toBeNull();
    }
  });
});

describe("classifyOpenRouterError — 상태 코드 분류", () => {
  it.each([
    [401, "BACKEND_BLOCKED", true],
    [402, "BACKEND_BLOCKED", true],
    [403, "HTTP_4XX", false],
    [400, "HTTP_4XX", false],
    [404, "HTTP_4XX", false],
    [413, "HTTP_4XX", false],
    [422, "HTTP_4XX", false],
    [408, "SUBMIT_UNKNOWN", false],
    [429, "RATE_LIMITED", false],
    [500, "SUBMIT_UNKNOWN", false],
    [502, "SUBMIT_UNKNOWN", false],
    [599, "SUBMIT_UNKNOWN", false],
    [0, "SUBMIT_UNKNOWN", false],
    [302, "SUBMIT_UNKNOWN", false],
  ])("%i → %s (차단기 %s)", (status, code, block) => {
    const c = classifyOpenRouterError(status as number, { code: status, message: "가짜 오류" });
    expect(c.code).toBe(code);
    expect(c.blockBackend).toBe(block);
    expect(c.message.startsWith(`${status} `)).toBe(true);
    expect(c.message).toContain("가짜 오류");
  });

  it("본문 오류 메시지는 앞 200자만", () => {
    const c = classifyOpenRouterError(400, { message: "나".repeat(500) });
    expect(Array.from(c.message).length).toBeLessThanOrEqual(220);
  });
});

describe("parseOpenRouterRetryAfterMs — 초·날짜·없음·이상값·120초 상한", () => {
  const NOW = Date.parse("2031-01-01T00:00:00Z");
  it.each([
    ["10", 10_000],
    ["0", 0],
    [null, 30_000],
    ["", 30_000],
    ["soon", 30_000],
    ["-5", 30_000],
    ["999", 120_000],
    ["Wed, 01 Jan 2031 00:01:00 GMT", 60_000],
    ["Wed, 01 Jan 2031 01:00:00 GMT", 120_000],
    ["Tue, 31 Dec 2030 23:00:00 GMT", 0],
  ])("%j → %i", (value, expected) => {
    expect(parseOpenRouterRetryAfterMs(value, NOW)).toBe(expected);
  });
});

describe("오류 분류 — HTTP 상태로 받을 때와 200 + 본문 오류로 받을 때 결과가 같다", () => {
  const cases: [number | string, string][] = [
    [400, "HTTP_4XX"],
    [401, "BACKEND_BLOCKED"],
    [402, "BACKEND_BLOCKED"],
    [403, "HTTP_4XX"],
    [404, "HTTP_4XX"],
    [408, "SUBMIT_UNKNOWN"],
    [429, "RATE_LIMITED"],
    [500, "SUBMIT_UNKNOWN"],
    [503, "SUBMIT_UNKNOWN"],
    ["unknown_code", "SUBMIT_UNKNOWN"],
  ];
  it.each(cases)("%s → %s", async (code, expected) => {
    const errBody = { error: { code, message: "가짜 오류 문구" } };
    const httpStatus = typeof code === "number" ? code : 500;

    __resetOpenRouterStateForTest();
    fetchMock.mockResolvedValueOnce(respond(httpStatus, errBody, { "Retry-After": "7" }));
    const viaHttp = await call(memStore());

    __resetOpenRouterStateForTest();
    fetchMock.mockResolvedValueOnce(respond(200, errBody, { "Retry-After": "7" }));
    const viaBody = await call(memStore());

    if (typeof code === "number") {
      expect(viaHttp).toEqual(viaBody);
      expect(viaHttp).toMatchObject({ ok: false, code: expected });
    } else {
      // 본문 오류 코드가 숫자가 아니면 상태 0 → 불명
      expect(viaBody).toMatchObject({ ok: false, code: expected });
    }
    if (expected === "RATE_LIMITED") expect(viaBody).toMatchObject({ retryAfterMs: 7_000 });
  });

  it("JSON 이 아닌 오류 본문(예: 게이트웨이 HTML 502)도 분류된다", async () => {
    fetchMock.mockResolvedValueOnce(respond(502, "<html>bad gateway</html>"));
    expect(await call(memStore())).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
  });
});

describe("차단기 — 401·402 뒤 30분 · 만료 뒤 재확인 1건", () => {
  it.each([401, 402])("%i 뒤 다음 호출은 네트워크 없이 BACKEND_BLOCKED · 예약도 안 한다", async (status) => {
    const m = memStore();
    const c = clock();
    fetchMock.mockResolvedValueOnce(respond(status, { error: { code: status, message: "가짜" } }));
    expect(await call(m, c)).toMatchObject({ ok: false, code: "BACKEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.calls.reserve).toBe(1); // 실패한 호출도 1건으로 센다

    c.t += PPLX_OR_BLOCK_MS - 1000;
    expect(await call(m, c)).toMatchObject({ ok: false, code: "BACKEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.calls.reserve).toBe(1);
  });

  it("30분 뒤 동시 4건 → 실제 요청은 정확히 1건(재확인) · 나머지 3건은 네트워크 없이 차단", async () => {
    const m = memStore();
    const c = clock();
    fetchMock.mockResolvedValueOnce(respond(402, { error: { code: 402, message: "가짜 잔액 부족" } }));
    await call(m, c);
    c.t += PPLX_OR_BLOCK_MS + 1;
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    const results = await Promise.all([call(m, c), call(m, c), call(m, c), call(m, c)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "BACKEND_BLOCKED")).toHaveLength(3);
  });

  it("재확인 성공 → 차단 해제(다음 호출은 바로 나간다)", async () => {
    const m = memStore();
    const c = clock();
    fetchMock.mockResolvedValueOnce(respond(401, { error: { code: 401, message: "가짜" } }));
    await call(m, c);
    c.t += PPLX_OR_BLOCK_MS + 1;
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    expect((await call(m, c)).ok).toBe(true);
    expect((await call(m, c)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("재확인이 다시 401 → 또 30분 차단", async () => {
    const m = memStore();
    const c = clock();
    fetchMock.mockImplementation(async () => respond(401, { error: { code: 401, message: "가짜" } }));
    await call(m, c);
    c.t += PPLX_OR_BLOCK_MS + 1;
    expect(await call(m, c)).toMatchObject({ ok: false, code: "BACKEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    c.t += PPLX_OR_BLOCK_MS - 1000;
    await call(m, c);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    c.t += 2000;
    await call(m, c);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("재확인 1건이 하루 상한에서 막혀도 재확인 표시는 풀린다", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "1");
    const m = memStore();
    const c = clock();
    fetchMock.mockResolvedValueOnce(respond(402, { error: { code: 402, message: "가짜" } }));
    await call(m, c); // 1건 예약 — 상한 도달
    c.t += PPLX_OR_BLOCK_MS + 1;
    expect(await call(m, c)).toMatchObject({ ok: false, code: "DAILY_CAP" });
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "5");
    fetchMock.mockResolvedValueOnce(respond(200, orBody()));
    expect((await call(m, c)).ok).toBe(true); // "재확인 중" 으로 굳지 않았다
  });

  it("403 은 차단기를 켜지 않는다 — 그 질문만 실패하고 다음 호출은 정상 요청", async () => {
    const m = memStore();
    fetchMock.mockResolvedValueOnce(respond(403, { error: { code: 403, message: "가짜 거부" } }));
    expect(await call(m)).toMatchObject({ ok: false, code: "HTTP_4XX" });
    fetchMock.mockResolvedValueOnce(respond(200, orBody()));
    expect((await call(m)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("429 대기 — 대기 중에는 네트워크 없이 RATE_LIMITED", () => {
  it("Retry-After 10초 → 10초 동안 요청 0 · 지나면 다시 보낸다", async () => {
    const m = memStore();
    const c = clock();
    fetchMock.mockResolvedValueOnce(respond(429, { error: { code: 429, message: "가짜 몰림" } }, { "Retry-After": "10" }));
    expect(await call(m, c)).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: 10_000 });
    c.t += 4_000;
    const waiting = await call(m, c);
    expect(waiting).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: 6_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.calls.reserve).toBe(1);
    c.t += 6_001;
    fetchMock.mockResolvedValueOnce(respond(200, orBody()));
    expect((await call(m, c)).ok).toBe(true);
  });

  it.each([
    [undefined, 30_000],
    ["soon", 30_000],
    ["3600", 120_000],
  ])("Retry-After %j → 대기 %i ms", async (header, expected) => {
    fetchMock.mockResolvedValueOnce(
      respond(429, { error: { code: 429, message: "가짜" } }, header === undefined ? undefined : { "Retry-After": header }),
    );
    expect(await call(memStore())).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: expected });
  });

  it("Retry-After HTTP 날짜 → 남은 시간", async () => {
    const c = clock();
    fetchMock.mockResolvedValueOnce(
      respond(429, { error: { code: 429 } }, { "Retry-After": new Date(T0 + 45_000).toUTCString() }),
    );
    expect(await call(memStore(), c)).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 45_000 });
  });
});

describe("네트워크 오류·시간 초과·해석 실패 → SUBMIT_UNKNOWN", () => {
  it("fetch 거부 · 시간 초과 · 200 인데 JSON 이 아님", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    fetchMock.mockResolvedValueOnce(respond(200, "<html>not json</html>"));
    const m = memStore();
    const a = await call(m);
    const b = await call(m);
    const d = await call(m);
    expect(a).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
    expect(b).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
    if (!b.ok) expect(b.message).toContain("TimeoutError");
    expect(d).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
    expect(m.rows.get(dailyCapKey(new Date(T0)))).toMatchObject({ count: 3, costed: 0 }); // 비용 불명 3건
  });

  it("200 인데 본문이 비었거나 JSON 객체가 아니면 SUBMIT_UNKNOWN (모델 불일치로 보지 않는다)", async () => {
    fetchMock.mockImplementationOnce(async () => respond(200, ""));
    fetchMock.mockImplementationOnce(async () => respond(200, "[]"));
    fetchMock.mockImplementationOnce(async () => respond(200, "42"));
    const m = memStore();
    for (let i = 0; i < 3; i++) expect(await call(m)).toMatchObject({ ok: false, code: "SUBMIT_UNKNOWN" });
  });
});

describe("하루 상한 — 모든 요청은 예약 성공 뒤에만", () => {
  it("상한 2 → 세 번째는 요청 0 · DAILY_CAP", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "2");
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    expect((await call(m)).ok).toBe(true);
    expect((await call(m)).ok).toBe(true);
    expect(await call(m)).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("상한 0 → 예약도 요청도 하지 않는다", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "0");
    const m = memStore();
    expect(await call(m)).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.calls.reserve).toBe(0);
  });

  it("저장소 오류 → 요청하지 않는다(fail-closed)", async () => {
    const m = memStore({ failReserve: true });
    expect(await call(m)).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("동시 10건 · 상한 3 → 실제 요청 정확히 3건", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "3");
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    const results = await Promise.all(Array.from({ length: 10 }, () => call(m)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.code === "DAILY_CAP")).toHaveLength(7);
  });

  it("자정 직전에 예약하고 자정 뒤 응답 → 비용은 예약한 날짜 키로", async () => {
    const m = memStore();
    const c = clock(Date.parse("2031-03-01T23:59:59.500+09:00"));
    fetchMock.mockImplementation(async () => {
      c.t = Date.parse("2031-03-02T00:00:01+09:00");
      return respond(200, orBody({ cost: 0.0042 }));
    });
    expect((await call(m, c)).ok).toBe(true);
    expect([...m.rows.keys()]).toEqual(["openrouter_pplx_daily:2031-03-01"]);
    expect(m.rows.get("openrouter_pplx_daily:2031-03-01")).toEqual({ count: 1, costed: 1, costUsd: 0.0042 });
  });
});

describe("비용 기록", () => {
  it("usage.cost 가 있으면 기록 · 없거나 음수·문자열이면 기록하지 않는다(비용 불명)", async () => {
    const m = memStore();
    for (const cost of [0.003, undefined, -1, "0.004", 0]) {
      fetchMock.mockResolvedValueOnce(respond(200, orBody({ cost })));
      await call(m);
    }
    expect(m.rows.get(dailyCapKey(new Date(T0)))).toEqual({ count: 5, costed: 2, costUsd: 0.003 });
  });

  it("모델 불일치는 실패지만 과금됐으므로 비용은 기록한다", async () => {
    const m = memStore();
    fetchMock.mockResolvedValueOnce(respond(200, orBody({ model: "perplexity/sonar-pro", cost: 0.02 })));
    expect(await call(m)).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(m.calls.addCost).toBe(1);
  });

  it("비용 기록이 실패해도 결과는 그대로 돌려준다", async () => {
    const m = memStore();
    m.store.addCost = async () => {
      throw new Error("가짜 저장 실패");
    };
    fetchMock.mockResolvedValueOnce(respond(200, orBody()));
    expect((await call(m)).ok).toBe(true);
  });
});

describe("키·원문 미노출 · 인증 오류 코드 미사용", () => {
  it("응답 본문·예외 메시지에 키가 있어도 반환 문구·로그에 남지 않는다", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_KEY", FAKE_DEDICATED);
    const m = memStore();
    fetchMock.mockResolvedValueOnce(
      respond(500, { error: { code: 500, message: `upstream echo ${FAKE_DEDICATED} ${FAKE_SHARED} Bearer ${FAKE_DEDICATED}` } }),
    );
    fetchMock.mockRejectedValueOnce(new Error(`socket closed for Bearer ${FAKE_DEDICATED} / ${FAKE_SHARED}`));
    fetchMock.mockResolvedValueOnce(respond(401, { error: { code: 401, message: `invalid key ${FAKE_SHARED}` } }));
    const results = [await call(m), await call(m), await call(m)];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.message).not.toContain(FAKE_DEDICATED);
      expect(r.message).not.toContain(FAKE_SHARED);
      expect(r.message).not.toContain(PROMPT);
    }
    const joined = logs.join("\n");
    expect(joined).not.toContain(FAKE_DEDICATED);
    expect(joined).not.toContain(FAKE_SHARED);
    expect(joined).not.toContain(PROMPT);
  });

  it("성공 로그에도 질문·답 원문이 없다 · 설정 로그는 프로세스당 1번(키 값 없이 출처만)", async () => {
    vi.stubEnv("PERPLEXITY_BACKEND", "openrouter");
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody({ cost: 0.0071 })));
    await call(m);
    await call(m);
    const configLines = logs.filter((l) => l.includes(" config "));
    expect(configLines).toEqual([
      "[openrouter-pplx] config backend=openrouter model=perplexity/sonar cap=30 manualCap=10 key=shared",
    ]);
    const callLines = logs.filter((l) => l.includes(" status=200 "));
    expect(callLines).toHaveLength(2);
    expect(callLines[0]).toMatch(
      /^\[openrouter-pplx\] status=200 ms=\d+ cost=0\.0071 cited=2\/2 oor=0 inv=0 trunc=0 use=auto day=2031-03-01 n=1$/,
    );
    const joined = logs.join("\n");
    expect(joined).not.toContain(PROMPT);
    expect(joined).not.toContain("가짜 답변");
  });

  it("어떤 응답에도 인증 오류 코드를 돌려주지 않는다", async () => {
    const statuses = [200, 400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504];
    const seen = new Set<string>();
    for (const s of statuses) {
      __resetOpenRouterStateForTest();
      fetchMock.mockResolvedValueOnce(respond(s, s === 200 ? orBody() : { error: { code: s, message: "가짜" } }));
      const r = await call(memStore());
      seen.add(r.ok ? "ok" : r.code);
      __resetOpenRouterStateForTest();
      fetchMock.mockResolvedValueOnce(respond(200, { error: { code: s, message: "가짜" } }));
      const r2 = await call(memStore());
      seen.add(r2.ok ? "ok" : r2.code);
    }
    __resetOpenRouterStateForTest();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const r3 = await call(memStore());
    seen.add(r3.ok ? "ok" : r3.code);
    expect([...seen].sort()).toEqual(["BACKEND_BLOCKED", "HTTP_4XX", "RATE_LIMITED", "SUBMIT_UNKNOWN", "ok"]);
  });

  it("모듈 소스에 인증 오류 코드 문자열이 없고, fetch 호출 지점은 1곳이다", () => {
    const src = readFileSync(resolve(__dirname, "perplexity-openrouter.ts"), "utf8");
    expect(src).not.toContain("AUTH_" + "ERROR");
    // 실행 코드의 fetch 호출은 doFetch( 한 곳뿐(주석·타입 제외)
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code.match(/\bdoFetch\(/g)).toHaveLength(1);
    expect(code.match(/(?<![.\w])fetch\(/g)).toBeNull();
    // brightdata-scraper 를 값으로 가져오지 않는다(순환 방지)
    expect(src).not.toMatch(/from\s+["'][^"']*brightdata-scraper["']/);
    // DB 는 지연 import 만
    expect(src).not.toMatch(/^import[^\n]*["']@\/lib\/server\/db["']/m);
  });
});

/* ==================================================================
 * 1회차 검수 반영 — 결함 대장 F1·F4 · S-1 · S-2 · S-3 · S-4
 * ================================================================== */

describe("F1·F4 — 차단 해제 재확인은 정상 응답일 때만 차단을 푼다", () => {
  /** 402 로 차단 → 30분 뒤 재확인 1건이 probeEnd 로 끝난다 → 5초 뒤 다음 호출 */
  async function probeThen(probeEnd: () => Promise<Response>) {
    const m = memStore();
    const c = clock();
    fetchMock.mockImplementationOnce(async () => respond(402, { error: { code: 402, message: "가짜 잔액 부족" } }));
    await call(m, c);
    c.t += PPLX_OR_BLOCK_MS + 1;
    fetchMock.mockImplementationOnce(probeEnd);
    const probe = await call(m, c);
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    c.t += 5_000; // 재확인 직후(429 대기 1초는 지났고 30분 차단 안쪽)
    const next = await call(m, c);
    return { m, c, probe, next };
  }

  const uncertainEnds: [string, () => Promise<Response>, string][] = [
    ["네트워크 오류", async () => { throw new TypeError("fetch failed"); }, "SUBMIT_UNKNOWN"],
    ["시간 초과", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "SUBMIT_UNKNOWN"],
    ["503", async () => respond(503, { error: { code: 503, message: "가짜" } }), "SUBMIT_UNKNOWN"],
    ["408", async () => respond(408, { error: { code: 408, message: "가짜" } }), "SUBMIT_UNKNOWN"],
    ["200 + 본문 오류 코드 불명", async () => respond(200, { error: { code: "weird", message: "가짜" } }), "SUBMIT_UNKNOWN"],
    ["200 인데 해석 불가", async () => respond(200, "<html>not json</html>"), "SUBMIT_UNKNOWN"],
    ["429", async () => respond(429, { error: { code: 429, message: "가짜" } }, { "Retry-After": "1" }), "RATE_LIMITED"],
    ["403", async () => respond(403, { error: { code: 403, message: "가짜" } }), "HTTP_4XX"],
  ];

  it.each(uncertainEnds)("재확인이 %s 로 끝나면 차단을 다시 30분 건다 — 바로 다음 호출은 요청 0", async (_name, end, code) => {
    const r = await probeThen(end);
    expect(r.probe).toMatchObject({ ok: false, code });
    expect(r.next).toMatchObject({ ok: false, code: "BACKEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 처음 402 1회 + 재확인 1회. 다음 호출은 나가지 않았다
    // 다시 30분 뒤에는 재확인 1건이 또 나가고, 이번엔 정상 응답이라 풀린다
    r.c.t += PPLX_OR_BLOCK_MS;
    expect((await call(r.m, r.c)).ok).toBe(true);
    expect((await call(r.m, r.c)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("재확인이 정상 응답이면(뒤 검증에서 모델 불일치로 실패해도) 차단을 푼다 — 키·잔액은 살아 있다", async () => {
    const r = await probeThen(async () => respond(200, orBody({ model: "perplexity/sonar-pro" })));
    expect(r.probe).toMatchObject({ ok: false, code: "HTTP_4XX" });
    expect(r.next.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("재확인이 정상 성공이면 풀린다(기존 동작 유지)", async () => {
    const r = await probeThen(async () => respond(200, orBody()));
    expect(r.probe.ok).toBe(true);
    expect(r.next.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("S-1 — 키 모양 문자열은 일부만 나와도 가린다", () => {
  // 진짜 키가 아니다(단어가 섞인 가짜 조각). 소스 점검이 이 고정값을 키로 오인하지 않게 나눠 쓴다.
  const KEY_LIKE_FRAGMENT = "sk-" + "or-v1-" + "fakefragment0123";

  it.each([
    [500, `upstream rejected key ${KEY_LIKE_FRAGMENT}... (ends with 9z8y7x)`],
    [401, `invalid credentials: ${KEY_LIKE_FRAGMENT}`],
  ])("HTTP %i 오류 문구 속 키 앞부분 조각이 반환 문구·로그에 남지 않는다", async (status, message) => {
    fetchMock.mockImplementationOnce(async () => respond(status, { error: { code: status, message } }));
    const r = await call(memStore());
    if (r.ok) throw new Error("실패여야 한다");
    expect(r.message).not.toContain("fakefragment0123");
    expect(r.message).toContain("***");
    expect(logs.join("\n")).not.toContain("fakefragment0123");
  });

  it("짧은 sk- 단어(8자 미만)와 단어 중간의 sk- 는 건드리지 않는다", () => {
    const c = classifyOpenRouterError(400, { message: "task-runner sk-short risk-assessment" });
    expect(c.message).toContain("task-runner sk-short risk-assessment");
  });
});

describe("S-2 — 인용 제목 500자 · 주소 2,048자 · 답 20,000자 상한", () => {
  const base = "https://example-a.test/";
  const urlOf = (len: number) => base + "a".repeat(len - base.length);

  it("제목 500자 초과는 500자로 잘라 저장한다(인용은 유지) · 500자는 그대로", () => {
    const r = extractReferencedCitations("[1][2]", [ann(urlOf(40), "가".repeat(501)), ann(urlOf(41), "나".repeat(500))]);
    expect(r.citations).toHaveLength(2);
    expect(Array.from(r.citations[0].title)).toHaveLength(500);
    expect(r.citations[1].title).toBe("나".repeat(500));
  });

  it("제목이 200만 자여도 500자만 남는다", () => {
    const r = extractReferencedCitations("[1]", [ann(urlOf(40), "x".repeat(2_000_000))]);
    expect(r.citations[0].title).toHaveLength(500);
  });

  it("주소 2,048자는 저장 · 2,049자는 버리고(invalidRef) 뒤 번호는 밀리지 않는다", () => {
    const r = extractReferencedCitations("[1][2][3]", [ann(urlOf(2048)), ann(urlOf(2049)), ann("https://example-c.test/c")]);
    expect(r.citations.map((x) => x.url.length)).toEqual([2048, "https://example-c.test/c".length]);
    expect(r.invalidRef).toBe(1);
  });

  it("답 20,000자는 저장 · 20,001자는 저장하지 않고 HTTP_4XX · 정상 길이(1～2천 자)는 그대로", () => {
    const at = toScrapeRecord(orBody({ content: "다".repeat(19_996) + " [1]" }));
    expect(at.ok && Array.from(at.record.answer_text).length).toBe(20_000);
    expect(toScrapeRecord(orBody({ content: "다".repeat(20_001) }))).toMatchObject({ ok: false, code: "HTTP_4XX" });
    const normal = "예시 기관을 소개하는 가짜 문장입니다 [1]. ".repeat(60); // 약 1,700자
    const r = toScrapeRecord(orBody({ content: normal }));
    expect(r.ok && r.record.answer_text).toBe(normal);
  });

  it("답 상한 초과는 과금된 응답이라 비용은 기록하고 재시도 대상이 아닌 HTTP_4XX 로 끝난다", async () => {
    const m = memStore();
    fetchMock.mockImplementationOnce(async () => respond(200, orBody({ content: "라".repeat(20_001), cost: 0.01 })));
    const r = await call(m);
    expect(r).toMatchObject({ ok: false, code: "HTTP_4XX" });
    if (!r.ok) expect(r.message).toContain("답이 너무 김");
    expect(m.calls.addCost).toBe(1);
  });
});

describe("S-3 — 계정정보가 든 주소는 인용에서 버린다", () => {
  it.each([
    ["https://user:pass@example-a.test/x"],
    ["https://user@example-a.test/x"],
    ["https://:pw@example-a.test/x"],
    ["http://id:secret@example-b.test:8080/path?q=1"],
  ])("%s → 버림(invalidRef)", (url) => {
    const r = extractReferencedCitations("[1][2]", [ann(url), ann("https://example-c.test/ok")]);
    expect(r.citations.map((c) => c.url)).toEqual(["https://example-c.test/ok"]);
    expect(r.invalidRef).toBe(1);
  });

  it("대문자 스킴·포트·쿼리가 있는 평범한 주소는 그대로 저장한다", () => {
    const urls = ["HTTP://EXAMPLE-A.TEST/Up", "https://example-b.test:8443/p?q=1#f"];
    const r = extractReferencedCitations("[1][2]", urls.map((u) => ann(u)));
    expect(r.citations.map((c) => c.url)).toEqual(urls);
  });
});

describe("S-4 — 수동 수집은 날짜별 별도 행 · 별도 상한(기본 10)", () => {
  it.each([
    [undefined, 10],
    ["", 10],
    ["0", 0],
    ["3", 3],
    ["500", 500],
    ["501", 10],
    ["abc", 10],
  ])("PERPLEXITY_OPENROUTER_MANUAL_DAILY_CAP=%j → %i", (value, expected) => {
    expect(getPerplexityManualDailyCap({ PERPLEXITY_OPENROUTER_MANUAL_DAILY_CAP: value })).toBe(expected);
  });

  it("행 키 — 자동 openrouter_pplx_daily:<날짜> · 수동 openrouter_pplx_manual_daily:<날짜>", () => {
    const d = new Date("2031-03-01T23:30:00+09:00");
    expect(dailyCapKey(d)).toBe("openrouter_pplx_daily:2031-03-01");
    expect(dailyCapKey(d, "auto")).toBe("openrouter_pplx_daily:2031-03-01");
    expect(dailyCapKey(d, "manual")).toBe("openrouter_pplx_manual_daily:2031-03-01");
  });

  it("수동 10건을 다 써도 자동 수집은 그대로 나간다 — 11번째 수동만 DAILY_CAP", async () => {
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    for (let i = 0; i < 10; i++) expect((await call(m, clock(), PROMPT, "manual")).ok).toBe(true);
    expect(await call(m, clock(), PROMPT, "manual")).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect((await call(m, clock(), PROMPT, "auto")).ok).toBe(true);
    expect(m.rows.get("openrouter_pplx_manual_daily:2031-03-01")).toMatchObject({ count: 10 });
    expect(m.rows.get("openrouter_pplx_daily:2031-03-01")).toMatchObject({ count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("자동 상한이 차도 수동은 자기 상한으로 나간다 · 자동 상한 설정은 수동에 영향이 없다", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "1");
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    expect((await call(m)).ok).toBe(true);
    expect(await call(m)).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect((await call(m, clock(), PROMPT, "manual")).ok).toBe(true);
    vi.stubEnv("PERPLEXITY_OPENROUTER_DAILY_CAP", "0");
    expect((await call(m, clock(), PROMPT, "manual")).ok).toBe(true);
  });

  it("수동 상한 0 → 수동은 예약·요청 0 · 자동은 그대로", async () => {
    vi.stubEnv("PERPLEXITY_OPENROUTER_MANUAL_DAILY_CAP", "0");
    const m = memStore();
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    expect(await call(m, clock(), PROMPT, "manual")).toMatchObject({ ok: false, code: "DAILY_CAP" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.calls.reserve).toBe(0);
    expect((await call(m)).ok).toBe(true);
  });

  it("호출 로그에 용도가 남는다(use=manual)", async () => {
    fetchMock.mockImplementation(async () => respond(200, orBody()));
    await call(memStore(), clock(), PROMPT, "manual");
    expect(logs.some((l) => / status=200 .* use=manual day=2031-03-01 n=1$/.test(l))).toBe(true);
  });
});
