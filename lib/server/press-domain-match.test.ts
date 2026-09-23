/**
 * press-domain-match.test.ts — 제3자 인용(언론·블로그/소셜) 판정 순수함수 단위 테스트.
 *
 * 2026-09-23 3차 개정(사장님 지시 — 제3자 인용 판정 재설계) — 직전 개정은 소셜 플랫폼
 * (SOCIAL_PLATFORM_DOMAINS)을 판정에서 통째로 제외했다. 이번 판은 그 목록을 제외용이
 * 아니라 **분류용**으로 바꿨다 — 소셜 플랫폼이면 "블로그·소셜 추천", 아니면 "언론 게재"로
 * 나눠 둘 다 남긴다. 이 파일이 덮는 경계:
 *   isOwnedCitationUrl — 우리 소유(웹사이트·유튜브 영상) 판정 단독 검증
 *   classifyThirdPartyCitation — 브랜드 언급 없음(제외) · 제목/설명 매칭 · 우리 소유 제외 ·
 *     소셜/비소셜 분류(핵심 변경점 — 소셜은 이제 제외가 아니라 "social" 분류) · 개별 콘텐츠
 *     URL(경로에 핸들 없음)의 소유 판별 한계(받아들이는 한계 — 문서화)
 *   collectThirdPartyCitationEvidence — 언론/블로그·소셜 증거를 각각 dedup 하고
 *     hasPressMatch·hasSocialMatch 를 독립적으로 계산하는지
 *
 * ⚠️ 이 저장소는 PUBLIC 이다 — 실제 브랜드 용어·클라이언트 지표를 쓰지 않는다. 도메인은
 * IANA 예약 TLD(.example)의 가짜 값만, 유튜브 video-ID 는 공개적으로 널리 쓰이는
 * 자리표시자(dQw4w9WgXcQ 등)만 사용한다.
 *
 * DB·Next 무의존.
 */

import { describe, it, expect } from "vitest";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import {
  classifyThirdPartyCitation,
  collectThirdPartyCitationEvidence,
  isOwnedCitationUrl,
  type ThirdPartyCitationCandidate,
} from "./press-domain-match";

const BRAND_TERMS = ["매직테스트", "MagicTest"];
const OWN_WEBSITES = [
  "https://mysite.example",
  "https://www.youtube.com/@magictest",
  "https://www.instagram.com/magictest",
];
const OWN_WEBSITE_KEYS = buildTargetKeys(OWN_WEBSITES);
const OWNED_VIDEO_ID = "dQw4w9WgXcQ";
const OTHER_VIDEO_ID = "aBcD_eF-123";
const OWNED_VIDEO_IDS = new Set([OWNED_VIDEO_ID]);
const EMPTY_VIDEO_IDS = new Set<string>();

function citation(p: Partial<ThirdPartyCitationCandidate>): ThirdPartyCitationCandidate {
  return { url: null, domain: null, title: null, description: null, ...p };
}

describe("isOwnedCitationUrl — 우리 소유 채널(웹사이트·유튜브 영상) 판정", () => {
  it("등록된 웹사이트 도메인은 소유", () => {
    expect(isOwnedCitationUrl("https://mysite.example/notice", OWN_WEBSITE_KEYS, EMPTY_VIDEO_IDS)).toBe(true);
  });

  it("등록된 웹사이트의 하위 도메인·경로도 소유", () => {
    expect(
      isOwnedCitationUrl("https://blog.mysite.example/2026/09/post", OWN_WEBSITE_KEYS, EMPTY_VIDEO_IDS),
    ).toBe(true);
  });

  it("등록된 소셜 채널 홈(핸들 일치)도 소유", () => {
    expect(
      isOwnedCitationUrl("https://www.youtube.com/@magictest", OWN_WEBSITE_KEYS, EMPTY_VIDEO_IDS),
    ).toBe(true);
  });

  it("소유 유튜브 영상(video-ID 매칭)은 소유", () => {
    expect(
      isOwnedCitationUrl(`https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}`, [], OWNED_VIDEO_IDS),
    ).toBe(true);
  });

  it("남의 웹사이트·남의 영상은 소유가 아니다", () => {
    expect(isOwnedCitationUrl("https://outlet.example/a", OWN_WEBSITE_KEYS, EMPTY_VIDEO_IDS)).toBe(false);
    expect(
      isOwnedCitationUrl(`https://www.youtube.com/watch?v=${OTHER_VIDEO_ID}`, [], OWNED_VIDEO_IDS),
    ).toBe(false);
  });

  it("url 이 없으면 false, 키·영상 집합이 비어 있어도 안전(false)", () => {
    expect(isOwnedCitationUrl(null, OWN_WEBSITE_KEYS, OWNED_VIDEO_IDS)).toBe(false);
    expect(isOwnedCitationUrl("https://mysite.example/a", [], EMPTY_VIDEO_IDS)).toBe(false);
  });
});

describe("classifyThirdPartyCitation — 언론/블로그·소셜 분류(2026-09-23 3차 개정)", () => {
  it("브랜드 용어가 없으면 null — 제목·설명 둘 다 무관", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://outlet.example/a", title: "무관한 기사", description: "브랜드 없음" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBeNull();
  });

  it("제목에만 브랜드 용어 — 비소셜 도메인이면 press", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://outlet.example/a", title: "매직테스트 관련 기사", description: "무관" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("press");
  });

  it("설명에만 브랜드 용어 — 비소셜 도메인이면 press", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://outlet.example/a", title: "무관한 제목", description: "MagicTest 언급" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("press");
  });

  it("등록 매체 개념이 없다 — 어느 비소셜 도메인이든 브랜드 언급만 있으면 press(구 allowlist 폐기)", () => {
    const r1 = classifyThirdPartyCitation(
      citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    const r2 = classifyThirdPartyCitation(
      citation({ url: "https://any-random-blog.example/a", title: "매직테스트 소식" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r1).toBe("press");
    expect(r2).toBe("press");
  });

  it("우리 웹사이트 도메인은 브랜드 언급이 있어도 null(소유 제외)", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://mysite.example/notice", title: "매직테스트 공지" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBeNull();
  });

  it("우리 웹사이트의 하위 도메인·경로도 null", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://blog.mysite.example/2026/09/post", title: "매직테스트 후기" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBeNull();
  });

  it("우리 소셜 채널(유튜브·인스타 핸들 일치)은 null(소유 제외)", () => {
    const yt = classifyThirdPartyCitation(
      citation({ url: "https://www.youtube.com/@magictest", title: "매직테스트 채널" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    const ig = classifyThirdPartyCitation(
      citation({ url: "https://www.instagram.com/magictest", title: "매직테스트 공식 계정" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(yt).toBeNull();
    expect(ig).toBeNull();
  });

  it("⭐ 핵심 변경 — 남의 유튜브 채널 홈(핸들 불일치)은 제외되지 않고 social 로 분류된다", () => {
    // 직전 개정에서는 소셜 플랫폼을 통째로 제외해 null 이었다. 이번 개정의 핵심 —
    // 소유가 아니면 "블로그·소셜 추천"으로 분류해 남긴다.
    const r = classifyThirdPartyCitation(
      citation({ url: "https://www.youtube.com/@someoneelse", title: "매직테스트 언급" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("social");
  });

  it("⭐ 핵심 변경 — 소유가 아닌 유튜브 영상(watch URL)도 social 로 분류된다(직전 개정: 통째 제외)", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: `https://www.youtube.com/watch?v=${OTHER_VIDEO_ID}`, title: "매직테스트 리뷰" }),
      OWN_WEBSITE_KEYS,
      OWNED_VIDEO_IDS, // 다른 영상만 소유
      BRAND_TERMS,
    );
    expect(r).toBe("social");
  });

  it("우리 소유 유튜브 영상(watch URL)은 ownedVideoIds 로 제외된다(null) — 소셜 분류보다 소유 제외가 우선", () => {
    const withoutOwned = classifyThirdPartyCitation(
      citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}`, title: "매직테스트 영상" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(withoutOwned).toBe("social"); // 소유 목록을 안 주면 걸러지지 않고 social 로 남는다

    const withOwned = classifyThirdPartyCitation(
      citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}`, title: "매직테스트 영상" }),
      OWN_WEBSITE_KEYS,
      OWNED_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(withOwned).toBeNull(); // 소유 목록을 주면 제외된다(중복 계산 방지)
  });

  it("소유 유튜브 영상(youtube-nocookie.com 임베드 — 소셜 게이트 밖 호스트)도 ownedVideoIds 로 제외된다", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: `https://www.youtube-nocookie.com/embed/${OWNED_VIDEO_ID}`, title: "매직테스트 후기 영상" }),
      OWN_WEBSITE_KEYS,
      OWNED_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBeNull();
  });

  it("youtube-nocookie.com(소셜 목록 밖 호스트)에서 소유가 아닌 영상은 press 로 분류된다", () => {
    // youtube-nocookie.com 은 SOCIAL_PLATFORM_DOMAINS 에 없다(citation-utils.ts) — 소유가
    // 아니면 비소셜 도메인과 같은 경로로 press 가 된다. 소셜 판단은 호스트 하나로만 갈린다.
    const r = classifyThirdPartyCitation(
      citation({ url: `https://www.youtube-nocookie.com/embed/${OTHER_VIDEO_ID}`, title: "매직테스트 리뷰" }),
      OWN_WEBSITE_KEYS,
      OWNED_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("press");
  });

  it("인스타그램·링크드인·네이버 포스트 등 소셜 플랫폼은 브랜드 언급 + 비소유면 social 로 분류된다", () => {
    const cases: Array<[string, string]> = [
      ["https://www.instagram.com/p/CxAbCdEfGhI/", "매직테스트 후기 게시물"],
      ["https://www.instagram.com/reel/CxAbCdEfGhI/", "매직테스트 리뷰 릴스"],
      ["https://www.linkedin.com/posts/johndoe_activity-1234567890", "MagicTest 관련 소개"],
      [
        "https://post.naver.com/viewer/postView.naver?volumeNo=12345678&memberNo=1234567",
        "매직테스트 소개 포스트",
      ],
    ];
    for (const [url, title] of cases) {
      const r = classifyThirdPartyCitation(
        citation({ url, title }),
        OWN_WEBSITE_KEYS,
        EMPTY_VIDEO_IDS,
        BRAND_TERMS,
      );
      expect(r).toBe("social");
    }
  });

  it("⚠️ 받아들이는 한계 — 우리 인스타 계정의 개별 게시물(경로에 핸들 없음)은 소유 판별이 안 돼 social 로 분류된다", () => {
    // instagram.com/p/<id> 형태는 경로 첫 세그먼트가 "p"라 host+handle 매칭(웹사이트 목록)
    // 으로는 우리 계정 게시물인지 구분할 수 없다 — 실제로는 우리 게시물이어도 social 로
    // 분류된다. 억지로 추정하지 않고 이 한계를 그대로 둔다(press-domain-match.ts 헤더 참조).
    const r = classifyThirdPartyCitation(
      citation({ url: "https://www.instagram.com/p/OurOwnPostId/", title: "매직테스트 공식 게시물" }),
      OWN_WEBSITE_KEYS, // OWN_WEBSITES 에 instagram.com/magictest 핸들이 등록돼 있어도
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("social");
  });

  it("소셜 플랫폼이 아닌 언론사 도메인은 press 로 분류된다(소셜 분류의 과대 적용 여부 확인)", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://news-outlet.example/article/1", title: "매직테스트 관련 보도" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("press");
  });

  it("url 이 없고 domain 필드만 있어도 판정한다(citations 필드 호환)", () => {
    const r = classifyThirdPartyCitation(
      citation({ domain: "outlet.example", title: "매직테스트 소식" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe("press");
  });

  it("url·domain 이 둘 다 없으면 null", () => {
    const r = classifyThirdPartyCitation(
      citation({ title: "매직테스트" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBeNull();
  });

  it("brandTerms 가 비어 있으면 항상 null(소유·소셜 여부와 무관)", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://outlet.example/a", title: "아무 제목" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      [],
    );
    expect(r).toBeNull();
  });

  it("ownWebsiteKeys·ownedVideoIds 가 비어 있어도(제외할 소유가 없을 뿐) 분류는 정상 동작", () => {
    const r = classifyThirdPartyCitation(
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식" }),
      [],
      new Set(),
      BRAND_TERMS,
    );
    expect(r).toBe("press");
  });
});

describe("collectThirdPartyCitationEvidence — 자동화 수집·재산출 공용 진입점", () => {
  it("언론 인용만 있으면 hasPressMatch true·pressDomains 기록, hasSocialMatch false·socialDomains 빈 배열", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식" }),
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasPressMatch).toBe(true);
    expect(r.pressDomains).toEqual(["outlet.example"]);
    expect(r.hasSocialMatch).toBe(false);
    expect(r.socialDomains).toEqual([]);
  });

  it("블로그·소셜 추천만 있으면 hasSocialMatch true·socialDomains 기록, 언론 쪽은 빈 상태", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ url: "https://www.instagram.com/p/AbCdEfGhIjK/", title: "매직테스트 추천 게시물" }),
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasSocialMatch).toBe(true);
    expect(r.socialDomains).toEqual(["instagram.com"]);
    expect(r.hasPressMatch).toBe(false);
    expect(r.pressDomains).toEqual([]);
  });

  it("언론·블로그소셜이 섞여 있으면 두 플래그·두 배열이 각각 독립적으로 채워진다", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ url: "https://outlet.example/a", title: "매직테스트 보도" }),
      citation({ url: "https://blog.naver.com/reviewer123/456", title: "매직테스트 추천 후기" }),
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasPressMatch).toBe(true);
    expect(r.pressDomains).toEqual(["outlet.example"]);
    expect(r.hasSocialMatch).toBe(true);
    expect(r.socialDomains).toEqual(["blog.naver.com"]);
  });

  it("같은 도메인은 각 버킷 안에서 dedup 된다", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식" }),
      citation({ url: "https://outlet.example/b", title: "매직테스트 후속" }), // 같은 도메인 — dedup
      citation({ url: "https://other-outlet.example/c", title: "MagicTest 보도" }),
      citation({ url: "https://random-blog.example/d", title: "무관한 글" }), // 브랜드 언급 없음 — 제외
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(new Set(r.pressDomains)).toEqual(new Set(["outlet.example", "other-outlet.example"]));
  });

  it("우리 소유(웹사이트·소셜 채널·유튜브 영상) 인용은 언론·소셜 어느 쪽에서도 제외된다", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ url: "https://mysite.example/notice", title: "매직테스트 공지" }), // 우리 사이트
      citation({ url: "https://www.youtube.com/@magictest", title: "매직테스트 채널" }), // 우리 채널
      citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}`, title: "매직테스트 영상" }), // 우리 영상
      citation({ url: "https://outlet.example/a", title: "매직테스트 보도" }), // 제3자 언론 — 유일하게 남아야 함
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, OWNED_VIDEO_IDS, BRAND_TERMS);
    expect(r.pressDomains).toEqual(["outlet.example"]);
    expect(r.socialDomains).toEqual([]);
  });

  it("남의 소셜 게시물(인스타그램·링크드인 등)은 제외되지 않고 socialDomains 에 남는다(직전 개정에서 되돌림)", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ url: "https://www.instagram.com/p/CxAbCdEfGhI/", title: "매직테스트 후기 게시물" }), // 남의 인스타 게시물
      citation({ url: "https://www.linkedin.com/posts/johndoe_activity-1234567890", title: "MagicTest 소개" }), // 남의 링크드인 게시물
      citation({ url: "https://outlet.example/a", title: "매직테스트 보도" }), // 제3자 언론
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasPressMatch).toBe(true);
    expect(r.pressDomains).toEqual(["outlet.example"]);
    expect(r.hasSocialMatch).toBe(true);
    expect(new Set(r.socialDomains)).toEqual(new Set(["instagram.com", "linkedin.com"]));
  });

  it("citations 가 undefined·빈 배열이면 빈 증거", () => {
    const empty = { pressDomains: [], socialDomains: [], hasPressMatch: false, hasSocialMatch: false };
    expect(collectThirdPartyCitationEvidence(undefined, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS)).toEqual(empty);
    expect(collectThirdPartyCitationEvidence([], OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS)).toEqual(empty);
  });

  it("brandTerms 가 비어 있으면 빈 증거(소유·소셜 여부와 무관하게 매칭 자체가 없다)", () => {
    const citations: ThirdPartyCitationCandidate[] = [citation({ url: "https://outlet.example/a", title: "무관" })];
    expect(collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, [])).toEqual({
      pressDomains: [],
      socialDomains: [],
      hasPressMatch: false,
      hasSocialMatch: false,
    });
  });

  it("websites·ownedVideoIds 가 비어 있어도(설정에 값을 안 넣어도) 정상 동작한다", () => {
    const citations: ThirdPartyCitationCandidate[] = [citation({ url: "https://outlet.example/a", title: "매직테스트 소식" })];
    const r = collectThirdPartyCitationEvidence(citations, [], new Set(), BRAND_TERMS);
    expect(r.hasPressMatch).toBe(true);
    expect(r.pressDomains).toEqual(["outlet.example"]);
  });

  it("도메인 필드만 있고 url 이 없어도(citations 필드 호환) 매칭하고 pressDomains 에 그 도메인을 담는다", () => {
    const citations: ThirdPartyCitationCandidate[] = [
      citation({ domain: "outlet.example", title: "매직테스트 소식" }),
    ];
    const r = collectThirdPartyCitationEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasPressMatch).toBe(true);
    expect(r.pressDomains).toEqual(["outlet.example"]);
  });
});
