/**
 * 인용 출처(citations) ↔ 브랜드 공식 채널 매칭 유틸.
 *
 * 배경: `state.brand.websites`에 등록된 공식 URL과 AI가 돌려준 citation URL을
 * 비교해 "공식 인용"을 판정한다. 일반 웹사이트는 도메인 단위 비교로 충분하지만
 * 유튜브/인스타/페북/네이버블로그·카페 등 **공용 플랫폼**은 도메인만 비교하면
 * 남의 채널 URL까지 모두 브랜드 공식으로 오인되므로, 경로의 첫 세그먼트(채널 핸들)
 * 까지 함께 비교해야 한다.
 */

import type { Citation } from "./types";

/** 핸들 기반 매칭이 필요한 공용 플랫폼 도메인 */
export const SOCIAL_PLATFORM_DOMAINS = new Set<string>([
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "threads.net",
  "linkedin.com",
  "blog.naver.com",
  "cafe.naver.com",
  "post.naver.com",
  "brunch.co.kr",
]);

type NormalizedKey = { host: string; seg: string };

/**
 * URL → {host, seg} 형태의 표준 키.
 * - host: www./m. 접두어 제거, 소문자
 * - seg : 경로의 첫 세그먼트 (채널 핸들 후보) 소문자
 */
export function normalizeTargetKey(url: string): NormalizedKey | null {
  if (!url || typeof url !== "string") return null;
  try {
    const withScheme = url.startsWith("http") ? url : `https://${url}`;
    const u = new URL(withScheme);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "").toLowerCase();
    if (!host) return null;
    const seg = u.pathname.replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
    return { host, seg };
  } catch {
    return null;
  }
}

/**
 * 매칭 키 문자열화 — 비교·저장·표시를 위해 단일 문자열로 직렬화.
 * - 일반 도메인: "example.com"
 * - 소셜 플랫폼 + 핸들: "youtube.com/@channel_handle"
 */
function keyToString(host: string, seg: string): string {
  if (SOCIAL_PLATFORM_DOMAINS.has(host)) return `${host}/${seg}`;
  return host;
}

/**
 * 브랜드(또는 경쟁사) 공식 URL 목록과 citations[] 를 비교해 매칭된 키들을 반환.
 * 반환 키 형식은 `citedBrandDomains` 필드에 그대로 저장되며, 표시 측은
 * `isUrlMatchingCitedKeys`로 비교한다.
 */
export function matchCitationDomains(
  citations: Citation[] | undefined,
  targetUrls: string[] | undefined,
): string[] {
  if (!citations?.length || !targetUrls?.length) return [];

  const targets: NormalizedKey[] = [];
  for (const url of targetUrls) {
    const k = normalizeTargetKey(url);
    if (k) targets.push(k);
  }
  if (targets.length === 0) return [];

  const matched = new Set<string>();
  for (const c of citations) {
    const ck = normalizeTargetKey(c.url || c.domain || "");
    if (!ck) continue;
    for (const t of targets) {
      const hostMatch = ck.host === t.host || ck.host.endsWith(`.${t.host}`);
      if (!hostMatch) continue;
      if (SOCIAL_PLATFORM_DOMAINS.has(t.host)) {
        // 소셜: 핸들까지 일치해야 함 (t.seg가 없으면 매칭 불가 — 브랜드 설정 불완전)
        if (t.seg && ck.seg === t.seg) {
          matched.add(keyToString(t.host, t.seg));
          break;
        }
      } else {
        // 일반 도메인: 호스트(서브도메인 포함) 매치면 인정
        matched.add(t.host);
        break;
      }
    }
  }
  return [...matched];
}

/**
 * 브랜드 공식 URL 목록 → 표준 매칭 키 목록.
 * 스코어링 등 citations 배열이 아닌 단순 URL 배열 매칭에 사용.
 */
export function buildTargetKeys(targetUrls: string[] | undefined): string[] {
  if (!targetUrls?.length) return [];
  const keys = new Set<string>();
  for (const url of targetUrls) {
    const k = normalizeTargetKey(url);
    if (!k) continue;
    if (SOCIAL_PLATFORM_DOMAINS.has(k.host)) {
      if (k.seg) keys.add(keyToString(k.host, k.seg));
    } else {
      keys.add(k.host);
    }
  }
  return [...keys];
}

/**
 * 텍스트 한 조각(제목 또는 설명 하나)에 브랜드 용어(이름/별칭) 중 하나라도 포함되는지.
 *
 * 계획 v2 §4-1(D4′)의 언론(배포 매체) 판정이 "제목 조건"과 "설명 조건"을 **따로** 세야
 * 해서 만든 단일-필드 원시 판정이다. 아래 isBrandMentionMatch(제목+설명 합본 판정)와는
 * 별개로 press-domain-match.ts 가 이 함수를 재사용한다.
 */
export function containsBrandTerm(
  text: string | null | undefined,
  brandTerms: string[] | undefined,
): boolean {
  if (!brandTerms?.length) return false;
  const haystack = (text ?? "").toLowerCase();
  if (!haystack.trim()) return false;
  return brandTerms.some((t) => {
    const term = t?.trim().toLowerCase();
    return !!term && haystack.includes(term);
  });
}

/**
 * 제목 + 설명(공백으로 합친 한 덩어리)에 브랜드 용어(이름/별칭)가 하나라도 포함되는지.
 *
 * "브랜드 언급(제3자)" 판정의 **유일 구현**이다(계획 v2 §5 Step 2③ — 이전에는 이 파일의
 * isRelatedCitation 과 lib/server/citation-url-aggregate.ts 의 isBrandMentionText 가 같은
 * 로직을 각자 들고 있었다). 제목·설명을 하나의 haystack 으로 합쳐서 검사하는 방식을 그대로
 * 유지한다 — containsBrandTerm(title) || containsBrandTerm(description) 로 쪼개면, 별칭에
 * 공백이 있고 제목 끝과 설명 시작이 그 별칭의 앞뒤 절반과 우연히 맞아떨어지는 극단적인
 * 경계 사례에서 결과가 달라질 수 있어(통합 리팩터 전후 동일이 §6-2 Hard Gate), 굳이
 * 바꿀 이유가 없는 기존 계산 방식을 그대로 보존한다.
 */
export function isBrandMentionMatch(
  title: string | null | undefined,
  description: string | null | undefined,
  brandTerms: string[] | undefined,
): boolean {
  if (!brandTerms?.length) return false;
  const haystack = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return brandTerms.some((t) => {
    const term = t?.trim().toLowerCase();
    return !!term && haystack.includes(term);
  });
}

/**
 * 인용의 제목 또는 설명에 브랜드 용어(이름/별칭)가 포함되었는지.
 * "공식 출처"(URL 매칭)가 아니지만 제3자 콘텐츠가 브랜드를 언급한 경우
 * "연관 출처"로 분류하기 위한 판정.
 */
export function isRelatedCitation(
  citation: Citation | undefined,
  brandTerms: string[] | undefined,
): boolean {
  return isBrandMentionMatch(citation?.title, citation?.description, brandTerms);
}

/**
 * 저장된 매칭 키 목록(`citedBrandDomains`)과 주어진 인용 URL을 비교.
 * 표시 레이어에서 각 출처 링크에 "📍 공식" 뱃지를 달지 판정할 때 사용.
 */
export function isUrlMatchingCitedKeys(
  url: string,
  citedKeys: string[] | undefined,
): boolean {
  if (!url || !citedKeys?.length) return false;
  const ck = normalizeTargetKey(url);
  if (!ck) return false;
  for (const key of citedKeys) {
    if (key.includes("/")) {
      // 소셜 핸들 키 — host + seg 전부 일치해야 함
      const [kHost, kSeg] = key.split("/", 2);
      if (ck.host === kHost && ck.seg === kSeg) return true;
    } else {
      // 일반 도메인 키 — 호스트(서브도메인 포함) 매치
      if (ck.host === key || ck.host.endsWith(`.${key}`)) return true;
    }
  }
  return false;
}
