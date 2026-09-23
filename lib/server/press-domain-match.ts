/**
 * press-domain-match.ts — 제3자 인용(언론·블로그/소셜) 판정 순수함수 모듈.
 *
 * 목적(2026-09-23 3차 개정 — 사장님 지시로 재설계):
 *   인용의 제목 또는 설명에 브랜드 용어가 있고, 그 URL이 우리 소유(공식 웹사이트·소유
 *   유튜브 영상)가 아니면 "제3자 인용"이다. 여기까지는 직전 개정과 같다. 다른 것은 그
 *   다음이다 — 직전 개정은 소셜 플랫폼(SOCIAL_PLATFORM_DOMAINS)을 여기서 통째로
 *   **제외**했다. 그러면 타 블로거·인스타그램 등이 브랜드를 추천한 글까지 언론 게재물과
 *   함께 버려진다(실측으로 확인 — 이 저장소는 PUBLIC 이라 구체 수치는 코드에 남기지
 *   않는다). 그래서 이번 판은 SOCIAL_PLATFORM_DOMAINS 를 제외용이 아니라 **분류용**으로
 *   쓴다 — 소셜 플랫폼이면 "블로그·소셜 추천", 아니면 "언론 게재" 로 나눠 **둘 다
 *   남긴다.** 보도자료 배포와 블로거 추천은 성격이 달라 섞으면 어느 활동이 효과를 내는지
 *   알 수 없다는 것이 이번 재설계의 이유다.
 *
 * "우리 소유" 제외는 그대로 두 갈래다(isOwnedCitationUrl 로 통합):
 *   1. 공식 웹사이트(brandConfig.websites) — citation-utils 의 buildTargetKeys +
 *      isUrlMatchingCitedKeys 로 판정.
 *   2. 소유 유튜브 영상(brand_youtube_videos, video-ID 집합) — youtube-video-match.ts 의
 *      isOwnedYoutubeVideo 로 판정.
 *   이 판정은 화면의 "브랜드 언급 출처(제3자)" 목록(citation-url-aggregate.ts)도 함께
 *   가져다 쓴다(export) — 두 곳이 각자 계산하면 한쪽만 고쳐졌을 때 소리 없이 어긋난다.
 *   이번 재설계의 발단이 정확히 그런 어긋남(소셜 배제 로직이 한쪽에만 반영됨)이었다.
 *
 *   ⚠️ 한계 — 개별 콘텐츠 URL(예: instagram.com/p/<id>·instagram.com/reel/<id>)처럼 경로
 *   첫 세그먼트가 채널 핸들이 아니라 콘텐츠 타입인 형태는 host+handle 매칭으로 소유를
 *   판별할 수 없다. 그런 URL은 우리 게시물이어도 "블로그·소셜 추천"으로 분류된다 — 지금
 *   받아들이는 한계이며 억지로 추정하지 않는다.
 *
 * 배점은 이번 판에서도 항상 0(언론·블로그·소셜 둘 다) — 이 모듈이 오탐을 내도 점수는
 * 절대 움직이지 않는다. 그래도 판정을 정확히 지키는 이유는, 증거 컬럼
 * (cited_press_domains·cited_social_domains)에 쌓이는 데이터가 훗날 배점을 켤지 판단하는
 * 실측 근거이기 때문이다.
 *
 * DB·Next 무의존 — vitest 단위 테스트 대상.
 */

import {
  buildTargetKeys,
  isBrandMentionMatch,
  isUrlMatchingCitedKeys,
  normalizeTargetKey,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import { isOwnedYoutubeVideo } from "@/lib/server/youtube-video-match";

/** 인용 한 건에서 이 모듈이 참조하는 최소 형태 — Citation 타입의 부분집합. */
export type ThirdPartyCitationCandidate = {
  url?: string | null;
  domain?: string | null;
  title?: string | null;
  description?: string | null;
};

/**
 * 인용 URL 이 "우리 소유 채널"(공식 웹사이트 또는 소유 유튜브 영상)에 해당하는지.
 *
 * classifyThirdPartyCitation(이 파일)과 citation-url-aggregate.ts 의 "브랜드 언급
 * 출처(제3자)" 화면 목록이 이 판정을 공유한다 — 한쪽만 고쳐지고 다른 쪽이 안 따라오면
 * 화면과 증거 컬럼이 서로 다른 기준으로 "제3자"를 말하게 된다.
 *
 * @param ownWebsiteKeys buildTargetKeys(websites) 결과(또는 그와 같은 형식의 키 배열).
 * @param ownedVideoIds 소유 유튜브 video-ID 집합. 비어 있으면 유튜브 소유 판정은 항상
 *   false(조회 안전 — isOwnedYoutubeVideo 의 기존 계약).
 */
export function isOwnedCitationUrl(
  rawUrl: string | null | undefined,
  ownWebsiteKeys: readonly string[],
  ownedVideoIds: Set<string> | null | undefined,
): boolean {
  if (!rawUrl) return false;
  if (isUrlMatchingCitedKeys(rawUrl, [...ownWebsiteKeys])) return true;
  if (isOwnedYoutubeVideo(rawUrl, ownedVideoIds)) return true;
  return false;
}

/** classifyThirdPartyCitation 판정 결과 — 어느 증거 컬럼에 쌓일지. */
export type ThirdPartyCitationClass = "press" | "social";

/**
 * 인용 한 건을 "언론 게재" / "블로그·소셜 추천" / (해당 없음)으로 분류한다.
 *
 * 순서 — ① 소유 제외(웹사이트·유튜브 영상) → ② 브랜드 언급 → ③ 호스트로 분류. 소유부터
 * 걸러야 우리 자신의 채널이 "우리가 우리를 추천한 글"로 잘못 집계되지 않는다.
 *
 * @returns 소유이거나 브랜드 언급이 없거나 호스트를 판별할 수 없으면 null. 그 외에는
 *   호스트가 SOCIAL_PLATFORM_DOMAINS 에 있으면 "social", 없으면 "press".
 */
export function classifyThirdPartyCitation(
  citation: ThirdPartyCitationCandidate,
  ownWebsiteKeys: readonly string[],
  ownedVideoIds: Set<string>,
  brandTerms: readonly string[],
): ThirdPartyCitationClass | null {
  const raw = citation.url ?? citation.domain ?? null;
  if (!raw) return null;
  if (isOwnedCitationUrl(raw, ownWebsiteKeys, ownedVideoIds)) return null;
  if (!isBrandMentionMatch(citation.title, citation.description, [...brandTerms])) return null;
  const host = normalizeTargetKey(raw)?.host ?? citation.domain ?? null;
  if (!host) return null;
  return SOCIAL_PLATFORM_DOMAINS.has(host) ? "social" : "press";
}

/** collectThirdPartyCitationEvidence 반환 — 증거 컬럼 저장용 + 언론/소셜 매치 플래그. */
export type ThirdPartyCitationEvidence = {
  /**
   * `cited_press_domains` 컬럼에 그대로 저장할 도메인 문자열 배열(dedup). host(www./m.
   * 제거 · 소문자)만 담는다 — 어느 매체에 몇 건 실렸는지가 목적이라 도메인 단위면 충분하다.
   */
  pressDomains: string[];
  /** `cited_social_domains` 컬럼에 그대로 저장할 도메인 문자열 배열(dedup). 형식은 위와 동일. */
  socialDomains: string[];
  /** 이 인용 목록에 언론 인용이 하나라도 있었는지. */
  hasPressMatch: boolean;
  /** 이 인용 목록에 블로그·소셜 인용이 하나라도 있었는지. */
  hasSocialMatch: boolean;
};

const NO_EVIDENCE: ThirdPartyCitationEvidence = {
  pressDomains: [],
  socialDomains: [],
  hasPressMatch: false,
  hasSocialMatch: false,
};

/**
 * 인용 배열 전체를 순회해 언론·블로그/소셜 증거를 각각 모은다(자동화 수집 경로 + 재산출
 * 목표 판정 공용 진입점).
 *
 * citations 또는 brandTerms 가 비어 있으면 아무것도 매칭하지 않는다. websites·ownedVideoIds
 * 가 비어 있는 것은 정상 상태다(제외할 "우리 소유"가 없을 뿐 — 매칭 자체를 막지 않는다).
 */
export function collectThirdPartyCitationEvidence(
  citations: readonly ThirdPartyCitationCandidate[] | undefined,
  websites: readonly string[],
  ownedVideoIds: Set<string>,
  brandTerms: readonly string[],
): ThirdPartyCitationEvidence {
  if (!citations?.length || brandTerms.length === 0) return NO_EVIDENCE;

  const ownWebsiteKeys = buildTargetKeys([...websites]);
  const pressDomains = new Set<string>();
  const socialDomains = new Set<string>();
  let hasPressMatch = false;
  let hasSocialMatch = false;

  for (const citation of citations) {
    const cls = classifyThirdPartyCitation(citation, ownWebsiteKeys, ownedVideoIds, brandTerms);
    if (!cls) continue;
    const raw = citation.url ?? citation.domain ?? "";
    const domain = normalizeTargetKey(raw)?.host ?? citation.domain ?? null;
    if (!domain) continue;
    if (cls === "press") {
      pressDomains.add(domain);
      hasPressMatch = true;
    } else {
      socialDomains.add(domain);
      hasSocialMatch = true;
    }
  }

  return {
    pressDomains: [...pressDomains],
    socialDomains: [...socialDomains],
    hasPressMatch,
    hasSocialMatch,
  };
}
