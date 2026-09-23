/**
 * press-domain-match.ts — 언론(배포 매체) 인용 판정 순수함수 모듈.
 *
 * 목적(계획 geotracker-youtube-press-scoring-260923 §4-1·§4-2·D2):
 *   AI 답변이 인용한 URL이 (1) 워크스페이스에 등록된 "언론(배포 매체) 도메인" 이고
 *   (2) 그 인용의 제목 또는 설명에 브랜드 용어가 있으면 "언론 인용"으로 판정한다.
 *   두 조건을 **모두** 만족해야 한다 — 도메인만으로는(그 매체가 우리 아닌 다른 글을 실었을
 *   수도 있으므로) 부족하고, 브랜드 용어만으로는(등록 안 된 아무 사이트의 언급) 언론
 *   인용이 아니다.
 *
 * 화면("브랜드 언급 출처" 목록)과 점수 신호는 문턱이 다르다(§4-2):
 *   - 화면은 이 모듈을 쓰지 않는다 — 기존 aggregateBrandMentionUrls(제목 또는 설명)를
 *     그대로 유지한다. 사람이 눈으로 보는 목록이라 넓게 잡고 사람이 거른다.
 *   - 점수 신호(VisibilityInputs.hasPressCitation)는 **제목 조건만** 반영한다. 설명 조건은
 *     증거로만 기록해 둔다(제목·설명을 각각 세어 두면, 나중에 배점을 켤 때 실측으로
 *     어느 문턱이 맞는지 정할 수 있다 — 지금 고르지 않아도 되는 결정을 지금 고르지 않는다).
 *
 * 배점은 이번 판에서 항상 0(계획 §4-1 D4′) — 이 모듈이 오탐을 내도 점수는 절대 움직이지
 * 않는다. 그래도 도메인·용어 이중 조건과 제목/설명 분리를 정확히 지키는 이유는, 증거
 * 컬럼(cited_press_domains)에 쌓이는 데이터가 훗날 배점을 켤지 판단하는 실측 근거이기
 * 때문이다 — 지금 오탐이 섞이면 그 실측이 오염된다.
 *
 * DB·Next 무의존 — vitest 단위 테스트 대상.
 */

import { normalizeTargetKey, containsBrandTerm } from "@/components/dashboard/citation-utils";

/** 인용 한 건에서 이 모듈이 참조하는 최소 형태 — Citation 타입의 부분집합. */
export type PressCitationCandidate = {
  url?: string | null;
  domain?: string | null;
  title?: string | null;
  description?: string | null;
};

/**
 * 워크스페이스 설정(brandConfig.pressDomains) → 정규화된 언론 도메인 목록.
 * www./m. 접두 제거 + 소문자 + 중복 제거. citation-utils 의 host 정규화 규칙과 정합.
 *
 * @returns 파싱 가능한 도메인만. 비거나 파싱 실패한 항목은 제외. 빈 배열이면 언론 판정이
 *   항상 false(설정이 비면 코드 기본값 — 아무것도 매칭하지 않는다).
 */
export function normalizePressDomains(domains: string[] | undefined | null): string[] {
  if (!domains?.length) return [];
  const out = new Set<string>();
  for (const raw of domains) {
    const key = normalizeTargetKey(raw);
    if (key?.host) out.add(key.host);
  }
  return [...out];
}

/**
 * citation URL의 host 가 등록된 언론 도메인(또는 그 하위 도메인·하위 주소)에 속하는지 판정.
 * 경로(주소 하위)는 신경 쓰지 않는다 — host 만 비교하므로 등록 도메인 밑의 어떤 기사
 * 경로든 매칭된다(기존 citation-brand-host-filter 의 브랜드 host 매칭과 동일 관례).
 *
 * @returns 매칭된 **등록 목록 안의 원래 도메인 문자열**(하위 도메인이어도 등록값을 반환 —
 *   증거를 도메인 단위로 그루핑하기 위함). 매칭 없으면 null.
 */
export function matchedPressDomain(
  rawUrl: string | null | undefined,
  pressDomains: readonly string[],
): string | null {
  if (!rawUrl || pressDomains.length === 0) return null;
  const key = normalizeTargetKey(rawUrl);
  if (!key?.host) return null;
  for (const domain of pressDomains) {
    if (key.host === domain || key.host.endsWith(`.${domain}`)) return domain;
  }
  return null;
}

/** 인용 한 건에 대한 언론 판정 결과 — 제목 조건과 설명 조건을 항상 따로 담는다(§6-3). */
export type PressCitationSignal = {
  /** 매칭된 등록 도메인. 도메인 조건 자체가 불만족이면 null(제목·설명은 검사하지 않는다). */
  domain: string | null;
  /** 도메인 조건 + 제목에 브랜드 용어 — 점수 신호(hasPressCitation)가 보는 조건. */
  titleMatch: boolean;
  /** 도메인 조건 + 설명에 브랜드 용어 — 증거로만 기록, 점수에는 반영하지 않는다. */
  descriptionMatch: boolean;
};

const NO_MATCH: PressCitationSignal = { domain: null, titleMatch: false, descriptionMatch: false };

/**
 * 인용 한 건을 "매체 도메인 + 브랜드 용어" 두 조건으로 판정한다(D2).
 *
 * 도메인 조건이 불만족이면 제목·설명은 아예 보지 않고 즉시 NO_MATCH 를 반환한다 —
 * "도메인만(불가)"·"용어만(불가)" 두 실패 사례가 여기서 걸러진다.
 */
export function evaluatePressCitation(
  citation: PressCitationCandidate,
  pressDomains: readonly string[],
  brandTerms: readonly string[],
): PressCitationSignal {
  const domain = matchedPressDomain(citation.url ?? citation.domain ?? null, pressDomains);
  if (!domain) return NO_MATCH;

  return {
    domain,
    titleMatch: containsBrandTerm(citation.title, [...brandTerms]),
    descriptionMatch: containsBrandTerm(citation.description, [...brandTerms]),
  };
}

/** collectPressEvidence 반환 — 증거 컬럼 저장용 + 점수 신호 플래그. */
export type PressEvidence = {
  /**
   * `cited_press_domains` 컬럼에 그대로 저장할 문자열 배열. 형식은 "<도메인>:title" ·
   * "<도메인>:description" — 제목 조건이 걸리면 title 로, 제목은 없고 설명만 걸리면
   * description 으로 기록한다(한 인용당 둘 중 하나만 — 제목 조건이 더 강한 신호라 우선).
   * 같은 (도메인, 조건) 조합은 한 번만 남는다(dedup).
   */
  evidence: string[];
  /** 이 인용 목록에 제목 조건을 만족한 언론 인용이 하나라도 있었는지 — hasPressCitation 원천. */
  hasTitleMatch: boolean;
};

/**
 * 인용 배열 전체를 순회해 언론 인용 증거를 모은다(자동화 수집 경로 · Step 5 전용 진입점).
 *
 * pressDomains 또는 brandTerms 가 비어 있으면 아무것도 매칭하지 않는다(설정이 비면
 * 코드 기본값 — 소유 유튜브 판정의 "빈 집합이면 항상 false" 관례와 동일).
 */
export function collectPressEvidence(
  citations: readonly PressCitationCandidate[] | undefined,
  pressDomains: readonly string[],
  brandTerms: readonly string[],
): PressEvidence {
  if (!citations?.length || pressDomains.length === 0 || brandTerms.length === 0) {
    return { evidence: [], hasTitleMatch: false };
  }

  const evidence = new Set<string>();
  let hasTitleMatch = false;

  for (const citation of citations) {
    const signal = evaluatePressCitation(citation, pressDomains, brandTerms);
    if (!signal.domain) continue;
    if (signal.titleMatch) {
      evidence.add(`${signal.domain}:title`);
      hasTitleMatch = true;
    } else if (signal.descriptionMatch) {
      evidence.add(`${signal.domain}:description`);
    }
  }

  return { evidence: [...evidence], hasTitleMatch };
}
