/**
 * youtube-video-match.ts — 유튜브 영상 video-ID 추출·정규화·소유 판정 순수함수 모듈.
 *
 * 목적(계획 v2 §5 결정 A):
 *   "인용 출처" 집계에서, AI 답변이 인용한 유튜브 영상 URL 의 video-ID 를 안전하게 추출해
 *   우리 채널(@magicbody1) 소유 영상 집합과 대조한다. 소유로 판정되면 그 인용을
 *   "내 사이트 인용" 목록에 표시한다 (노출 점수 재계산은 범위 밖 — D1).
 *
 * 설계 원칙 (과대매칭 차단 — 계획 H1·M2·M3):
 *   - 문자열 스캔(정규식으로 URL 어디서든 11자 토큰 긁기)을 전면 폐기. 대신 `new URL()` 객체
 *     파싱 + host allowlist 로만 판정한다 (normalizeCitationUrl 과 동일 파싱 인프라).
 *   - direct: host(www./m./music. 접두 제거)가 allowlist(youtube.com·youtube-nocookie.com·youtu.be)
 *     일 때만 watch(?v=)·shorts·embed·live·/v/ 경로에서 추출.
 *   - wrapper: youtube-owned(attribution_link·redirect) + google search/url 래핑만 재파싱 깊이 1 로 커버.
 *     그 외 임의 host 의 임베디드 URL(evil.com/?next=youtube.com/...)은 재파싱하지 않아 오탐을 차단한다.
 *   - 무제한 wrapper 재귀·임의 host 임베디드 URL·11자 우연 토큰 스캔은 거부(오탐 위험 > 이득).
 *
 * DB·Next 무의존 — vitest 단위 테스트 대상.
 */

/** 유튜브 video-ID 형식 — 11자 [A-Za-z0-9_-] (계획 L1 CHECK 제약과 동일 규칙) */
export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * direct 판정 대상 host allowlist (www./m./music. 접두 제거 후 비교).
 * youtu.be 는 경로 첫 세그먼트가 곧 video-ID 라 별도 처리한다.
 */
const DIRECT_HOSTS = new Set<string>(["youtube.com", "youtube-nocookie.com"]);

/** youtube.com/<prefix>/<id> 형태에서 <id> 를 두 번째 세그먼트로 갖는 경로 접두 */
const PATH_ID_PREFIXES = new Set<string>(["shorts", "embed", "live", "v"]);

/**
 * host 정규화 — 소문자 + www./m./music. 접두 1회 제거.
 * normalizeCitationUrl 의 host 규칙(www./m. 제거)에 music.(유튜브 뮤직) 을 추가로 흡수한다.
 */
function stripHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.|music\.)/, "");
}

/** 경로 첫 세그먼트(선행 슬래시 제거) */
function firstPathSegment(pathname: string): string {
  return pathname.replace(/^\/+/, "").split("/")[0] ?? "";
}

/**
 * 이미 파싱된 URL 에서 direct video-ID 를 추출한다 (wrapper 재파싱 없이).
 * allowlist host + 지정 경로/파라미터에서만 추출하며, 형식 검증(11자)을 통과해야 반환한다.
 *
 * @returns 유효한 video-ID 또는 null.
 */
function extractDirectVideoId(u: URL): string | null {
  const host = stripHost(u.hostname);

  // youtu.be/<id> — 경로 첫 세그먼트가 video-ID
  if (host === "youtu.be") {
    const seg = firstPathSegment(u.pathname);
    return YOUTUBE_VIDEO_ID_RE.test(seg) ? seg : null;
  }

  // youtube.com / youtube-nocookie.com
  if (DIRECT_HOSTS.has(host)) {
    // watch?v=<id>
    const v = u.searchParams.get("v");
    if (v && YOUTUBE_VIDEO_ID_RE.test(v)) return v;

    // /shorts/<id> · /embed/<id> · /live/<id> · /v/<id>
    const segs = u.pathname.replace(/^\/+/, "").split("/");
    if (segs.length >= 2 && PATH_ID_PREFIXES.has((segs[0] ?? "").toLowerCase())) {
      const id = segs[1] ?? "";
      if (YOUTUBE_VIDEO_ID_RE.test(id)) return id;
    }
  }

  return null;
}

/**
 * wrapper URL(youtube-owned·google search/url)에서 재파싱 대상 URL 문자열과 base 를 추출한다.
 * allowlist 밖 host(evil.com·blog.com 등)의 임의 파라미터(next·redirect_to 등)는 대상에서 제외해
 * `evil.com/?next=youtube.com/watch?v=OWNED` 오탐을 원천 차단한다 (계획 H1).
 *
 * @returns { value, base } 또는 null. value 는 상대·절대 모두 가능(new URL(value, base) 로 해석).
 */
function extractWrappedTarget(u: URL): { value: string; base: string } | null {
  const host = stripHost(u.hostname);
  const path = u.pathname.toLowerCase();

  // google 검색 결과·리다이렉트 래핑 — url 또는 q 파라미터가 절대 URL
  if ((host === "google.com" || host.endsWith(".google.com")) && (path === "/search" || path === "/url")) {
    const v = u.searchParams.get("url") ?? u.searchParams.get("q");
    return v ? { value: v, base: "https://www.google.com" } : null;
  }

  // youtube-owned 래핑 — attribution_link?u=<상대경로> · redirect?q=<url>
  if (DIRECT_HOSTS.has(host)) {
    if (path === "/attribution_link") {
      const v = u.searchParams.get("u");
      return v ? { value: v, base: "https://www.youtube.com" } : null;
    }
    if (path === "/redirect") {
      const v = u.searchParams.get("q");
      return v ? { value: v, base: "https://www.youtube.com" } : null;
    }
  }

  return null;
}

/**
 * 인용 URL → 유튜브 video-ID 추출 (없으면 null).
 *
 * 로직 (계획 v2 §5 결정 A):
 *   1. 빈/비문자열 → null.
 *   2. scheme 보정 후 new URL 파싱(실패 → null).
 *   3. direct 추출(allowlist host + watch/shorts/embed/live/v/·youtu.be).
 *   4. 실패 시 wrapper 재파싱 깊이 1(youtube-owned·google 래핑만). 재파싱 결과는 direct 규칙만 적용.
 *   5. 최종 후보는 11자 형식 검증 통과해야 반환.
 *
 * 오탐 차단: allowlist 밖 host 의 임베디드 URL·무제한 재귀·우연 토큰 스캔은 인정하지 않는다.
 */
export function extractYoutubeVideoId(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }

  // 3. direct
  const direct = extractDirectVideoId(u);
  if (direct) return direct;

  // 4. wrapper(깊이 1) — youtube-owned·google 래핑만 재파싱
  const wrapped = extractWrappedTarget(u);
  if (wrapped) {
    let wu: URL;
    try {
      // value 가 상대경로면 base(유튜브/구글)에 대해 해석, 절대 URL 이면 그대로.
      wu = new URL(wrapped.value, wrapped.base);
    } catch {
      return null;
    }
    // 재파싱 결과는 direct 규칙만 적용 — wrapper 안의 wrapper 는 따라가지 않는다(깊이 1 고정).
    return extractDirectVideoId(wu);
  }

  return null;
}

/**
 * video-ID → 표준 watch URL. 소유로 판정된 인용을 이 형태로 치환해 3형태(watch·youtu.be·래핑)를
 * 하나의 canonicalUrlKey(`youtube.com/watch?v=ID`)로 병합한다 (계획 v2 §5 결정 C).
 */
export function canonicalYoutubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * 인용 URL 이 우리 소유 영상 집합에 속하는지 판정.
 * 빈 집합이면 항상 false(조회 안전 — 소유 영상 미등록/미갱신 시 기존 동작 불변).
 */
export function isOwnedYoutubeVideo(
  rawUrl: string | null | undefined,
  ownedVideoIds: Set<string> | null | undefined,
): boolean {
  if (!ownedVideoIds || ownedVideoIds.size === 0) return false;
  const id = extractYoutubeVideoId(rawUrl);
  return !!id && ownedVideoIds.has(id);
}
