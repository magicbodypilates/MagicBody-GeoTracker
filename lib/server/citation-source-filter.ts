/**
 * citation-source-filter.ts — 「인용 출처」 전체 출처 표에서 빼는 잡 URL 거름 (단일 정의).
 *
 * 2026-11-05 이전에는 화면(sovereign-dashboard.tsx 의 partnerLeaderboard)에 같은 목록이 있었다.
 * 전체 출처 표를 서버 집계(stats/citations/sources)로 옮기면서 거름 규칙을 그대로 이 파일로 옮겼다 —
 * 목록을 고칠 때는 이 파일 하나만 고친다.
 *
 * 규칙(이전 화면 동작과 동일):
 *   - URL 로 해석되지 않으면 제외
 *   - 잡 호스트(CDN·추적·스키마) 자체이거나 그 하위 도메인이면 제외
 *   - 경로가 이미지·스타일·스크립트·글꼴·영상 확장자로 끝나면 제외
 *   - 쿼리 문자열이 200자를 넘으면 제외
 *
 * 참고: lib/server/brightdata-scraper.ts 에도 수집 단계용 거름이 따로 있다. 그쪽은 "수집 결과에서 무엇을
 * 출처로 저장할지" 이고, 이 파일은 "저장된 출처 중 무엇을 표에 보일지" 라 단계가 달라 합치지 않았다.
 */

export const JUNK_SOURCE_HOSTS: readonly string[] = [
  "cloudfront.net", "cdn.prod.website-files.com", "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com", "unpkg.com", "fastly.net", "akamaihd.net",
  "connect.facebook.net", "facebook.net", "google-analytics.com",
  "googletagmanager.com", "doubleclick.net", "w3.org", "schema.org",
  "amazonaws.com", "cloudflare.com", "hotjar.com", "sentry.io",
];

export const JUNK_SOURCE_EXT_PATTERN = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|woff2?|ttf|eot|mp4|webm)(\?|$)/i;

/** 전체 출처 표에 보일 URL 인가 */
export function isCleanSourceUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (JUNK_SOURCE_HOSTS.some((j) => host === j || host.endsWith(`.${j}`))) return false;
    if (JUNK_SOURCE_EXT_PATTERN.test(parsed.pathname)) return false;
    if (parsed.search.length > 200) return false;
    return true;
  } catch {
    return false;
  }
}
