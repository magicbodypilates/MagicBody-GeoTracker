/**
 * press-domain-match.ts — 언론(배포 매체) 인용 판정 순수함수 모듈.
 *
 * 목적(계획 geotracker-youtube-press-scoring-260923 — 2026-09-23 수정판, 검수 반영으로 2차 개정):
 *   AI 답변이 인용한 URL의 제목 또는 설명에 브랜드 용어가 있고, 그 URL이 소셜 플랫폼이 아니며
 *   우리 소유(공식 웹사이트·유튜브 영상)도 아니면 "언론(제3자 매체) 인용"으로 판정한다.
 *
 * ⛔ 2026-09-23 1차 개정 — 매체 도메인 목록(allowlist) 판정을 폐기했다. 원래 요구는 "제목이나
 *   본문에 브랜드명이 들어간 것을 전부" 잡는 것이었는데, 초판이 여기에 "등록된 매체 도메인"
 *   조건을 덧붙여 범위를 좁혔다. 실측 결과 이 방식은 콘텐츠가 원 출처 두 곳을 거쳐 수십 개
 *   매체로 계속 재배포되는 실제 흐름을 전혀 못 잡았다(등록 4곳으로 183건만 잡히고 나머지
 *   약 300건을 놓침 — 실릴 때마다 매체가 달라져 목록 유지가 애초에 불가능). 그래서 도메인
 *   allowlist(`brandConfig.pressDomains`)를 없애고 "브랜드 언급 + 우리 소유 아님" 하나로
 *   합쳤다 — 이 기준은 화면("브랜드 언급 출처(제3자)" 목록)이 이미 쓰는 것과 같다
 *   (citation-utils.ts 의 isBrandMentionMatch + citation-url-aggregate.ts 의 isBrandCitationKey
 *   와 동일한 성격의 판정). 설정에 값을 넣어야만 동작하는 구조를 없애는 것이 목적이므로,
 *   워크스페이스 설정(pressDomains)은 더 이상 읽지 않는다.
 *
 * ⛔ 2026-09-23 2차 개정(검수 반영) — 소셜 플랫폼을 판정에서 통째로 제외했다. 1차 개정 직후
 *   "우리 소유 채널 제외"를 ①웹사이트 host+handle 매칭 ②유튜브 video-ID 매칭 두 갈래로만
 *   보강했는데, 이 둘은 "우리 채널"만 걸러낼 뿐 "남의 소셜 게시물"은 그대로 언론 인용으로
 *   샜다. 게다가 인스타그램 개별 게시물(instagram.com/p/<id>)·릴(reel/<id>)·링크드인 게시물
 *   (linkedin.com/posts/<slug>)처럼 경로 첫 세그먼트가 핸들이 아니라 콘텐츠 타입인 URL은
 *   host+handle 매칭 조건 자체가 성립하지 않아 우리 채널이어도 못 걸렀다. 이 판정의 목적이
 *   "언론(매체)에 실렸는가"이고 소셜 플랫폼은 우리 것이든 남의 것이든 언론사가 아니므로,
 *   소유 여부를 따지기 전에 SOCIAL_PLATFORM_DOMAINS(citation-utils.ts) 호스트를 먼저 통째로
 *   제외한다 — 판정 순서는 아래 evaluatePressCitation 참조.
 *
 * "우리 소유" 제외는 두 갈래다(둘 다 필요 — 하나만 쓰면 중복 계산된다). 소셜 게이트를 통과한
 * (= SOCIAL_PLATFORM_DOMAINS 밖 호스트) URL 만 이 아래 두 갈래에 도달한다:
 *   1. 공식 웹사이트(brandConfig.websites) — citation-utils 의 buildTargetKeys +
 *      isUrlMatchingCitedKeys 로 판정.
 *   2. 소유 유튜브 영상(brand_youtube_videos, video-ID 집합) — youtube-video-match.ts 의
 *      isOwnedYoutubeVideo 로 판정. youtube.com·youtu.be 호스트는 이미 소셜 게이트에서
 *      제외되므로, 이 경로는 그 게이트를 통과하는 호스트(youtube-nocookie.com 임베드·구글
 *      래핑 링크 등)에 실린 소유 영상을 잡는다.
 *
 * 배점은 이번 판에서도 항상 0(계획 §4-1 D4′) — 이 모듈이 오탐을 내도 점수는 절대 움직이지
 * 않는다. 그래도 판정을 정확히 지키는 이유는, 증거 컬럼(cited_press_domains)에 쌓이는
 * 데이터가 훗날 배점을 켤지 판단하는 실측 근거이기 때문이다 — 지금 오탐(특히 우리 소유
 * 채널의 중복 계산)이 섞이면 그 실측이 오염된다.
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
export type PressCitationCandidate = {
  url?: string | null;
  domain?: string | null;
  title?: string | null;
  description?: string | null;
};

/** collectPressEvidence 반환 — 증거 컬럼 저장용 + 점수 신호 플래그. */
export type PressEvidence = {
  /**
   * `cited_press_domains` 컬럼에 그대로 저장할 도메인 문자열 배열(dedup). 매칭된 인용의
   * host(www./m. 제거 · 소문자)만 담는다 — 어느 매체에 몇 건 실렸는지가 목적이라 도메인
   * 단위면 충분하고, 등록 목록이 없어졌으므로 "등록값"이라는 개념 자체가 없다.
   */
  evidence: string[];
  /** 이 인용 목록에 언론 인용이 하나라도 있었는지 — hasPressCitation 원천. */
  hasMatch: boolean;
};

const NO_EVIDENCE: PressEvidence = { evidence: [], hasMatch: false };

/**
 * 인용 URL 의 호스트가 소셜 플랫폼(SOCIAL_PLATFORM_DOMAINS)인지.
 *
 * 언론(제3자 매체) 판정의 첫 게이트 — 소셜 플랫폼은 우리 채널이든 남의 채널이든 언론사가
 * 아니므로, 소유 여부를 따지기 전에 호스트 단위로 통째로 제외한다. 인스타그램 개별 게시물
 * (instagram.com/p/<id>)·릴(reel/<id>)·링크드인 게시물(linkedin.com/posts/<slug>)처럼 경로
 * 첫 세그먼트가 채널 핸들이 아니라 콘텐츠 타입인 URL은 host+handle 매칭(isUrlMatchingCitedKeys)
 * 으로는 걸러지지 않으므로, 경로 형태와 무관하게 호스트만으로 먼저 끊는다.
 */
function isSocialPlatformUrl(raw: string): boolean {
  const host = normalizeTargetKey(raw)?.host;
  return !!host && SOCIAL_PLATFORM_DOMAINS.has(host);
}

/**
 * 인용 한 건이 "소셜 플랫폼이 아니고 우리 소유도 아닌 제3자가 브랜드를 언급한 것"으로
 * 판정되는지.
 *
 * 순서가 중요하다 — ① 소셜 플랫폼(SOCIAL_PLATFORM_DOMAINS, 우리·남의 채널 불문 언론 아님)
 * → ② 소유 판정(웹사이트·유튜브 영상) → ③ 브랜드 언급. ①을 가장 먼저 걸러야 인스타그램
 * 개별 게시물·링크드인 게시물처럼 경로 첫 세그먼트가 핸들이 아닌 형태가 ②(host+handle
 * 매칭)로 안 걸러지는 사각을 막는다. ②는 ①을 통과한 것 중 우리 자신의 인용을 걸러 이중
 * 계산을 막는다(§4-1: "유튜브·인스타·네이버 등은 이미 별도 경로로 처리되므로 중복 계산되면
 * 안 된다").
 *
 * @param ownWebsiteKeys buildTargetKeys(websites) 결과 — 반복 호출 시 매번 다시 만들지 않도록
 *   호출부(collectPressEvidence)가 한 번만 계산해서 넘긴다.
 * @param ownedVideoIds 소유 유튜브 video-ID 집합. 비어 있으면 유튜브 소유 판정은 항상 false
 *   (조회 안전 — isOwnedYoutubeVideo 의 기존 계약).
 */
export function evaluatePressCitation(
  citation: PressCitationCandidate,
  ownWebsiteKeys: readonly string[],
  ownedVideoIds: Set<string>,
  brandTerms: readonly string[],
): boolean {
  const raw = citation.url ?? citation.domain ?? null;
  if (!raw) return false;
  if (isSocialPlatformUrl(raw)) return false; // 소셜 플랫폼(우리·남의 채널 불문) — 언론 아님
  if (isUrlMatchingCitedKeys(raw, [...ownWebsiteKeys])) return false; // 우리 웹사이트
  if (isOwnedYoutubeVideo(raw, ownedVideoIds)) return false; // 우리 유튜브 영상(소셜 게이트 밖 호스트 한정)
  return isBrandMentionMatch(citation.title, citation.description, [...brandTerms]);
}

/**
 * 인용 배열 전체를 순회해 언론 인용 증거를 모은다(자동화 수집 경로 + 재산출 목표 판정 공용
 * 진입점).
 *
 * citations 또는 brandTerms 가 비어 있으면 아무것도 매칭하지 않는다. websites·ownedVideoIds
 * 가 비어 있는 것은 정상 상태다(제외할 "우리 소유"가 없을 뿐 — 매칭 자체를 막지 않는다).
 */
export function collectPressEvidence(
  citations: readonly PressCitationCandidate[] | undefined,
  websites: readonly string[],
  ownedVideoIds: Set<string>,
  brandTerms: readonly string[],
): PressEvidence {
  if (!citations?.length || brandTerms.length === 0) return NO_EVIDENCE;

  const ownWebsiteKeys = buildTargetKeys([...websites]);
  const evidence = new Set<string>();
  let hasMatch = false;

  for (const citation of citations) {
    if (!evaluatePressCitation(citation, ownWebsiteKeys, ownedVideoIds, brandTerms)) continue;
    hasMatch = true;
    const raw = citation.url ?? citation.domain ?? "";
    const domain = normalizeTargetKey(raw)?.host ?? citation.domain ?? null;
    if (domain) evidence.add(domain);
  }

  return { evidence: [...evidence], hasMatch };
}
