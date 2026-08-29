/**
 * 2026-08-29 Perplexity 수집 장애 회귀 방지 테스트.
 *
 * 배경: Bright Data 가 답변 없이 `{timestamp, input, error, error_code}` 만 담긴 레코드를
 * 돌려줬는데, deep fallback 이 24자 timestamp 를 답변으로 채택해 "실패가 정상처럼" 저장됐다.
 * 실측 오염 616건(perplexity 545 · google_ai 59 · chatgpt 8 · gemini 4).
 */
import { describe, it, expect } from "vitest";
import { isAnswerLikeString, normalizeAnswer, buildInputRecord, PARSE_FAILURE_MARKER } from "./brightdata-scraper";

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
    const answer = normalizeAnswer(record);
    expect(answer.startsWith(PARSE_FAILURE_MARKER)).toBe(true);
    expect(answer).not.toContain("2026-08-29T13:35:11.441Z");
  });

  it("url·prompt 만 있는 레코드도 파싱 실패로 처리한다", () => {
    const answer = normalizeAnswer({
      url: "https://www.perplexity.ai/search/11f47028-da04-4e8a-8503-2399ddf5aa46",
      prompt: "필라테스 강사 자격증을 어디에서 따야할까?",
      timestamp: "2026-08-29T12:42:24.424Z",
    });
    expect(answer.startsWith(PARSE_FAILURE_MARKER)).toBe(true);
  });

  it("answer_text 가 있으면 그대로 쓴다", () => {
    const text = "필라테스 강사 자격증은 커리큘럼과 실습 시간을 함께 확인하는 것이 좋습니다.";
    expect(normalizeAnswer({ answer_text: text, timestamp: "2026-08-29T12:42:24.424Z" })).toBe(text);
  });

  it("답변이 response_raw 에만 있어도 찾아낸다 (필드 목록 공유 회귀 방지)", () => {
    const text = "그록 형식 응답이지만 실제로 사용 가능한 정상 한국어 답변입니다.";
    expect(normalizeAnswer({ response_raw: text, timestamp: "2026-08-29T12:42:24.424Z" })).toBe(text);
  });
});

describe("buildInputRecord — 지역값(country) 전송 규칙", () => {
  it("Perplexity 는 country 를 그대로 보낸다 (한국 결과 확보 우선)", () => {
    const rec = buildInputRecord("perplexity", "필라테스 강사 자격증", "KR");
    expect(rec.country).toBe("KR");
  });

  it("Perplexity 는 country 가 비면 키 자체를 넣지 않는다 (fallback 재시도용)", () => {
    const rec = buildInputRecord("perplexity", "필라테스 강사 자격증", undefined);
    expect("country" in rec).toBe(false);
  });

  it("Google AI 의 country 전송은 이번 수정으로 바뀌지 않았다", () => {
    expect(buildInputRecord("google_ai", "질문", "KR").country).toBe("KR");
  });

  it("ChatGPT 는 country 를 지원하지 않으므로 보내지 않는다", () => {
    expect("country" in buildInputRecord("chatgpt", "질문", "KR")).toBe(false);
  });
});
