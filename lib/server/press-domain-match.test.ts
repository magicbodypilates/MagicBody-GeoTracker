/**
 * press-domain-match.test.ts — 언론(배포 매체) 인용 판정 순수함수 단위 테스트.
 *
 * 2026-09-23 1차 개정 — 매체 도메인 allowlist 판정을 폐기하고 "브랜드 언급(제목 또는 설명) +
 * 우리 소유 아님"으로 바꿨다(press-domain-match.ts 헤더 주석 참조). 이 파일이 덮는 경계:
 *   브랜드 용어가 없는 제3자 페이지(불가) · 제목에만 있는 경우(가능) · 설명에만 있는
 *   경우(가능) · 우리 웹사이트 제외 · 우리 소유 유튜브 영상 제외(웹사이트 목록으로는 못
 *   잡는 watch URL도) · 도메인 필드 fallback · 입력이 비었을 때의 기본값.
 *
 * 2026-09-23 2차 개정(검수 반영) — "우리 소유 채널 제외"가 유튜브만 보강되고 인스타그램·
 * 링크드인·네이버 포스트 등 다른 소셜 플랫폼은 비어 있던 결함을 고쳤다. 소셜 플랫폼
 * (SOCIAL_PLATFORM_DOMAINS)을 소유 여부와 무관하게 통째로 제외하는 것으로 바뀌어, 아래
 * 경계가 추가된다: 인스타그램 개별 게시물·릴 · 링크드인 게시물 · 네이버 포스트(전부 남의
 * 계정이어도 제외) · 소셜 게이트를 통과하는 호스트(youtube-nocookie.com)에서는 여전히
 * ownedVideoIds 판정이 동작하는지 · 소셜이 아닌 도메인은 그대로 매칭되는지(과대 제외 방지).
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
  collectPressEvidence,
  evaluatePressCitation,
  type PressCitationCandidate,
} from "./press-domain-match";

const BRAND_TERMS = ["매직테스트", "MagicTest"];
const OWN_WEBSITES = ["https://mysite.example", "https://www.youtube.com/@magictest"];
const OWN_WEBSITE_KEYS = buildTargetKeys(OWN_WEBSITES);
const OWNED_VIDEO_ID = "dQw4w9WgXcQ";
const OTHER_VIDEO_ID = "aBcD_eF-123";
const OWNED_VIDEO_IDS = new Set([OWNED_VIDEO_ID]);
const EMPTY_VIDEO_IDS = new Set<string>();

function citation(p: Partial<PressCitationCandidate>): PressCitationCandidate {
  return { url: null, domain: null, title: null, description: null, ...p };
}

describe("evaluatePressCitation — 브랜드 언급 + 우리 소유 아님(2026-09-23 개정)", () => {
  it("브랜드 용어가 없는 제3자 페이지(불가) — 제목·설명 둘 다 무관하면 false", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://outlet.example/a", title: "무관한 기사", description: "브랜드 없음" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("제목에만 브랜드 용어(가능)", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://outlet.example/a", title: "매직테스트 관련 기사", description: "무관" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(true);
  });

  it("설명에만 브랜드 용어(가능)", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://outlet.example/a", title: "무관한 제목", description: "MagicTest 언급" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(true);
  });

  it("제목·설명 둘 다 브랜드 용어(가능)", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식", description: "MagicTest 관련 본문" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(true);
  });

  it("등록 매체 개념이 없다 — 어느 도메인이든 브랜드 언급만 있으면 매칭(구 allowlist 폐기)", () => {
    const r1 = evaluatePressCitation(
      citation({ url: "https://press-wire.example/a", title: "매직테스트 소식" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    const r2 = evaluatePressCitation(
      citation({ url: "https://any-random-blog.example/a", title: "매직테스트 소식" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it("우리 웹사이트 도메인은 브랜드 언급이 있어도 제외", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://mysite.example/notice", title: "매직테스트 공지" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("우리 웹사이트의 하위 도메인·경로도 제외", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://blog.mysite.example/2026/09/post", title: "매직테스트 후기" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("우리 소셜 채널(유튜브 홈 링크)도 제외", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://www.youtube.com/@magictest", title: "매직테스트 채널" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("남의 유튜브 채널 홈 링크도 소셜 플랫폼이라 제외된다(호스트 단위 — 핸들 불문, 검수 반영)", () => {
    // 2026-09-23 2차 개정 전에는 host+handle 매칭만 있어 핸들이 다르면 안 걸러졌다(구 behavior:
    // true). 이제는 소유 여부·핸들과 무관하게 youtube.com 자체가 소셜 게이트에서 제외된다.
    const r = evaluatePressCitation(
      citation({ url: "https://www.youtube.com/@someoneelse", title: "매직테스트 언급" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("우리 소유 유튜브 영상(youtube-nocookie.com 임베드)은 소셜 게이트 밖 호스트라 ownedVideoIds 로 제외된다", () => {
    // youtube.com·youtu.be 워치 URL은 이미 소셜 게이트에서 걸러지므로(위·아래 테스트),
    // ownedVideoIds 분기가 실제로 살아 있는지 보려면 그 게이트 밖 호스트가 필요하다 —
    // youtube-nocookie.com(SOCIAL_PLATFORM_DOMAINS 밖)의 임베드 URL로 대신한다.
    const withoutOwnedVideoIds = evaluatePressCitation(
      citation({ url: `https://www.youtube-nocookie.com/embed/${OWNED_VIDEO_ID}`, title: "매직테스트 후기 영상" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(withoutOwnedVideoIds).toBe(true); // 소유 목록을 안 주면 걸러지지 않는다

    const withOwnedVideoIds = evaluatePressCitation(
      citation({ url: `https://www.youtube-nocookie.com/embed/${OWNED_VIDEO_ID}`, title: "매직테스트 후기 영상" }),
      OWN_WEBSITE_KEYS,
      OWNED_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(withOwnedVideoIds).toBe(false); // 소유 목록을 주면 제외된다(중복 계산 방지)
  });

  it("소유가 아닌 다른 유튜브 영상(watch URL)도 소셜 플랫폼이라 제외된다(소셜 게이트가 소유 여부보다 우선)", () => {
    // 2026-09-23 2차 개정 전에는 브랜드 언급만 있으면 제3자 영상으로 매칭됐다(구 behavior:
    // true). 이제는 youtube.com 자체가 먼저 걸러지므로 ownedVideoIds 에 없어도 false 다.
    const r = evaluatePressCitation(
      citation({ url: `https://www.youtube.com/watch?v=${OTHER_VIDEO_ID}`, title: "매직테스트 리뷰" }),
      OWN_WEBSITE_KEYS,
      OWNED_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("인스타그램 개별 게시물(instagram.com/p/<id>)은 브랜드 언급이 있어도 소셜 플랫폼이라 제외된다", () => {
    // 경로 첫 세그먼트가 "p"라 host+handle 매칭(웹사이트 목록)으로는 애초에 안 걸러지던 사례 —
    // 소셜 게이트가 호스트만으로 먼저 끊어야 잡힌다.
    const r = evaluatePressCitation(
      citation({ url: "https://www.instagram.com/p/CxAbCdEfGhI/", title: "매직테스트 후기 게시물" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("인스타그램 릴(instagram.com/reel/<id>)은 브랜드 언급이 있어도 소셜 플랫폼이라 제외된다", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://www.instagram.com/reel/CxAbCdEfGhI/", title: "매직테스트 리뷰 릴스" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("링크드인 게시물(linkedin.com/posts/<slug>)은 브랜드 언급이 있어도 소셜 플랫폼이라 제외된다", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://www.linkedin.com/posts/johndoe_activity-1234567890", title: "MagicTest 관련 소개" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("네이버 포스트(post.naver.com)는 브랜드 언급이 있어도 소셜 플랫폼이라 제외된다", () => {
    // 쿼리 기반 뷰어 URL이라 경로 자체에 핸들이 없다 — host+handle 매칭 대상도 아니었던 사례.
    const r = evaluatePressCitation(
      citation({
        url: "https://post.naver.com/viewer/postView.naver?volumeNo=12345678&memberNo=1234567",
        title: "매직테스트 소개 포스트",
      }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("소셜 플랫폼이 아닌 언론사 도메인은 그대로 매칭된다(소셜 게이트의 과대 제외 여부 확인)", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://news-outlet.example/article/1", title: "매직테스트 관련 보도" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(true);
  });

  it("url 이 없고 domain 필드만 있어도 판정한다(citations 필드 호환)", () => {
    const r = evaluatePressCitation(
      citation({ domain: "outlet.example", title: "매직테스트 소식" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(true);
  });

  it("url·domain 이 둘 다 없으면 false", () => {
    const r = evaluatePressCitation(
      citation({ title: "매직테스트" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      BRAND_TERMS,
    );
    expect(r).toBe(false);
  });

  it("brandTerms 가 비어 있으면 항상 false(제외 조건과 무관)", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://outlet.example/a", title: "아무 제목" }),
      OWN_WEBSITE_KEYS,
      EMPTY_VIDEO_IDS,
      [],
    );
    expect(r).toBe(false);
  });

  it("ownWebsiteKeys·ownedVideoIds 가 비어 있어도(제외할 소유가 없을 뿐) 매칭은 정상 동작", () => {
    const r = evaluatePressCitation(
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식" }),
      [],
      new Set(),
      BRAND_TERMS,
    );
    expect(r).toBe(true);
  });
});

describe("collectPressEvidence — 자동화 수집·재산출 공용 진입점", () => {
  it("매칭 인용이 있으면 hasMatch true + evidence 에 도메인(host) 기록", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식" }),
    ];
    const r = collectPressEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(r.evidence).toEqual(["outlet.example"]);
  });

  it("설명만 매칭돼도 hasMatch true(제목·설명 구분 없음 — 2026-09-23 개정)", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://outlet.example/a", title: "무관 제목", description: "매직테스트 언급" }),
    ];
    const r = collectPressEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(r.evidence).toEqual(["outlet.example"]);
  });

  it("여러 인용 — 같은 도메인은 dedup, 제3자 도메인만 모은다", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://outlet.example/a", title: "매직테스트 소식" }),
      citation({ url: "https://outlet.example/b", title: "매직테스트 후속" }), // 같은 도메인 — dedup
      citation({ url: "https://other-outlet.example/c", title: "MagicTest 보도" }),
      citation({ url: "https://random-blog.example/d", title: "무관한 글" }), // 브랜드 언급 없음 — 제외
    ];
    const r = collectPressEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(new Set(r.evidence)).toEqual(new Set(["outlet.example", "other-outlet.example"]));
  });

  it("우리 소유(웹사이트·소셜 채널·유튜브 영상) 인용은 evidence 에서 전부 제외된다", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://mysite.example/notice", title: "매직테스트 공지" }), // 우리 사이트
      citation({ url: "https://www.youtube.com/@magictest", title: "매직테스트 채널" }), // 우리 채널
      citation({ url: `https://www.youtube.com/watch?v=${OWNED_VIDEO_ID}`, title: "매직테스트 영상" }), // 우리 영상
      citation({ url: "https://outlet.example/a", title: "매직테스트 보도" }), // 제3자 — 유일하게 남아야 함
    ];
    const r = collectPressEvidence(citations, OWN_WEBSITES, OWNED_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(r.evidence).toEqual(["outlet.example"]);
  });

  it("남의 소셜 게시물(인스타그램 등)은 브랜드 언급이 있어도 evidence 에서 전부 제외된다(검수 반영)", () => {
    const citations: PressCitationCandidate[] = [
      citation({ url: "https://www.instagram.com/p/CxAbCdEfGhI/", title: "매직테스트 후기 게시물" }), // 남의 인스타 게시물
      citation({ url: "https://www.linkedin.com/posts/johndoe_activity-1234567890", title: "MagicTest 소개" }), // 남의 링크드인 게시물
      citation({ url: "https://outlet.example/a", title: "매직테스트 보도" }), // 제3자 언론 — 유일하게 남아야 함
    ];
    const r = collectPressEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(r.evidence).toEqual(["outlet.example"]);
  });

  it("citations 가 undefined·빈 배열이면 빈 증거", () => {
    expect(collectPressEvidence(undefined, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS)).toEqual({
      evidence: [],
      hasMatch: false,
    });
    expect(collectPressEvidence([], OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS)).toEqual({
      evidence: [],
      hasMatch: false,
    });
  });

  it("brandTerms 가 비어 있으면 빈 증거(제외 조건과 무관하게 매칭 자체가 없다)", () => {
    const citations: PressCitationCandidate[] = [citation({ url: "https://outlet.example/a", title: "무관" })];
    expect(collectPressEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, [])).toEqual({
      evidence: [],
      hasMatch: false,
    });
  });

  it("websites·ownedVideoIds 가 비어 있어도(설정에 값을 안 넣어도) 정상 동작한다 — 코드 기본값 구조가 아니다", () => {
    const citations: PressCitationCandidate[] = [citation({ url: "https://outlet.example/a", title: "매직테스트 소식" })];
    const r = collectPressEvidence(citations, [], new Set(), BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(r.evidence).toEqual(["outlet.example"]);
  });

  it("도메인 필드만 있고 url 이 없어도(citations 필드 호환) 매칭하고 evidence 에 그 도메인을 담는다", () => {
    const citations: PressCitationCandidate[] = [
      citation({ domain: "outlet.example", title: "매직테스트 소식" }),
    ];
    const r = collectPressEvidence(citations, OWN_WEBSITES, EMPTY_VIDEO_IDS, BRAND_TERMS);
    expect(r.hasMatch).toBe(true);
    expect(r.evidence).toEqual(["outlet.example"]);
  });
});
