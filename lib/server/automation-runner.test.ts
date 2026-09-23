/**
 * automation-runner.test.ts — 순수함수로 뽑아 둔 경로의 단위 테스트.
 *
 * automation-runner.ts 의 대부분은 DB·Bright Data 스크레이퍼·LLM 호출에 의존해 이 파일에서
 * 직접 단위 테스트할 수 없다(그 계약은 route.test.ts 류의 통합 테스트 영역). 여기서는
 * 순수 함수로 뽑아 둔 두 가지만 다룬다.
 *
 *   1. resolveScoringProfile(계획 v2 §4-5 D8′) — 워크스페이스가 지금 쓰는 세트·버전·
 *      유튜브 판정 적용 여부를 전부 결정한다. 잘못되면 전체 수집 경로의 점수 계약이 깨진다.
 *   2. resolveCitationJudgment(계획 geotracker-youtube-press-scoring-260923 §4-1·§4-2·
 *      §4-5, 독립 검수 지적 반영) — runOneProviderForPrompt 안에서 소유 유튜브 인용 병합 +
 *      언론 인용 증거를 계산해 runs INSERT 컬럼 4개(hasCitationOnly 는 컬럼이 아니라
 *      calcVisibilityFull 입력)를 만드는 블록. 실제 수집 배선에서 유일한 테스트 사각지대였다.
 *
 * 순수 · DB 무의존.
 */

import { describe, it, expect } from "vitest";
import type { Citation } from "@/components/dashboard/types";
import {
  DEFAULT_SCORING_SWITCH,
  SCORING_PROFILES,
  resolveScoringProfile,
  resolveCitationJudgment,
  type ScoringSetSwitch,
  type CitationJudgmentInput,
} from "./automation-runner";

describe("resolveScoringProfile — 계획 §4-5 (세트·버전) 쌍 선택자", () => {
  it("미지정(undefined) → 기본값 v14a(꺼짐)", () => {
    const p = resolveScoringProfile(undefined);
    expect(p).toEqual({ setId: "v14a", version: 14, applyOwnedCitationJudgment: false });
  });

  it("\"v15a\" → 켜짐", () => {
    const p = resolveScoringProfile("v15a");
    expect(p).toEqual({ setId: "v15a", version: 15, applyOwnedCitationJudgment: true });
  });

  it("\"v14a\" 명시 → 꺼짐과 동일", () => {
    expect(resolveScoringProfile("v14a")).toEqual(resolveScoringProfile(undefined));
  });

  it("알 수 없는 값(오타·과거 값)은 항상 기본값(꺼짐)으로 떨어진다 — fail-safe", () => {
    // BrandConfig 타입상 scoringSetSwitch 는 "v14a"|"v15a"|undefined 로 닫혀 있지만,
    // 런타임에는 DB 에 저장된 임의 문자열이 들어올 수 있다(과거 값·수동 편집 등).
    const unknown = "v16a" as unknown as ScoringSetSwitch;
    expect(resolveScoringProfile(unknown)).toEqual(resolveScoringProfile(undefined));
  });

  it("세트 id 와 버전은 항상 쌍으로만 움직인다 — v14a/14, v15a/15 외 조합이 없다", () => {
    for (const key of Object.keys(SCORING_PROFILES) as ScoringSetSwitch[]) {
      const p = SCORING_PROFILES[key];
      if (p.setId === "v14a") expect(p.version).toBe(14);
      if (p.setId === "v15a") expect(p.version).toBe(15);
    }
  });

  it("꺼짐 프로파일만 applyOwnedCitationJudgment=false — v14a 의 인용 배점이 0 이 아니므로", () => {
    expect(SCORING_PROFILES.v14a.applyOwnedCitationJudgment).toBe(false);
    expect(SCORING_PROFILES.v15a.applyOwnedCitationJudgment).toBe(true);
  });

  it("DEFAULT_SCORING_SWITCH 는 v14a — 기본이 항상 옛 동작", () => {
    expect(DEFAULT_SCORING_SWITCH).toBe("v14a");
  });
});

/**
 * resolveCitationJudgment — 소유 유튜브 인용 병합 + 언론 인용 증거 계산(독립 검수 지적 반영).
 *
 * ⚠️ 이 저장소는 PUBLIC 이다 — 실제 브랜드 용어·매체 도메인·클라이언트 지표를 쓰지 않는다.
 * press-domain-match.test.ts 와 동일한 관례로 브랜드 용어는 가짜 값, 매체 도메인은 IANA
 * 예약 TLD(.example)만 사용한다. 유튜브 video-ID 도 공개적으로 널리 쓰이는 자리표시자
 * (dQw4w9WgXcQ 등, citation-url-aggregate-owned.test.ts 와 동일)만 사용한다.
 */
function citation(p: Partial<Citation>): Citation {
  return { url: "", domain: "", title: "", description: "", ...p };
}

const JUDGMENT_BRAND_TERMS = ["매직테스트", "MagicTest"];
const JUDGMENT_PRESS_DOMAINS = ["press-wire.example"];
const OWNED_VIDEO_ID = "dQw4w9WgXcQ";
const OTHER_VIDEO_ID = "aBcD_eF-123";

/** 기본값 = 스위치 꺼짐 + 인용 없음(실제 배선의 가장 흔한 케이스). 필요한 필드만 override. */
function baseJudgmentInput(overrides: Partial<CitationJudgmentInput> = {}): CitationJudgmentInput {
  return {
    citations: [],
    scoringProfile: SCORING_PROFILES.v14a,
    ownedVideoIds: new Set<string>(),
    pressDomains: [],
    brandTerms: JUDGMENT_BRAND_TERMS,
    hasBodyUrl: false,
    citedBrandDomains: [],
    ...overrides,
  };
}

describe("resolveCitationJudgment — 소유 유튜브 인용(스위치 켜짐 v15a)", () => {
  it("소유 목록에 있는 유튜브 인용 → citedOwnedVideoIds 에 video-ID 포함", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` })],
        scoringProfile: SCORING_PROFILES.v15a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
      }),
    );
    expect(r.citedOwnedVideoIds).toEqual([OWNED_VIDEO_ID]);
  });

  it("소유 목록에 없는 유튜브 인용 → citedOwnedVideoIds 빈 배열", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: `https://www.youtube.com/watch?v=${OTHER_VIDEO_ID}` })],
        scoringProfile: SCORING_PROFILES.v15a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
      }),
    );
    expect(r.citedOwnedVideoIds).toEqual([]);
  });

  it("같은 영상의 다른 URL 형태(watch·youtu.be) 는 같은 video-ID 로 병합(dedup)", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [
          citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` }),
          citation({ url: `https://youtu.be/${OWNED_VIDEO_ID}` }),
        ],
        scoringProfile: SCORING_PROFILES.v15a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
      }),
    );
    expect(r.citedOwnedVideoIds).toEqual([OWNED_VIDEO_ID]);
  });

  it("ownedVideoIds 가 빈 Set 이면 스위치가 켜져 있어도 항상 빈 배열(조회 안전 — 소유 영상 미등록/미갱신 시 기존 동작 불변)", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` })],
        scoringProfile: SCORING_PROFILES.v15a,
        ownedVideoIds: new Set(),
      }),
    );
    expect(r.citedOwnedVideoIds).toEqual([]);
  });
});

describe("resolveCitationJudgment — 소유 유튜브 인용(스위치 꺼짐 v14a, 기본값) — 기존 동작과 동일", () => {
  it("소유 목록에 있는 유튜브 인용이어도 스위치가 꺼져 있으면 citedOwnedVideoIds 는 항상 빈 배열", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` })],
        scoringProfile: SCORING_PROFILES.v14a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
      }),
    );
    expect(r.citedOwnedVideoIds).toEqual([]);
  });

  it("스위치 꺼짐 + 소유 영상 인용만 있고 브랜드 도메인 인용·본문 URL 없음 → hasCitationOnly 는 false (소유 인용이 반영되지 않는다)", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` })],
        scoringProfile: SCORING_PROFILES.v14a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
        hasBodyUrl: false,
        citedBrandDomains: [],
      }),
    );
    expect(r.hasCitationOnly).toBe(false);
  });

  it("같은 입력이라도 스위치만 다르면 hasCitationOnly 결과가 갈린다(온/오프 대조 — v14a 의 인용 배점이 0 이 아니므로 §4-5)", () => {
    const input = {
      citations: [citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` })],
      ownedVideoIds: new Set([OWNED_VIDEO_ID]),
      hasBodyUrl: false,
      citedBrandDomains: [],
    };
    const off = resolveCitationJudgment(baseJudgmentInput({ ...input, scoringProfile: SCORING_PROFILES.v14a }));
    const on = resolveCitationJudgment(baseJudgmentInput({ ...input, scoringProfile: SCORING_PROFILES.v15a }));
    expect(off.hasCitationOnly).toBe(false);
    expect(on.hasCitationOnly).toBe(true);
  });
});

describe("resolveCitationJudgment — hasCitationOnly (참고자료에만 등장 판정)", () => {
  it("본문에 URL 있으면(hasBodyUrl=true) 브랜드·소유 인용이 있어도 항상 false", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` })],
        scoringProfile: SCORING_PROFILES.v15a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
        hasBodyUrl: true,
        citedBrandDomains: ["brand-site.example"],
      }),
    );
    expect(r.hasCitationOnly).toBe(false);
  });

  it("본문에 URL 없고 브랜드 도메인 인용만 있어도 true", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        hasBodyUrl: false,
        citedBrandDomains: ["brand-site.example"],
      }),
    );
    expect(r.hasCitationOnly).toBe(true);
  });

  it("본문 URL·브랜드 도메인 인용·소유 영상 인용 전부 없으면 false", () => {
    const r = resolveCitationJudgment(baseJudgmentInput());
    expect(r.hasCitationOnly).toBe(false);
  });
});

describe("resolveCitationJudgment — 언론 인용 증거 (스위치와 무관하게 항상 계산, §4-1 점 4)", () => {
  it("제목에 브랜드 용어가 있는 등록 매체 인용 → hasPressCitation=true, citedPressDomains 에 :title 로 기록", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" })],
        pressDomains: JUDGMENT_PRESS_DOMAINS,
      }),
    );
    expect(r.hasPressCitation).toBe(true);
    expect(r.citedPressDomains).toEqual(["press-wire.example:title"]);
  });

  it("설명만 매칭되면 hasPressCitation 은 false 이지만 citedPressDomains 에는 :description 으로 남는다", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [
          citation({
            url: "https://press-wire.example/a",
            title: "무관한 제목",
            description: "매직테스트 언급",
          }),
        ],
        pressDomains: JUDGMENT_PRESS_DOMAINS,
      }),
    );
    expect(r.hasPressCitation).toBe(false);
    expect(r.citedPressDomains).toEqual(["press-wire.example:description"]);
  });

  it("pressDomains 가 비어 있으면(코드 기본값) 항상 미매칭", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" })],
        pressDomains: [],
      }),
    );
    expect(r.hasPressCitation).toBe(false);
    expect(r.citedPressDomains).toEqual([]);
  });

  it("스위치가 꺼져 있어도(v14a) 언론 증거는 그대로 계산된다 — 배점은 0 이라 점수에 영향 없지만 증거는 쌓인다", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" })],
        scoringProfile: SCORING_PROFILES.v14a,
        pressDomains: JUDGMENT_PRESS_DOMAINS,
      }),
    );
    expect(r.hasPressCitation).toBe(true);
    expect(r.citedPressDomains).toEqual(["press-wire.example:title"]);
  });
});

describe("resolveCitationJudgment — 종합 배선 시나리오 (실제 runOneProviderForPrompt 혼합 입력)", () => {
  it("브랜드 도메인 인용 + 소유 유튜브 인용 + 언론 인용이 섞여 있어도 네 필드가 각각 독립적으로 계산된다(v15a)", () => {
    const r = resolveCitationJudgment(
      baseJudgmentInput({
        citations: [
          citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}` }),
          citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" }),
        ],
        scoringProfile: SCORING_PROFILES.v15a,
        ownedVideoIds: new Set([OWNED_VIDEO_ID]),
        pressDomains: JUDGMENT_PRESS_DOMAINS,
        hasBodyUrl: false,
        citedBrandDomains: ["brand-site.example"],
      }),
    );
    expect(r.citedOwnedVideoIds).toEqual([OWNED_VIDEO_ID]);
    expect(r.hasCitationOnly).toBe(true); // 브랜드 도메인 인용만으로도 이미 true
    expect(r.hasPressCitation).toBe(true);
    expect(r.citedPressDomains).toEqual(["press-wire.example:title"]);
  });

  it("INSERT 컬럼 4개 형태 계약 — 반환 객체가 정확히 이 네 키만 갖는다", () => {
    const r = resolveCitationJudgment(baseJudgmentInput());
    expect(Object.keys(r).sort()).toEqual(
      ["citedOwnedVideoIds", "citedPressDomains", "hasCitationOnly", "hasPressCitation"].sort(),
    );
  });
});
