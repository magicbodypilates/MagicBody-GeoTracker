/**
 * brightdata-normalize.test.ts — 받은 결과 판정(normalizeScrapePayload)·크롤러 오류 세분·
 * 오류 문구 가림 단위 테스트 + runAiScraper 동작 불변 확인.
 * 계획 geotracker-collect-speed-260924 Step 1 (§4 테스트 · Hard Gate "runAiScraper 동작 불변").
 *
 * 전역 fetch 는 가짜다 — 실제 Bright Data 에는 요청하지 않는다. 키는 테스트 전용 가짜 값.
 * 이 저장소는 PUBLIC 이라 실제 질문 문구·브랜드·운영 식별자를 쓰지 않는다(도메인은 .example).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ScrapeFailure,
  classifyCrawlerError,
  clearScrapeCache,
  detectNonAnswer,
  isCrawlerCode,
  isKnownProvider,
  meaningfulText,
  normalizeScrapePayload,
  redactErrorText,
  runAiScraper,
} from "./brightdata-scraper";

const PROMPT = "테스트 질문 — 예시 교육기관을 추천해 주세요";
const ANSWER =
  "예시 교육기관은 해부학 기반 커리큘럼으로 알려져 있습니다. 자세한 내용은 https://edu.example/about 에서 볼 수 있습니다.";

function failureOf(fn: () => unknown): ScrapeFailure {
  try {
    fn();
  } catch (err) {
    if (err instanceof ScrapeFailure) return err;
    throw new Error(`ScrapeFailure 가 아닌 예외: ${String(err)}`);
  }
  throw new Error("예외가 나지 않았다");
}

describe("normalizeScrapePayload — 정상 결과", () => {
  it("정상 레코드 → 답변·출처·구조화 인용", () => {
    const r = normalizeScrapePayload({
      provider: "perplexity",
      prompt: PROMPT,
      payload: [
        {
          answer_text: ANSWER,
          answer_html: "<p>지워져야 하는 HTML</p>",
          citations: [
            { url: "https://news.example/a", title: "예시 기사", description: "설명" },
            "https://blog.example/b",
            { url: "https://news.example/a", title: "중복" },
          ],
          snapshot_id: "s_inline_0001",
        },
      ],
    });
    expect(r.provider).toBe("perplexity");
    expect(r.prompt).toBe(PROMPT);
    expect(r.answer).toBe(ANSWER);
    expect(r.cached).toBe(false);
    expect(r.snapshotId).toBe("s_inline_0001");
    expect(r.citations).toEqual([
      { url: "https://news.example/a", domain: "news.example", title: "예시 기사", description: "설명" },
      { url: "https://blog.example/b", domain: "blog.example", title: "", description: "" },
    ]);
    expect(r.sources).toEqual(["https://edu.example/about", "https://news.example/a", "https://blog.example/b"]);
    expect(JSON.stringify(r.raw)).not.toContain("answer_html");
  });

  it("배열이 아닌 단일 객체 payload 도 받는다", () => {
    const r = normalizeScrapePayload({ provider: "gemini", prompt: PROMPT, payload: { answer_text: ANSWER } });
    expect(r.answer).toBe(ANSWER);
  });

  it("답변과 오류 필드가 함께 있으면 정상으로 본다(지금 가드와 같음)", () => {
    const r = normalizeScrapePayload({
      provider: "perplexity",
      prompt: PROMPT,
      payload: [{ answer_text: ANSWER, error: "partial warning", error_code: "warn" }],
    });
    expect(r.answer).toBe(ANSWER);
  });
});

describe("normalizeScrapePayload — 실패 판정", () => {
  it("not-ready placeholder → NOT_READY (문구 접두사 불변)", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "gemini",
        prompt: PROMPT,
        payload: [{ message: "Dataset is not ready yet, try again in 30s" }],
      }),
    );
    expect(f.code).toBe("NOT_READY");
    expect(f.message).toBe("[NOT_READY] Bright Data placeholder (provider=gemini)");
  });

  it("M1 실측 — 가입 화면 차단 → CRAWLER_AUTH_WALL (메시지 접두사는 그대로 [CRAWLER_ERROR])", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "perplexity",
        prompt: PROMPT,
        payload: [{ timestamp: "2026-09-24T12:00:00.000Z", error: "Auth wall: sign-up prompt detected", error_code: "crawl_failed" }],
      }),
    );
    expect(f.code).toBe("CRAWLER_AUTH_WALL");
    expect(f.message).toBe(
      "[CRAWLER_ERROR] Bright Data 수집 실패 (provider=perplexity): Auth wall: sign-up prompt detected",
    );
  });

  it("M1 실측 — 브라우저 끊김 → CRAWLER_BROWSER_DISCONNECTED", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "google_ai", prompt: PROMPT, payload: [{ error: "Browser disconnected" }] }),
    );
    expect(f.code).toBe("CRAWLER_BROWSER_DISCONNECTED");
  });

  it("2026-08-29 기록 증상 — 선택자 시간 초과 → CRAWLER_SELECTOR_TIMEOUT", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "perplexity",
        prompt: PROMPT,
        payload: [{ error: "Crawler error: waiting for selector `main` failed: timeout 30000ms exceeded" }],
      }),
    );
    expect(f.code).toBe("CRAWLER_SELECTOR_TIMEOUT");
  });

  it("error_code 만 있어도 크롤러 오류 — 분류 입력은 error 와 error_code 를 이어 붙인 문자열", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "copilot", prompt: PROMPT, payload: [{ error_code: "login_required" }] }),
    );
    expect(f.code).toBe("CRAWLER_AUTH_WALL");
    expect(f.message).toContain("login_required");
  });

  it("그 밖 수집기 오류 → CRAWLER_ERROR", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "grok", prompt: PROMPT, payload: [{ error: "Unexpected page state" }] }),
    );
    expect(f.code).toBe("CRAWLER_ERROR");
  });

  it("빈 배열 → PARSE_FAILURE (문구 접두사 불변)", () => {
    const f = failureOf(() => normalizeScrapePayload({ provider: "chatgpt", prompt: PROMPT, payload: [] }));
    expect(f.code).toBe("PARSE_FAILURE");
    expect(f.message.startsWith("[PARSE_FAILURE] 답변 필드를 찾지 못했다 (provider=chatgpt) — [응답 파싱 실패 —")).toBe(true);
  });

  it("메타 키만 있는 레코드 → PARSE_FAILURE", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "perplexity",
        prompt: PROMPT,
        payload: [{ url: "https://www.perplexity.ai", prompt: PROMPT, timestamp: "2026-09-24T12:00:00.000Z" }],
      }),
    );
    expect(f.code).toBe("PARSE_FAILURE");
  });

  it("M2 — 결과가 비었고 진행 확인이 records 0 · errors 1 이면 CRAWLER_ERROR", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "perplexity", prompt: PROMPT, payload: [], progress: { records: 0, errors: 1 } }),
    );
    expect(f.code).toBe("CRAWLER_ERROR");
    expect(f.message).toBe("[CRAWLER_ERROR] Bright Data 수집 실패 (provider=perplexity): progress: records 0 · errors 1");
  });

  it("진행 확인이 records 0 · errors 0 이면 여전히 PARSE_FAILURE", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "perplexity", prompt: PROMPT, payload: [], progress: { records: 0, errors: 0 } }),
    );
    expect(f.code).toBe("PARSE_FAILURE");
  });
});

describe("classifyCrawlerError · isCrawlerCode", () => {
  it("단어 경계 — 'catalog index'·'blogging' 은 로그인으로 오탐하지 않는다", () => {
    expect(classifyCrawlerError("catalog index missing")).toBe("CRAWLER_ERROR");
    expect(classifyCrawlerError("blogging platform error")).toBe("CRAWLER_ERROR");
    expect(classifyCrawlerError("catalog_index_missing")).toBe("CRAWLER_ERROR");
    expect(classifyCrawlerError("blog_in_progress")).toBe("CRAWLER_ERROR");
    expect(classifyCrawlerError("logintime exceeded")).toBe("CRAWLER_ERROR");
  });
  it("밑줄로 이어 쓴 오류 코드도 잡는다", () => {
    expect(classifyCrawlerError("login_required")).toBe("CRAWLER_AUTH_WALL");
    expect(classifyCrawlerError("auth_wall")).toBe("CRAWLER_AUTH_WALL");
    expect(classifyCrawlerError("browser_disconnected")).toBe("CRAWLER_BROWSER_DISCONNECTED");
  });
  it("가입·로그인 표현 변형", () => {
    expect(classifyCrawlerError("Please log in to continue")).toBe("CRAWLER_AUTH_WALL");
    expect(classifyCrawlerError("Log-in wall")).toBe("CRAWLER_AUTH_WALL");
    expect(classifyCrawlerError("signup required")).toBe("CRAWLER_AUTH_WALL");
    expect(classifyCrawlerError("AUTHWALL detected")).toBe("CRAWLER_AUTH_WALL");
  });
  it("브라우저 끊김·선택자 시간 초과", () => {
    expect(classifyCrawlerError("Browser has disconnected unexpectedly")).toBe("CRAWLER_BROWSER_DISCONNECTED");
    expect(classifyCrawlerError("timeout 30000 ms exceeded")).toBe("CRAWLER_SELECTOR_TIMEOUT");
  });
  it("순서 — 가입 화면 차단이 먼저 이긴다", () => {
    expect(classifyCrawlerError("Auth wall after browser disconnected")).toBe("CRAWLER_AUTH_WALL");
  });
  it("isCrawlerCode 는 CRAWLER_ 접두사로 판정", () => {
    expect(isCrawlerCode("CRAWLER_AUTH_WALL")).toBe(true);
    expect(isCrawlerCode("CRAWLER_ERROR")).toBe(true);
    expect(isCrawlerCode("PARSE_FAILURE")).toBe(false);
    expect(isCrawlerCode("TIMEOUT")).toBe(false);
  });
  it("isKnownProvider", () => {
    expect(isKnownProvider("perplexity")).toBe(true);
    expect(isKnownProvider("google_ai")).toBe(true);
    expect(isKnownProvider("unknown_ai")).toBe(false);
  });
});

describe("redactErrorText", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("키 값 · Bearer 값 · URL 쿼리 · 32자 이상 토큰을 가리고 max 자로 자른다", () => {
    vi.stubEnv("BRIGHT_DATA_KEY", "shortkey1234");
    const s = redactErrorText(
      "key=shortkey1234 Authorization: Bearer abc.def-ghi https://x.example/p?a=1&b=2 tok=0123456789abcdefghijABCDEFGHIJ0123 done",
    );
    expect(s).not.toContain("shortkey1234");
    expect(s).not.toContain("abc.def-ghi");
    expect(s).not.toContain("?a=1");
    expect(s).toContain("https://x.example/p");
    expect(s).not.toContain("0123456789abcdefghijABCDEFGHIJ0123");
    expect(s).toContain("done");
  });

  it("max 는 글자 단위 — 한글이 반쪽으로 잘리지 않는다", () => {
    expect(redactErrorText("가나다라마", 3)).toBe("가나다");
    expect(Array.from(redactErrorText("나".repeat(500))).length).toBe(300);
  });

  it("질문 문구 같은 일반 한국어는 그대로 둔다", () => {
    expect(redactErrorText(PROMPT)).toBe(PROMPT);
  });
});

/**
 * runAiScraper 동작 불변 — 판정 블록을 normalizeScrapePayload 로 옮긴 뒤에도 수동 수집 경로의
 * 결과·오류 문구·perplexity 지역값 재시도·캐시가 옮기기 전과 같아야 한다(Hard Gate).
 */
describe("runAiScraper — 동작 불변", () => {
  const fetchMock = vi.fn();
  const globalForFallback = globalThis as unknown as { __perplexityCountryFailedAt?: number };

  function respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BRIGHT_DATA_KEY", "fake-test-key-for-runaiscraper");
    clearScrapeCache();
    delete globalForFallback.__perplexityCountryFailedAt;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearScrapeCache();
    delete globalForFallback.__perplexityCountryFailedAt;
  });

  it("200 → 정규화 결과, 같은 요청 두 번째는 캐시(cached=true·요청 없음)", async () => {
    fetchMock.mockResolvedValue(respond(200, [{ answer_text: ANSWER }]));
    const a = await runAiScraper({ provider: "chatgpt", prompt: PROMPT });
    expect(a.answer).toBe(ANSWER);
    expect(a.cached).toBe(false);
    const b = await runAiScraper({ provider: "chatgpt", prompt: PROMPT });
    expect(b.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("202 → 진행 확인 → 내려받기 경로도 그대로", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(202, { snapshot_id: "s_manual_0001" }))
      .mockResolvedValueOnce(respond(200, { status: "ready" }))
      .mockResolvedValueOnce(respond(200, [{ answer_text: ANSWER }]));
    const r = await runAiScraper({ provider: "chatgpt", prompt: PROMPT });
    expect(r.answer).toBe(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("perplexity + 지역값 + 크롤러 오류(가입 화면 차단) → 지역값 없이 1회 재시도, 이후 6시간 지역값 생략", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(respond(200, [{ error: "Auth wall: sign-up prompt detected" }]))
      .mockResolvedValueOnce(respond(200, [{ answer_text: ANSWER }]))
      .mockResolvedValueOnce(respond(200, [{ answer_text: ANSWER }]));
    const r = await runAiScraper({ provider: "perplexity", prompt: PROMPT, country: "KR" });
    expect(r.answer).toBe(ANSWER);
    const first = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    const second = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(first.input[0].country).toBe("KR");
    expect(second.input[0].country).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[PERPLEXITY_COUNTRY_FALLBACK]"))).toBe(true);

    // 억제 기간 — 다른 질문도 처음부터 지역값 없이 보낸다.
    await runAiScraper({ provider: "perplexity", prompt: `${PROMPT} 2`, country: "KR" });
    const third = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body));
    expect(third.input[0].country).toBeUndefined();
  });

  it("억제 중 크롤러 오류는 재귀하지 않고 [CRAWLER_ERROR] 로 던진다", async () => {
    globalForFallback.__perplexityCountryFailedAt = Date.now();
    fetchMock.mockResolvedValue(respond(200, [{ error: "Auth wall: sign-up prompt detected" }]));
    await expect(runAiScraper({ provider: "perplexity", prompt: PROMPT, country: "KR" })).rejects.toThrow(
      "[CRAWLER_ERROR] Bright Data 수집 실패 (provider=perplexity): Auth wall: sign-up prompt detected",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("perplexity 가 아니면 크롤러 오류를 그대로 던진다(문구 불변)", async () => {
    fetchMock.mockResolvedValue(respond(200, [{ error: "Browser disconnected" }]));
    await expect(runAiScraper({ provider: "google_ai", prompt: PROMPT, country: "KR" })).rejects.toThrow(
      "[CRAWLER_ERROR] Bright Data 수집 실패 (provider=google_ai): Browser disconnected",
    );
  });

  it("not-ready · 파싱 실패 문구 불변", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, [{ message: "Dataset is not ready yet, try again in 30s" }]));
    await expect(runAiScraper({ provider: "gemini", prompt: PROMPT })).rejects.toThrow(
      "[NOT_READY] Bright Data placeholder (provider=gemini)",
    );
    fetchMock.mockResolvedValueOnce(respond(200, []));
    await expect(runAiScraper({ provider: "gemini", prompt: `${PROMPT} 2` })).rejects.toThrow(
      "[PARSE_FAILURE] 답변 필드를 찾지 못했다 (provider=gemini)",
    );
  });
});

/**
 * 내용 없는 답(EMPTY_ANSWER) — 2026-09-25 결함 D1.
 * 운영에서 질문 문장만 돌아온 답·별표만 온 답이 정상 답으로 저장돼 통계를 끌어내렸다.
 * 질문·답은 전부 지어낸 일반 문장이다(PUBLIC 저장소).
 */
describe("detectNonAnswer — 실제 답이 아닌 경우만 가린다", () => {
  const Q = "초보자가 다니기 좋은 운동 학원을 추천해 주세요";

  it("질문을 그대로 되돌림 → prompt_echo", () => {
    expect(detectNonAnswer(Q, Q)?.reason).toBe("prompt_echo");
  });

  it("공백·문장부호·따옴표 차이와 짧은 머리말은 걷어내고 본다 → prompt_echo", () => {
    expect(detectNonAnswer(`"${Q}?"`, Q)?.reason).toBe("prompt_echo");
    expect(detectNonAnswer(`질문: ${Q.replace(/ /g, "")} …`, Q)?.reason).toBe("prompt_echo");
    expect(detectNonAnswer(`${Q}\n${Q}`, Q)?.reason).toBe("prompt_echo"); // 두 번 되돌려도 같다
  });

  it("영문 질문 되돌림은 대소문자 차이를 무시한다 → prompt_echo", () => {
    const en = "Which fitness studio is best for beginners?";
    expect(detectNonAnswer("which Fitness Studio is best for beginners", en)?.reason).toBe("prompt_echo");
  });

  it("별표·기호만 → too_few_chars (의미 문자 0)", () => {
    expect(detectNonAnswer("★ ★ ★ ★ ★", Q)).toEqual({ reason: "too_few_chars", meaningfulChars: 0 });
  });

  it("경계 — 질문 뒤 의미 문자 10자까지는 되돌림, 11자부터는 통과", () => {
    const ten = "가나다라마바사아자차";
    expect(detectNonAnswer(`${Q} ${ten}`, Q)?.reason).toBe("prompt_echo");
    expect(detectNonAnswer(`${Q} ${ten}카`, Q)).toBeNull();
  });

  it("경계 — 의미 문자 19자는 부족, 20자는 통과", () => {
    const nineteen = "가".repeat(19);
    expect(detectNonAnswer(`${nineteen}!!`, "무관한 질문")?.reason).toBe("too_few_chars");
    expect(detectNonAnswer(`${nineteen}나.`, "무관한 질문")).toBeNull();
  });

  it("오탈락 금지 — 짧지만 내용 있는 한국어 한 문장 답(100자 안팎)은 통과", () => {
    const short =
      "나이 제한은 거의 없습니다. 기초 체력이 약해도 강사가 동작 강도를 조절해 주므로 처음 시작하는 분도 부담 없이 따라갈 수 있고, 첫 달은 주 2회를 권합니다.";
    expect(short.length).toBeGreaterThan(80);
    expect(detectNonAnswer(short, Q)).toBeNull();
  });

  it("오탈락 금지 — 짧은 영문 답은 통과", () => {
    expect(detectNonAnswer("Yes, most studios accept beginners of any age.", "Can beginners join?")).toBeNull();
  });

  it("오탈락 금지 — 질문을 인용한 뒤 긴 내용이 이어지는 답은 통과", () => {
    const quoted = `"${Q}" 라는 질문에 답하면, 수업 인원이 적고 동작 설명이 자세한 곳을 고르는 것이 좋습니다. 체험 수업을 먼저 들어 보세요.`;
    expect(detectNonAnswer(quoted, Q)).toBeNull();
  });

  it("다른 문자로 쓴 정상 답을 의미 문자 0 으로 버리지 않는다", () => {
    expect(detectNonAnswer("初心者でも安心して通えるスタジオを選ぶのがおすすめです。", Q)).toBeNull();
  });

  it("질문이 비어 있으면 되돌림 판정을 하지 않고 글자 수만 본다", () => {
    expect(detectNonAnswer("충분히 긴 정상 답변 문장이 여기에 이어집니다 정말로", "")).toBeNull();
    expect(meaningfulText(" ★ A-b 1 ")).toBe("ab1");
  });
});

describe("normalizeScrapePayload — 내용 없는 답(EMPTY_ANSWER)", () => {
  it("질문 되돌림 → EMPTY_ANSWER · 문구에 길이·사유만(답·질문 원문 없음)", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "perplexity", prompt: PROMPT, payload: [{ answer_text: PROMPT }] }),
    );
    expect(f.code).toBe("EMPTY_ANSWER");
    expect(f.message).toBe(
      `[EMPTY_ANSWER] 실제 답이 아닌 응답 (provider=perplexity) — 질문 되돌림 · 답 길이 ${PROMPT.length}자 · 의미 문자 ${meaningfulText(PROMPT).length}자`,
    );
    expect(f.message).not.toContain("예시 교육기관");
    expect(isCrawlerCode(f.code)).toBe(false); // perplexity 지역값 재시도 대상이 아니다
  });

  it("별표만 → EMPTY_ANSWER(의미 문자 부족)", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "chatgpt", prompt: PROMPT, payload: [{ answer_text: "★ ★ ★ ★ ★" }] }),
    );
    expect(f.code).toBe("EMPTY_ANSWER");
    expect(f.message).toBe("[EMPTY_ANSWER] 실제 답이 아닌 응답 (provider=chatgpt) — 의미 문자 부족 · 답 길이 9자 · 의미 문자 0자");
  });

  it("답 필드가 아예 없으면 여전히 PARSE_FAILURE 가 먼저다(판정 순서 불변)", () => {
    const f = failureOf(() => normalizeScrapePayload({ provider: "gemini", prompt: PROMPT, payload: [] }));
    expect(f.code).toBe("PARSE_FAILURE");
  });
});

describe("runAiScraper — 내용 없는 답은 던지고 캐시에 남기지 않는다", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BRIGHT_DATA_KEY", "fake-test-key-for-empty-answer");
    clearScrapeCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearScrapeCache();
  });

  it("되돌림 답 → [EMPTY_ANSWER] 로 던지고, 같은 요청을 다시 하면 캐시가 아니라 새로 받는다", async () => {
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    fetchMock
      .mockResolvedValueOnce(respond([{ answer_text: PROMPT }]))
      .mockResolvedValueOnce(respond([{ answer_text: ANSWER }]));
    await expect(runAiScraper({ provider: "perplexity", prompt: PROMPT })).rejects.toThrow("[EMPTY_ANSWER]");
    const r = await runAiScraper({ provider: "perplexity", prompt: PROMPT });
    expect(r.answer).toBe(ANSWER);
    expect(r.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
