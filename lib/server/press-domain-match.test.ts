/**
 * press-domain-match.test.ts — 언론(배포 매체) 인용 판정 순수함수 단위 테스트.
 *
 * 계획 geotracker-youtube-press-scoring-260923 §6-3 필수 항목:
 *   도메인만(불가) · 용어만(불가) · 둘 다(가능) · 하위 주소(가능) · 미등록 매체(불가) ·
 *   제목 조건과 설명 조건이 따로 집계되는지 · 설정이 비면 코드 기본값.
 *
 * ⚠️ 이 저장소는 PUBLIC 이다 — 실제 매체 도메인·클라이언트 지표를 쓰지 않는다. 도메인은
 * IANA 예약 TLD(.example)의 가짜 값만 사용한다.
 *
 * DB·Next 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  collectPressEvidence,
  evaluatePressCitation,
  matchedPressDomain,
  normalizePressDomains,
  type PressCitationCandidate,
} from "./press-domain-match";

const PRESS_DOMAINS = ["press-wire.example", "media-news.example"];
const BRAND_TERMS = ["매직테스트", "MagicTest"];

describe("normalizePressDomains", () => {
  it("www./m. 접두 제거 + 소문자 + 중복 제거", () => {
    expect(
      normalizePressDomains(["https://www.Press-Wire.example", "m.press-wire.example", "press-wire.example"]),
    ).toEqual(["press-wire.example"]);
  });

  it("빈 배열·undefined·null → 빈 배열(설정이 비면 코드 기본값)", () => {
    expect(normalizePressDomains([])).toEqual([]);
    expect(normalizePressDomains(undefined)).toEqual([]);
    expect(normalizePressDomains(null)).toEqual([]);
  });

  it("파싱 불가 항목은 조용히 제외", () => {
    expect(normalizePressDomains(["", "   ", "press-wire.example"])).toEqual(["press-wire.example"]);
  });
});

describe("matchedPressDomain — 도메인 조건", () => {
  it("등록 도메인 그대로 매칭 → 등록값 반환", () => {
    expect(matchedPressDomain("https://press-wire.example/a/1", PRESS_DOMAINS)).toBe(
      "press-wire.example",
    );
  });

  it("하위 주소(경로)는 host 만 보므로 매칭(가능)", () => {
    expect(
      matchedPressDomain("https://press-wire.example/2026/09/23/article-title", PRESS_DOMAINS),
    ).toBe("press-wire.example");
  });

  it("하위 도메인도 매칭(가능)", () => {
    expect(matchedPressDomain("https://sub.press-wire.example/x", PRESS_DOMAINS)).toBe(
      "press-wire.example",
    );
  });

  it("미등록 매체(불가) — 목록에 없는 도메인은 매칭되지 않는다", () => {
    expect(matchedPressDomain("https://unregistered-outlet.example/x", PRESS_DOMAINS)).toBeNull();
  });

  it("도메인 문자열이 비슷해도 접미사가 아니면 매칭 안 함(과대매칭 차단)", () => {
    // "evil-press-wire.example" 은 "press-wire.example" 로 끝나지 않는다(하위 도메인이 아님).
    expect(matchedPressDomain("https://evil-press-wire.example/x", PRESS_DOMAINS)).toBeNull();
    // "press-wire.example.evil.com" 도 host 전체가 다르므로 매칭 안 함.
    expect(matchedPressDomain("https://press-wire.example.evil.com/x", PRESS_DOMAINS)).toBeNull();
  });

  it("설정이 비면 코드 기본값 — 등록 목록이 비면 항상 null", () => {
    expect(matchedPressDomain("https://press-wire.example/a", [])).toBeNull();
  });

  it("URL 이 없으면 null", () => {
    expect(matchedPressDomain(null, PRESS_DOMAINS)).toBeNull();
    expect(matchedPressDomain(undefined, PRESS_DOMAINS)).toBeNull();
    expect(matchedPressDomain("", PRESS_DOMAINS)).toBeNull();
  });
});

function citation(p: Partial<PressCitationCandidate>): PressCitationCandidate {
  return { url: null, domain: null, title: null, description: null, ...p };
}

describe("evaluatePressCitation — 매체 도메인 + 브랜드 용어 두 조건(D2)", () => {
  it("도메인만(불가) — 등록 매체지만 제목·설명에 브랜드 용어가 없으면 둘 다 false", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://press-wire.example/a", title: "무관한 기사", description: "브랜드 없음" }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.domain).toBe("press-wire.example");
    expect(r.titleMatch).toBe(false);
    expect(r.descriptionMatch).toBe(false);
  });

  it("용어만(불가) — 브랜드 용어가 있어도 등록 매체가 아니면 도메인부터 null", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://unregistered-outlet.example/a", title: "매직테스트 관련 기사" }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r).toEqual({ domain: null, titleMatch: false, descriptionMatch: false });
  });

  it("둘 다(가능) — 등록 매체 + 제목에 브랜드 용어 → titleMatch true", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://press-wire.example/a", title: "매직테스트, 신규 과정 개설" }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.domain).toBe("press-wire.example");
    expect(r.titleMatch).toBe(true);
  });

  it("하위 주소(가능) — 등록 도메인의 하위 경로 + 브랜드 용어도 매칭", () => {
    const r = evaluatePressCitation(
      citation({
        url: "https://press-wire.example/2026/09/article",
        title: "일반 제목",
        description: "MagicTest 협회 소식",
      }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.domain).toBe("press-wire.example");
    expect(r.descriptionMatch).toBe(true);
  });

  it("미등록 매체(불가) — 전체가 false", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://unregistered-outlet.example/a", title: "매직테스트 후기" }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.titleMatch).toBe(false);
    expect(r.descriptionMatch).toBe(false);
  });

  it("제목 조건과 설명 조건이 따로 집계된다 — 제목만 매칭", () => {
    const r = evaluatePressCitation(
      citation({
        url: "https://press-wire.example/a",
        title: "매직테스트 소식",
        description: "브랜드 언급 없는 본문",
      }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.titleMatch).toBe(true);
    expect(r.descriptionMatch).toBe(false);
  });

  it("제목 조건과 설명 조건이 따로 집계된다 — 설명만 매칭", () => {
    const r = evaluatePressCitation(
      citation({
        url: "https://press-wire.example/a",
        title: "일반 제목, 브랜드 무관",
        description: "본문에 매직테스트 언급",
      }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.titleMatch).toBe(false);
    expect(r.descriptionMatch).toBe(true);
  });

  it("제목 조건과 설명 조건이 따로 집계된다 — 둘 다 매칭", () => {
    const r = evaluatePressCitation(
      citation({
        url: "https://press-wire.example/a",
        title: "매직테스트 소식",
        description: "MagicTest 관련 본문",
      }),
      PRESS_DOMAINS,
      BRAND_TERMS,
    );
    expect(r.titleMatch).toBe(true);
    expect(r.descriptionMatch).toBe(true);
  });

  it("설정이 비면 코드 기본값 — pressDomains 빈 배열이면 항상 미매칭", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://press-wire.example/a", title: "매직테스트 기사" }),
      [],
      BRAND_TERMS,
    );
    expect(r).toEqual({ domain: null, titleMatch: false, descriptionMatch: false });
  });

  it("설정이 비면 코드 기본값 — brandTerms 빈 배열이면 도메인은 매칭돼도 제목·설명은 false", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://press-wire.example/a", title: "아무 제목" }),
      PRESS_DOMAINS,
      [],
    );
    expect(r.domain).toBe("press-wire.example");
    expect(r.titleMatch).toBe(false);
    expect(r.descriptionMatch).toBe(false);
  });
});

describe("collectPressEvidence — 자동화 수집 경로 진입점", () => {
  it("제목 매칭 인용이 있으면 hasTitleMatch true + evidence 에 :title 로 기록", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" }),
    ];
    const r = collectPressEvidence(citations, PRESS_DOMAINS, BRAND_TERMS);
    expect(r.hasTitleMatch).toBe(true);
    expect(r.evidence).toEqual(["press-wire.example:title"]);
  });

  it("설명만 매칭되면 hasTitleMatch 는 false 이지만 evidence 에는 :description 으로 남는다", () => {
    const citations: PressCitationCandidate[] = [
      citation({
        url: "https://press-wire.example/a",
        title: "무관 제목",
        description: "매직테스트 언급",
      }),
    ];
    const r = collectPressEvidence(citations, PRESS_DOMAINS, BRAND_TERMS);
    expect(r.hasTitleMatch).toBe(false);
    expect(r.evidence).toEqual(["press-wire.example:description"]);
  });

  it("여러 인용 — 도메인별로 dedup 되고 하나라도 제목 매칭이면 hasTitleMatch true", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://press-wire.example/a", title: "무관", description: "매직테스트" }),
      citation({ url: "https://press-wire.example/b", title: "매직테스트 소식" }),
      citation({ url: "https://media-news.example/c", title: "MagicTest 보도" }),
      citation({ url: "https://unregistered-outlet.example/d", title: "매직테스트" }), // 미등록 — 무시
    ];
    const r = collectPressEvidence(citations, PRESS_DOMAINS, BRAND_TERMS);
    expect(r.hasTitleMatch).toBe(true);
    expect(new Set(r.evidence)).toEqual(
      new Set(["press-wire.example:description", "press-wire.example:title", "media-news.example:title"]),
    );
  });

  it("설정이 비면 코드 기본값 — citations·pressDomains·brandTerms 어느 하나라도 비면 빈 증거", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://press-wire.example/a", title: "매직테스트" }),
    ];
    expect(collectPressEvidence(undefined, PRESS_DOMAINS, BRAND_TERMS)).toEqual({
      evidence: [],
      hasTitleMatch: false,
    });
    expect(collectPressEvidence([], PRESS_DOMAINS, BRAND_TERMS)).toEqual({
      evidence: [],
      hasTitleMatch: false,
    });
    expect(collectPressEvidence(citations, [], BRAND_TERMS)).toEqual({
      evidence: [],
      hasTitleMatch: false,
    });
    expect(collectPressEvidence(citations, PRESS_DOMAINS, [])).toEqual({
      evidence: [],
      hasTitleMatch: false,
    });
  });

  it("도메인 필드만 있고 url 이 없어도(citations 필드 호환) 매칭한다", () => {
    const citations: PressCitationCandidate[] = [
      citation({ domain: "press-wire.example", title: "매직테스트 소식" }),
    ];
    const r = collectPressEvidence(citations, PRESS_DOMAINS, BRAND_TERMS);
    expect(r.hasTitleMatch).toBe(true);
  });
});
