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
  answerJudgmentText,
  classifyCrawlerError,
  clearScrapeCache,
  detectNonAnswer,
  isCrawlerCode,
  isKnownProvider,
  meaningfulText,
  normalizeScrapePayload,
  redactErrorText,
  runAiScraper,
  selectAnswer,
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

/**
 * Codex 1차 검수 C1 — 판정 전용 정리(태그·엔티티·URL·출처 꼬리표). 저장 본문은 바꾸지 않는다.
 */
describe("detectNonAnswer — 태그·엔티티·URL·출처 꼬리표는 의미 문자로 세지 않는다 (C1)", () => {
  const Q = "초보자가 다니기 좋은 운동 학원을 추천해 주세요";
  const LONG =
    "초보자라면 수업 인원이 적고 동작 설명이 자세한 곳을 고르는 것이 좋습니다. 첫 달은 주 2회로 시작해 몸이 적응하면 횟수를 늘리세요.";

  it.each([
    ["태그로 감싼 질문", `<p><strong>${Q}</strong></p>`, "prompt_echo"],
    ["질문 + Sources URL", `${Q}\nSources: https://example.com/result`, "prompt_echo"],
    ["Sources URL 만", "Sources: https://example.com/result", "too_few_chars"],
    ["Access denied HTML", "<!DOCTYPE html><html><body>Access denied</body></html>", "too_few_chars"],
    ["&nbsp; 사이에 낀 질문", Q.replace(/ /g, "&nbsp;"), "prompt_echo"],
    ["숫자 엔티티로 쓴 질문", `${Q}&#46;&#x20;`, "prompt_echo"],
    ["엔티티로 감싼 태그 + 질문", `&lt;p&gt;${Q}&lt;/p&gt;`, "prompt_echo"],
    ["질문 + 마크다운 출처 목록", `${Q}\n\n**출처:**\n1. [예시 기사](https://news.example/a)\n[2]\n2. https://blog.example/b`, "prompt_echo"],
    ["References 제목 + 목록만", "## References\n- https://news.example/a\n- www.blog.example/b", "too_few_chars"],
    ["script·주석만 있는 페이지", "<html><head><script>var loadingState = 'waiting for content';</script></head><!-- placeholder --></html>", "too_few_chars"],
  ])("%s → %s", (_name, answer, reason) => {
    expect(detectNonAnswer(answer, Q)?.reason).toBe(reason);
  });

  it.each([
    ["마크다운 링크가 섞인 긴 답", `[예시 학원](https://edu.example/a)은 ${LONG} 자세한 비교는 [안내 글](https://blog.example/b)을 보세요.`],
    ["본문에 URL 을 인용한 답", `${LONG} 공식 안내는 https://edu.example/about 에서 확인할 수 있습니다.`],
    ["HTML 문단으로 감싼 정상 답", `<p>${LONG}</p>`],
    ["본문 뒤에 출처 목록이 붙은 답", `${LONG}\n\nSources:\n1. https://news.example/a\n2. https://blog.example/b`],
    ["'참고:' 줄에 본문이 이어지는 답", `참고: ${LONG}`],
    ["'참고로'로 시작하는 본문", `참고로 ${LONG}`],
    ["출처 목록 뒤에 본문이 다시 이어지는 답", `Sources: https://news.example/a\n${LONG}`],
    ["'Sources of' 로 시작하는 영문 본문", "Sources of beginner injuries are usually poor form and skipping warm-ups."],
  ])("정상 답은 통과 — %s", (_name, answer) => {
    expect(detectNonAnswer(answer, Q)).toBeNull();
  });

  it("판정용 정리는 저장 본문을 바꾸지 않는다", () => {
    const html = `<p>${LONG}</p>\nSources: https://news.example/a`;
    const r = normalizeScrapePayload({ provider: "perplexity", prompt: Q, payload: [{ answer_text: html }] });
    expect(r.answer).toBe(html);
    expect(answerJudgmentText(html)).not.toContain("<p>");
    expect(answerJudgmentText(html)).not.toContain("https://");
  });
});

/**
 * Codex 1차 검수 C2 — 후보 필드별 판정. 첫 정상 후보를 고르고, 모든 후보가 비응답일 때만 EMPTY_ANSWER.
 */
describe("selectAnswer · normalizeScrapePayload — 후보 필드별 판정 (C2)", () => {
  const NORMAL =
    "초보자에게 적합한 수업을 고르는 방법은 수업 인원, 강사의 설명 방식, 체험 수업 여부를 차례로 확인하는 것입니다.";

  it("answer_text 가 별표뿐이어도 answer_text_markdown 의 정상 답을 고른다", () => {
    const r = normalizeScrapePayload({
      provider: "chatgpt",
      prompt: PROMPT,
      payload: [{ answer_text: "★ ★ ★ ★ ★", answer_text_markdown: NORMAL }],
    });
    expect(r.answer).toBe(NORMAL);
  });

  it("앞 후보가 질문 되돌림이면 뒤의 정상 후보(answer)를 고른다", () => {
    expect(selectAnswer({ answer_text: PROMPT, answer: NORMAL }, PROMPT)).toEqual({ kind: "answer", answer: NORMAL });
  });

  it("앞 후보가 정상이면 그대로 쓴다(뒤 후보는 보지 않는다)", () => {
    expect(selectAnswer({ answer_text: ANSWER, answer_text_markdown: NORMAL }, PROMPT)).toEqual({
      kind: "answer",
      answer: ANSWER,
    });
  });

  it("모든 후보가 비응답이면 EMPTY_ANSWER — 사유·길이는 첫 후보 기준", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "perplexity",
        prompt: PROMPT,
        payload: [{ answer_text: PROMPT, answer: "★ ★" }],
      }),
    );
    expect(f.code).toBe("EMPTY_ANSWER");
    expect(f.message).toContain("질문 되돌림");
    expect(f.message).toContain(`답 길이 ${PROMPT.length}자`);
  });

  it("1차 후보가 모두 비응답이면 깊은 추출로 넘어가지 않는다(부속 필드를 답으로 오인하지 않게)", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "perplexity",
        prompt: PROMPT,
        payload: [{ answer_text: PROMPT, extra: { body: NORMAL } }],
      }),
    );
    expect(f.code).toBe("EMPTY_ANSWER");
  });

  it("1차 후보가 없으면 예전처럼 깊은 추출을 쓰고, 그 결과에도 같은 판정을 적용한다", () => {
    const ok = normalizeScrapePayload({ provider: "gemini", prompt: PROMPT, payload: [{ extra: { body: NORMAL } }] });
    expect(ok.answer).toBe(NORMAL);
    const f = failureOf(() =>
      normalizeScrapePayload({ provider: "gemini", prompt: PROMPT, payload: [{ extra: { summary: PROMPT } }] }),
    );
    expect(f.code).toBe("EMPTY_ANSWER");
  });

  it("후보가 전혀 없으면 여전히 PARSE_FAILURE", () => {
    expect(selectAnswer({ timestamp: "2026-09-25T00:00:00Z" }, PROMPT).kind).toBe("parse_failure");
  });
});

/**
 * Codex 2차 — N1(출처 줄 통째 삭제로 인한 오탈락) · C1 잔여(괄호 든 URL) · C2 잔여(후보 값 안 배열·객체).
 */
describe("detectNonAnswer — 판정 문자열 하나로 되돌림·의미 문자를 함께 판정 (N1)", () => {
  const Q = "초보자가 다니기 좋은 운동 학원을 추천해 주세요";

  it.each([
    ["출처: URL 에 따르면 …", "출처: https://report.example/2026 에 따르면 초보자는 소규모 수업에서 자세한 설명을 받는 것이 좋습니다."],
    [
      "'참고:' 아래 설명 달린 마크다운 링크 두 개",
      "참고:\n- [초보자 준비물과 첫 수업 안내](https://guide.example/a) — 운동복과 수건, 물을 챙기면 됩니다\n- [강사 설명 방식과 인원 비교](https://guide.example/b) — 한 반 인원이 적을수록 자세를 자주 봐 줍니다",
    ],
    ["영문 Sources: URL According to …", "Sources: https://report.example/a According to this report, beginners progress faster in small classes with hands-on cues."],
  ])("정상 답은 통과 — %s", (_name, answer) => {
    expect(detectNonAnswer(answer, Q)).toBeNull();
  });

  it.each([
    ["질문 + Sources URL", `${Q}\nSources: https://example.com/result`, "prompt_echo"],
    ["Sources URL 만", "Sources: https://example.com/result", "too_few_chars"],
    ["태그로 감싼 질문", `<p><strong>${Q}</strong></p>`, "prompt_echo"],
  ])("기존 거부 사례는 계속 거부 — %s", (_name, answer, reason) => {
    expect(detectNonAnswer(answer, Q)?.reason).toBe(reason);
  });

  it("판정용 문자열은 출처 이름표(콜론까지)·URL 만 지우고 링크 텍스트·설명·이름표 뒤 본문은 남긴다", () => {
    const text = "본문 한 줄\n출처: [예시 보고서](https://report.example/a) 설명 문장\n**References:** 참고 설명";
    const judged = answerJudgmentText(text);
    expect(judged).toContain("본문 한 줄");
    expect(judged).toContain("예시 보고서");
    expect(judged).toContain("설명 문장");
    expect(judged).toContain("참고 설명");
    expect(judged).not.toContain("출처");
    expect(judged).not.toContain("References");
    expect(judged).not.toContain("https://");
  });

  it("질문 + 다음 줄 '출처: URL 에 따르면 긴 본문' → 통과(이름표만 지우고 본문은 센다)", () => {
    const answer = `${Q}\n출처: https://report.example/2026 에 따르면 초보자는 수업 인원이 적고 동작 설명이 자세한 곳에서 시작하는 것이 좋습니다.`;
    expect(detectNonAnswer(answer, Q)).toBeNull();
  });

  it("질문 + 'References:' 아래 URL 목록만 → 되돌림으로 거부(유지)", () => {
    const answer = `${Q}\nReferences:\n- https://news.example/a\n- https://blog.example/b`;
    expect(detectNonAnswer(answer, Q)?.reason).toBe("prompt_echo");
  });

  it("질문을 인용한 뒤 '참고로 …' 본문이 이어지는 답 → 통과", () => {
    const answer = `"${Q}"라는 질문에 답하면,\n참고로 처음 한 달은 주 2회 수업으로 시작하고, 체험 수업에서 강사의 설명 방식을 먼저 확인해 보세요.`;
    expect(detectNonAnswer(answer, Q)).toBeNull();
  });
});

describe("URL 제거 — 괄호가 든 URL (C1 잔여)", () => {
  const Q = "집합과 함수의 차이를 알려 주세요";
  const LONG =
    "집합은 원소들의 모임이고 함수는 한 집합의 각 원소를 다른 집합의 원소 하나에 대응시키는 규칙입니다. 그래서 함수는 특별한 성질을 가진 관계로 볼 수 있습니다.";

  it("괄호 든 URL 두 개만 있는 답 → EMPTY 대상(의미 문자 부족)", () => {
    const answer = "https://wiki.example/wiki/Set_(mathematics) https://wiki.example/wiki/Function_(mathematics)";
    expect(detectNonAnswer(answer, Q)).toEqual({ reason: "too_few_chars", meaningfulChars: 0 });
  });

  it("괄호 든 URL 을 마크다운 링크로 인용한 정상 답 → 통과 · 링크 텍스트는 남고 URL 잔재는 없다", () => {
    const answer = `[집합 개념](https://wiki.example/wiki/Set_(mathematics))과 [함수 개념](https://wiki.example/wiki/Function_(mathematics))을 보면, ${LONG}`;
    expect(detectNonAnswer(answer, Q)).toBeNull();
    const content = answerJudgmentText(answer);
    expect(content).toContain("집합 개념");
    expect(content).not.toContain("mathematics");
    expect(content).not.toContain("wiki.example");
  });
});

describe("selectAnswer — 후보 키 값 안의 배열·객체 (C2 잔여)", () => {
  const NORMAL =
    "초보자에게 적합한 수업을 고르는 방법은 수업 인원, 강사의 설명 방식, 체험 수업 여부를 차례로 확인하는 것입니다.";

  it("{answer_text: 질문, content: [{text: 정상 답}]} → 정상 답", () => {
    expect(selectAnswer({ answer_text: PROMPT, content: [{ type: "text", text: NORMAL }] }, PROMPT)).toEqual({
      kind: "answer",
      answer: NORMAL,
    });
    const r = normalizeScrapePayload({
      provider: "perplexity",
      prompt: PROMPT,
      payload: [{ answer_text: PROMPT, content: [{ type: "text", text: NORMAL }] }],
    });
    expect(r.answer).toBe(NORMAL);
  });

  it("모든 후보(문자열·배열 안 문자열)가 비응답 → EMPTY_ANSWER", () => {
    const f = failureOf(() =>
      normalizeScrapePayload({
        provider: "perplexity",
        prompt: PROMPT,
        payload: [{ answer_text: PROMPT, content: [{ text: `"${PROMPT}"?` }] }],
      }),
    );
    expect(f.code).toBe("EMPTY_ANSWER");
  });

  it("후보 키 값 안에 짧은 부속 값(id·type)만 있으면 후보가 없는 것으로 보고 전역 깊은 추출을 쓴다", () => {
    const r = normalizeScrapePayload({
      provider: "gemini",
      prompt: PROMPT,
      payload: [{ content: { id: "c_0001", type: "text" }, extra: { body: NORMAL } }],
    });
    expect(r.answer).toBe(NORMAL);
  });

  it("후보가 없고 부속 필드에만 답 → 기존 깊은 추출 동작 유지", () => {
    const r = normalizeScrapePayload({ provider: "gemini", prompt: PROMPT, payload: [{ extra: { body: NORMAL } }] });
    expect(r.answer).toBe(NORMAL);
  });
});

/* ============================================================
 * 판정 기준표 (정본) — 2026-09-25 3회차
 *
 * 판정 함수 주변 지적이 회차마다 이어져(N1 → N1 잔여 → R3-1) 지금까지 나온 모든 사례를 이 표 하나로
 * 고정한다. **어떤 수정이든 이 표 전체를 깨지 않아야 한다.** 새 사례는 여기에 한 줄로 더한다.
 *   X = 거부(EMPTY_ANSWER · 저장 안 함) · O = 저장(원문 그대로) · T = 수용한 트레이드오프(저장)
 * 질문·답·도메인은 전부 지어낸 값이다(PUBLIC 저장소).
 * ============================================================ */
describe("판정 기준표 — 거부 X1～X16 · 저장 O1～O16 · 트레이드오프 T1～T2", () => {
  const Q = "초보자가 다니기 좋은 운동 학원을 추천해 주세요";
  const LONG_KO =
    "초보자라면 수업 인원이 적고 동작 설명이 자세한 곳을 고르는 것이 좋습니다. 첫 달은 주 2회로 시작해 몸이 적응하면 횟수를 늘리세요.";
  const NORMAL =
    "초보자에게 적합한 수업을 고르는 방법은 수업 인원, 강사의 설명 방식, 체험 수업 여부를 차례로 확인하는 것입니다.";
  const O1 =
    "처음 운동을 시작한다면 한 반 인원이 여섯 명 이하인 소규모 수업을 고르고, 체험 수업에서 강사가 자세를 얼마나 자주 잡아 주는지 직접 확인해 보는 것이 가장 확실한 방법입니다.";
  const O2 =
    "나이 제한은 거의 없습니다. 다만 관절이나 허리에 불편함이 있다면 첫 수업 전에 강사에게 미리 알려 주세요. 강도를 낮춘 동작으로 바꿔 주기 때문에 누구나 무리 없이 따라갈 수 있고, 몸이 익숙해지면 조금씩 강도를 올리면 됩니다.";
  const O3 =
    "Most studios welcome complete beginners. Look for small classes, clear verbal cues, and a trial session so you can judge the teaching style before you commit.";
  const urls = (n: number, prefix: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => `${prefix(i + 1)}https://ref.example/item-${i + 1}`).join("\n");
  const LONG_MD = (() => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `| ${i + 1}주차 | **기초 동작 ${i + 1}** | 호흡과 코어 안정화를 먼저 익히고 동작 범위를 조금씩 넓힙니다 |`,
    ).join("\n");
    const items = Array.from(
      { length: 60 },
      (_, i) => `- **단계 ${i + 1}**: 몸통을 곧게 세운 상태에서 천천히 움직이며 통증이 없는 범위까지만 진행합니다.`,
    ).join("\n");
    return `## 초보자 12주 계획\n\n${LONG_KO}\n\n| 주차 | 주제 | 설명 |\n|---|---|---|\n${rows}\n\n${items}\n\n${LONG_KO}`;
  })();

  type Row = { id: string; record: Record<string, unknown>; save: boolean; answer?: string };
  const text = (id: string, answerText: string, save: boolean): Row => ({
    id,
    record: { answer_text: answerText },
    save,
    answer: answerText.trim(),
  });

  const rows: Row[] = [
    // ── 거부 ──
    text("X1 질문 그대로", Q, false),
    text("X2 질문 앞뒤 공백·따옴표·물음표 변형", `  "${Q}?"  `, false),
    text("X3 별표만", "★ ★ ★ ★ ★", false),
    text("X4 태그로 감싼 질문", `<p><strong>${Q}</strong></p>`, false),
    text("X5 단어 사이 &nbsp;", Q.replace(/ /g, "&nbsp;"), false),
    text("X6 질문 + Sources URL", `${Q}\nSources: https://example.com/a`, false),
    text("X7 Sources URL 단독", "Sources: https://example.com/a", false),
    text("X8 질문 + References URL 목록", `${Q}\nReferences:\n- https://a.example/x\n- https://b.example/y`, false),
    text(
      "X9 괄호 든 URL 두 개만",
      "https://en.wikipedia.org/wiki/Set_(mathematics) https://en.wikipedia.org/wiki/Group_(mathematics)",
      false,
    ),
    text("X10 질문 + References 번호 목록 10줄 (R3-1)", `${Q}\nReferences:\n${urls(10, (i) => `${i}. `)}`, false),
    text("X11 질문 + Sources 번호·인용 번호표 6줄 (R3-1)", `${Q}\nSources:\n${urls(6, (i) => `${i}. [${i}] `)}`, false),
    text(
      "X12 질문 + 링크 텍스트가 도메인인 출처 목록 (R3-2)",
      `${Q}\nSources:\n- [news.example.com](https://news.example.com/a)\n- [blog.example.org](https://blog.example.org/b)`,
      false,
    ),
    text("X13 질문 + 번호 붙은 이름표", `${Q}\nSource 1: https://a.example/1\nSource 2: https://a.example/2`, false),
    {
      id: "X14 후보 값 안 제목은 답이 아니다 (R3-3)",
      record: {
        answer_text: Q,
        content: [{ title: "지어낸 스튜디오 추천 순위 제목 모음 2026년판", url: "https://rank.example/a" }],
      },
      save: false,
    },
    {
      id: "X15 후보 값 안 메타 문자열은 답이 아니다 (R3-3)",
      record: { answer_text: Q, response_raw: { model: "some-model latest release build 20xx" } },
      save: false,
    },
    text("X16 짧은 오류 페이지", "<!DOCTYPE html><html><body>Access denied</body></html>", false),
    // ── 저장 ──
    text("O1 100자 안팎 한국어 한 문장", O1, true),
    text("O2 114자 안팎 '나이 제한은 거의 없습니다. …'", O2, true),
    text("O3 영문 정상 답", O3, true),
    text("O4 질문 인용 뒤 긴 본문", `"${Q}"라는 질문에 답하면, ${LONG_KO}`, true),
    text(
      "O5 질문 + 출처: URL 에 따르면 긴 본문",
      `${Q}\n출처: https://x.example/r 에 따르면 초보자는 수업 인원이 적고 동작 설명이 자세한 곳에서 시작하는 것이 좋습니다.`,
      true,
    ),
    text(
      "O6 출처: URL 에 따르면 … 단독",
      "출처: https://x.example/r 에 따르면 초보자는 소규모 수업에서 자세한 설명을 받는 것이 좋습니다.",
      true,
    ),
    text(
      "O7 참고: 아래 설명 달린 마크다운 링크 두 개",
      "참고:\n- [초보자 준비물과 첫 수업 안내](https://guide.example/a) — 운동복과 수건, 물을 챙기면 됩니다\n- [강사 설명 방식과 인원 비교](https://guide.example/b) — 한 반 인원이 적을수록 자세를 자주 봐 줍니다",
      true,
    ),
    text(
      "O8 Sources: URL According to …",
      "Sources: https://x.example/r According to this report, beginners should start with small classes and clear cues.",
      true,
    ),
    text(
      "O9 질문 인용 후 참고로 본문",
      `"${Q}"라는 질문에 답하면,\n참고로 처음 한 달은 주 2회 수업으로 시작하고, 체험 수업에서 강사의 설명 방식을 먼저 확인해 보세요.`,
      true,
    ),
    text(
      "O10 괄호 든 URL 을 마크다운 링크로 인용",
      `[집합 개념](https://en.wikipedia.org/wiki/Set_(mathematics))을 먼저 보면 이해가 쉽습니다. ${LONG_KO}`,
      true,
    ),
    {
      id: "O11 content 배열 안 text 의 정상 답",
      record: { answer_text: Q, content: [{ type: "text", text: NORMAL }] },
      save: true,
      answer: NORMAL,
    },
    { id: "O12 content 문자열의 정상 답", record: { answer_text: Q, content: NORMAL }, save: true, answer: NORMAL },
    text(
      "O13 추천 기관을 설명 있는 링크 목록으로 답함",
      "- [지어낸 아카데미 이름](https://a.example/1) — 해부학 기반 12주 과정으로 초보자 반을 따로 운영합니다.\n- [지어낸 스튜디오 이름](https://b.example/2) — 한 반 여섯 명 이하 소규모 수업과 체험 수업을 제공합니다.",
      true,
    ),
    text("O14 다른 문자(일본어)로 쓴 정상 답", "初心者でも安心して通えるスタジオを選ぶのがおすすめです。少人数クラスが理想的です。", true),
    text("O15 마크다운 표·목록·굵은 글씨가 섞인 5,000자 이상 답", LONG_MD, true),
    { id: "O16 후보 없음 · 부속 필드에만 답(깊은 추출)", record: { extra: { body: NORMAL } }, save: true, answer: NORMAL },
    // ── 수용한 트레이드오프(저장됨으로 의도 고정) ──
    text(
      "T1 질문 + 제목이 긴 출처 링크 목록(설명 없음)",
      `${Q}\nSources:\n- [초보자를 위한 운동 학원 고르는 법 총정리](https://a.example/x)\n- [처음 운동을 시작할 때 알아야 할 열 가지](https://b.example/y)`,
      true,
    ),
    text("T2 태그 없는 영문 오류 문구", "Access denied. You do not have permission to access this resource.", true),
  ];

  it("O15 는 5,000자 이상이다(표 전제)", () => {
    expect(LONG_MD.length).toBeGreaterThanOrEqual(5000);
  });

  it.each(rows)("$id", ({ record, save, answer }) => {
    if (save) {
      const r = normalizeScrapePayload({ provider: "perplexity", prompt: Q, payload: [record] });
      expect(r.answer).toBe(answer);
    } else {
      const f = failureOf(() => normalizeScrapePayload({ provider: "perplexity", prompt: Q, payload: [record] }));
      expect(f.code).toBe("EMPTY_ANSWER");
    }
  });
});

/**
 * 판정 성능 — 적대 입력에서도 입력 길이에 비례해야 한다(3회차 R3-4). 느린 시험 환경을 감안해
 * 한 번 데운 뒤 세 번 중 가장 빠른 값을 본다.
 */
describe("판정 성능 (R3-4)", () => {
  const Q = "초보자가 다니기 좋은 운동 학원을 추천해 주세요";
  const best = (fn: () => void) => {
    fn();
    let min = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      fn();
      min = Math.min(min, performance.now() - t);
    }
    return min;
  };

  it.each([
    ["Sources + 공백 30,000 + x", `Sources${" ".repeat(30_000)}x`],
    ["'<a ' 5,000번 반복(닫는 > 없음)", "<a ".repeat(5_000)],
    ["'<!a' 5,000번 반복", "<!a".repeat(5_000)],
    ["'<!--' 5,000번 반복(닫힘 없음)", "<!--".repeat(5_000)],
    ["'<script>' 3,000번 반복(닫힘 없음)", "<script>".repeat(3_000)],
    ["'[a](x \"' 3,000번 반복", '[a](x "'.repeat(3_000)],
  ])("적대 입력 — %s → 50ms 미만", (_name, input) => {
    expect(best(() => detectNonAnswer(input, Q))).toBeLessThan(50);
  });

  it("50,000자 정상 답 → 10ms 미만", () => {
    const para =
      "초보자라면 [안내 글](https://guide.example/a) 을 참고해 수업 인원이 적은 곳을 고르세요. 자세한 비교는 https://compare.example/b 에 있습니다.\n";
    const input = para.repeat(Math.ceil(50_000 / para.length)).slice(0, 50_000);
    expect(best(() => detectNonAnswer(input, Q))).toBeLessThan(10);
  });
});
