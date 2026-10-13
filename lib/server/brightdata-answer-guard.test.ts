/**
 * 2026-08-29 Perplexity 수집 장애 회귀 방지 테스트.
 *
 * 배경: Bright Data 가 답변 없이 `{timestamp, input, error, error_code}` 만 담긴 레코드를
 * 돌려줬는데, deep fallback 이 24자 timestamp 를 답변으로 채택해 "실패가 정상처럼" 저장됐다.
 * 실측 오염 616건(perplexity 545 · google_ai 59 · chatgpt 8 · gemini 4).
 */
import { describe, it, expect } from "vitest";
import {
  isAnswerLikeString,
  normalizeAnswer,
  buildInputRecord,
  countryOrDefault,
  requestCountryFor,
  PARSE_FAILURE_MARKER,
} from "./brightdata-scraper";

describe("isAnswerLikeString — 메타 문자열을 답변으로 오인하지 않는다", () => {
  it("ISO 타임스탬프 전체는 답변이 아니다 (실제 오염 값)", () => {
    expect(isAnswerLikeString("2026-08-29T12:29:10.833Z")).toBe(false);
    expect(isAnswerLikeString("2026-08-29 12:29:10")).toBe(false);
    expect(isAnswerLikeString("2026-08-29T12:29:10.833+09:00")).toBe(false);
  });

  it("타임스탬프로 '시작'하는 정상 답변은 답변으로 인정한다 (끝 앵커 회귀 방지)", () => {
    expect(
      isAnswerLikeString("2026-08-29T09:00 현재 매직바디의 방문자 수는 전월 대비 늘었습니다."),
    ).toBe(true);
  });

  it("단독 URL·단일 토큰은 답변이 아니다", () => {
    expect(isAnswerLikeString("https://www.perplexity.ai/search/11f47028-da04-4e8a-8503")).toBe(false);
    expect(isAnswerLikeString("sd_mtef2a4365micoxfi_snapshot_identifier")).toBe(false);
  });

  it("20자 이하 짧은 문자열은 답변으로 보지 않는다", () => {
    expect(isAnswerLikeString("짧은 답")).toBe(false);
  });

  it("실제 한국어 답변은 답변으로 인정한다", () => {
    expect(
      isAnswerLikeString(
        "필라테스 강사 자격증은 민간자격이나 국제 인증기관에서 취득하는 것이 일반적입니다.",
      ),
    ).toBe(true);
  });
});

describe("normalizeAnswer — 답변 없는 레코드에서 메타 필드를 집지 않는다", () => {
  it("크롤러 실패 레코드는 파싱 실패로 처리한다 (timestamp 채택 금지)", () => {
    const record = {
      timestamp: "2026-08-29T13:35:11.441Z",
      input: { url: "https://www.perplexity.ai", prompt: "필라테스 강사 자격증" },
      error: "Crawler error: waiting for selector failed: timeout 30000ms exceeded",
      error_code: "crawler_error",
    };
    const answer = normalizeAnswer(record, "perplexity");
    expect(answer.startsWith(PARSE_FAILURE_MARKER)).toBe(true);
    expect(answer).not.toContain("2026-08-29T13:35:11.441Z");
  });

  it("url·prompt 만 있는 레코드도 파싱 실패로 처리한다", () => {
    const answer = normalizeAnswer(
      {
        url: "https://www.perplexity.ai/search/11f47028-da04-4e8a-8503-2399ddf5aa46",
        prompt: "필라테스 강사 자격증을 어디에서 따야할까?",
        timestamp: "2026-08-29T12:42:24.424Z",
      },
      "perplexity",
    );
    expect(answer.startsWith(PARSE_FAILURE_MARKER)).toBe(true);
  });

  it("answer_text 가 있으면 그대로 쓴다", () => {
    const text = "필라테스 강사 자격증은 커리큘럼과 실습 시간을 함께 확인하는 것이 좋습니다.";
    expect(normalizeAnswer({ answer_text: text, timestamp: "2026-08-29T12:42:24.424Z" }, "perplexity")).toBe(text);
  });

  it("Grok 은 답변이 response_raw 에만 있어도 찾아낸다 (필드 목록 공유 회귀 방지)", () => {
    const text = "그록 형식 응답이지만 실제로 사용 가능한 정상 한국어 답변입니다.";
    expect(normalizeAnswer({ response_raw: text, timestamp: "2026-08-29T12:42:24.424Z" }, "grok")).toBe(text);
  });

  it("Grok 이 아니면 response_raw 는 답 후보가 아니다 — 1차 후보·깊은 추출 모두 (2026-09-25)", () => {
    const text = "그록 형식 응답이지만 실제로 사용 가능한 정상 한국어 답변입니다.";
    for (const provider of ["perplexity", "chatgpt", "gemini", "google_ai", "copilot"] as const) {
      const top = normalizeAnswer({ response_raw: text, timestamp: "2026-08-29T12:42:24.424Z" }, provider);
      expect(top.startsWith(PARSE_FAILURE_MARKER)).toBe(true);
      const nested = normalizeAnswer({ extra: { response_raw: text } }, provider);
      expect(nested.startsWith(PARSE_FAILURE_MARKER)).toBe(true);
    }
  });
});

describe("buildInputRecord — 지역값(country) 전송 규칙", () => {
  it("Perplexity 는 country 를 넘겨도 싣지 않는다 (2026-09-25 § PERPLEXITY_NO_COUNTRY)", () => {
    const rec = buildInputRecord("perplexity", "필라테스 강사 자격증", "KR");
    expect("country" in rec).toBe(false);
    expect("geolocation" in rec).toBe(false);
    expect(rec).toEqual({ url: "https://www.perplexity.ai", prompt: "필라테스 강사 자격증", index: 1 });
  });

  it("Perplexity 는 country 가 비어도 키 자체를 넣지 않는다", () => {
    const rec = buildInputRecord("perplexity", "필라테스 강사 자격증", undefined);
    expect("country" in rec).toBe(false);
  });

  it("Google AI 의 country 전송은 이번 수정으로 바뀌지 않았다", () => {
    expect(buildInputRecord("google_ai", "질문", "KR").country).toBe("KR");
  });

  it("ChatGPT 는 country 를 싣고 웹 검색을 켠다 (2026-10-14 § CHATGPT_GEMINI_COUNTRY)", () => {
    expect(buildInputRecord("chatgpt", "질문", "KR")).toEqual({
      url: "https://chatgpt.com/",
      prompt: "질문",
      web_search: true,
      additional_prompt: "",
      country: "KR",
    });
  });

  it("ChatGPT 는 country 가 비면 키를 넣지 않는다(웹 검색은 켠다)", () => {
    for (const c of [undefined, ""]) {
      const rec = buildInputRecord("chatgpt", "질문", c);
      expect("country" in rec).toBe(false);
      expect(rec.web_search).toBe(true);
    }
  });

  it("Gemini 는 country 를 싣는다 · 비면 키를 넣지 않는다", () => {
    expect(buildInputRecord("gemini", "질문", "KR")).toEqual({
      url: "https://gemini.google.com/",
      prompt: "질문",
      index: 1,
      country: "KR",
    });
    expect(buildInputRecord("gemini", "질문", undefined)).toEqual({
      url: "https://gemini.google.com/",
      prompt: "질문",
      index: 1,
    });
  });

  it("Google AI·Copilot·Grok 은 바뀌지 않았다", () => {
    expect(buildInputRecord("google_ai", "질문", "KR")).toEqual({ url: "https://google.com/aimode", prompt: "질문", country: "KR" });
    expect(buildInputRecord("google_ai", "질문", undefined)).toEqual({ url: "https://google.com/aimode", prompt: "질문" });
    expect(buildInputRecord("copilot", "질문", "KR")).toEqual({
      url: "https://copilot.microsoft.com/",
      prompt: "질문",
      index: 1,
      geolocation: "KR",
    });
    expect(buildInputRecord("grok", "질문", undefined)).toEqual({ url: "https://grok.com/", prompt: "질문", index: 1 });
  });
});

describe("requestCountryFor — 요청에 실을 국가 (§ PERPLEXITY_NO_COUNTRY)", () => {
  it("Perplexity 는 어떤 값이 와도 국가 없음", () => {
    expect(requestCountryFor("perplexity", "KR")).toBeUndefined();
    expect(requestCountryFor("perplexity", "US")).toBeUndefined();
    expect(requestCountryFor("perplexity", null)).toBeUndefined();
  });

  it("국가 값 정리 — 공백 제거·대문자, 두 글자 영문이 아니면 없음 (검수 1회차 결함 3)", () => {
    expect(requestCountryFor("chatgpt", "kr")).toBe("KR");
    expect(requestCountryFor("gemini", " kr ")).toBe("KR");
    expect(requestCountryFor("google_ai", "")).toBeUndefined();
    expect(requestCountryFor("google_ai", "   ")).toBeUndefined();
    expect(requestCountryFor("chatgpt", "Korea")).toBeUndefined();
    expect(requestCountryFor("perplexity", " kr ")).toBeUndefined();
  });

  it("countryOrDefault — 값이 없거나 형식이 틀리면 KR, 있으면 정리된 값", () => {
    for (const v of [undefined, null, "", "  ", "Korea"]) expect(countryOrDefault(v)).toBe("KR");
    expect(countryOrDefault(" kr ")).toBe("KR");
    expect(countryOrDefault("us")).toBe("US");
  });

  it("buildInputRecord 도 소문자·공백을 정리해 싣고, 빈 값은 싣지 않는다", () => {
    expect(buildInputRecord("chatgpt", "질문", " kr ").country).toBe("KR");
    expect(buildInputRecord("gemini", "질문", "kr").country).toBe("KR");
    expect("country" in buildInputRecord("gemini", "질문", "  ")).toBe(false);
    expect(buildInputRecord("google_ai", "질문", "kr").country).toBe("KR");
    expect(buildInputRecord("copilot", "질문", "kr").geolocation).toBe("KR");
  });

  it("다른 AI 는 받은 값 그대로 (Google AI 는 KR 을 계속 보낸다)", () => {
    expect(requestCountryFor("google_ai", "KR")).toBe("KR");
    expect(requestCountryFor("chatgpt", "KR")).toBe("KR");
    expect(requestCountryFor("gemini", "KR")).toBe("KR");
    expect(requestCountryFor("copilot", "KR")).toBe("KR");
    expect(requestCountryFor("google_ai", null)).toBeUndefined();
  });
});
