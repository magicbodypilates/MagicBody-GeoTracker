/**
 * youtube-video-match.test.ts — 유튜브 video-ID 추출·정규화·소유 판정 순수함수 단위 테스트.
 *
 * 계획 geotracker-youtube-video-match-v2 §6 단계 9a.
 * 핵심 방어: 과대매칭 차단(H1)·wrapper 깊이 1 커버리지(M3)·fuzz(L4). DB·Next 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  extractYoutubeVideoId,
  canonicalYoutubeWatchUrl,
  isOwnedYoutubeVideo,
  YOUTUBE_VIDEO_ID_RE,
} from "./youtube-video-match";

// 11자 유효 ID 샘플 (하이픈·언더스코어 포함 케이스)
const ID = "dQw4w9WgXcQ";
const ID2 = "aBcD_eF-123";

describe("extractYoutubeVideoId — direct 형태", () => {
  it("watch?v=<id>", () => {
    expect(extractYoutubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    // 부가 query 가 있어도 v 만 추출
    expect(extractYoutubeVideoId(`https://youtube.com/watch?v=${ID}&t=30s&list=PL`)).toBe(ID);
  });

  it("youtu.be/<id>", () => {
    expect(extractYoutubeVideoId(`https://youtu.be/${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://youtu.be/${ID}?si=abc`)).toBe(ID);
  });

  it("shorts·embed·live·/v/", () => {
    expect(extractYoutubeVideoId(`https://youtube.com/shorts/${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://youtube.com/live/${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://youtube.com/v/${ID}`)).toBe(ID);
  });

  it("m.·music. 서브도메인·youtube-nocookie", () => {
    expect(extractYoutubeVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
  });

  it("scheme 없는 입력도 보정 파싱", () => {
    expect(extractYoutubeVideoId(`youtu.be/${ID}`)).toBe(ID);
    expect(extractYoutubeVideoId(`www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it("하이픈·언더스코어 포함 11자 ID", () => {
    expect(extractYoutubeVideoId(`https://youtu.be/${ID2}`)).toBe(ID2);
  });
});

describe("extractYoutubeVideoId — wrapper(깊이 1)", () => {
  it("google /url?url=<encoded youtube>", () => {
    const inner = encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`);
    expect(extractYoutubeVideoId(`https://www.google.com/url?url=${inner}&sa=D`)).toBe(ID);
  });

  it("google /search?q=<encoded youtu.be> (이중 인코딩 포함)", () => {
    const once = `https://youtu.be/${ID}`;
    expect(extractYoutubeVideoId(`https://google.com/search?q=${encodeURIComponent(once)}`)).toBe(ID);
    // 이중 인코딩 — 한 겹만 디코드되므로 유효 URL 이 아니면 null (과대 추출 안 함)
    const twice = encodeURIComponent(encodeURIComponent(once));
    expect(extractYoutubeVideoId(`https://google.com/search?q=${twice}`)).toBeNull();
  });

  it("youtube attribution_link?u=<상대 watch 경로>", () => {
    const u = encodeURIComponent(`/watch?v=${ID}&feature=share`);
    expect(extractYoutubeVideoId(`https://www.youtube.com/attribution_link?a=x&u=${u}`)).toBe(ID);
  });

  it("youtube redirect?q=<youtube url>", () => {
    const q = encodeURIComponent(`https://youtu.be/${ID}`);
    expect(extractYoutubeVideoId(`https://www.youtube.com/redirect?q=${q}`)).toBe(ID);
  });

  it("google 래핑이지만 대상이 비유튜브 → null", () => {
    const inner = encodeURIComponent("https://example.com/watch?v=abc");
    expect(extractYoutubeVideoId(`https://www.google.com/url?url=${inner}`)).toBeNull();
  });
});

describe("extractYoutubeVideoId — 과대매칭 차단 (H1)", () => {
  it("allowlist 밖 host 의 임베디드 URL 파라미터 → null", () => {
    expect(extractYoutubeVideoId(`https://evil.com/?next=https://youtube.com/watch?v=${ID}`)).toBeNull();
    expect(extractYoutubeVideoId(`https://blog.com/?redirect=https://youtu.be/${ID}`)).toBeNull();
    expect(extractYoutubeVideoId(`https://evil.com/watch?v=${ID}`)).toBeNull();
  });

  it("비유튜브 host 문자열에 youtube.com/youtu.be 포함 → null", () => {
    expect(extractYoutubeVideoId(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
    expect(extractYoutubeVideoId(`https://youtube.com.evil.com/watch?v=${ID}`)).toBeNull();
    expect(extractYoutubeVideoId(`https://fake-youtu.be.evil.com/${ID}`)).toBeNull();
  });

  it("무제한 wrapper 재귀 안 함 — wrapper 안의 wrapper 는 따라가지 않음(깊이 1)", () => {
    // google url= 이 다시 google url= 을 담아도 두 번째는 재파싱하지 않는다.
    const innerG = encodeURIComponent(
      `https://www.google.com/url?url=${encodeURIComponent(`https://youtu.be/${ID}`)}`,
    );
    expect(extractYoutubeVideoId(`https://www.google.com/url?url=${innerG}`)).toBeNull();
  });
});

describe("extractYoutubeVideoId — fuzz·형식 방어 (L4)", () => {
  it("빈/공백/비문자열 → null", () => {
    expect(extractYoutubeVideoId("")).toBeNull();
    expect(extractYoutubeVideoId("   ")).toBeNull();
    expect(extractYoutubeVideoId(null)).toBeNull();
    expect(extractYoutubeVideoId(undefined)).toBeNull();
  });

  it("malformed % 인코딩 → 파싱 실패 시 null (throw 안 함)", () => {
    expect(extractYoutubeVideoId("https://youtube.com/watch?v=%E0%A4%A")).toBeNull();
    expect(extractYoutubeVideoId("%%%not a url%%%")).toBeNull();
  });

  it("잘못된 ID 길이(10·12자) → null", () => {
    expect(extractYoutubeVideoId("https://youtu.be/short12345")).toBeNull(); // 10자? "short12345"=10
    expect(extractYoutubeVideoId("https://youtu.be/toolong12345")).toBeNull(); // 12자
    expect(extractYoutubeVideoId(`https://youtube.com/watch?v=${ID}x`)).toBeNull(); // 12자
  });

  it("query 순서 변형은 결과 불변", () => {
    expect(extractYoutubeVideoId(`https://youtube.com/watch?t=1&v=${ID}&feature=x`)).toBe(ID);
    expect(extractYoutubeVideoId(`https://youtube.com/watch?feature=x&v=${ID}&t=1`)).toBe(ID);
  });

  it("우연히 11자 토큰이 경로에 있어도 지정 형태 아니면 null", () => {
    // youtube.com 이지만 watch/shorts/embed/live/v 형태가 아닌 경로
    expect(extractYoutubeVideoId(`https://youtube.com/${ID}`)).toBeNull();
    expect(extractYoutubeVideoId(`https://youtube.com/results?search_query=${ID}`)).toBeNull();
    // 채널 핸들 URL 은 영상 아님
    expect(extractYoutubeVideoId("https://youtube.com/@magicbody1/videos")).toBeNull();
  });

  it("YOUTUBE_VIDEO_ID_RE 자체 형식", () => {
    expect(YOUTUBE_VIDEO_ID_RE.test(ID)).toBe(true);
    expect(YOUTUBE_VIDEO_ID_RE.test("short")).toBe(false);
    expect(YOUTUBE_VIDEO_ID_RE.test("has spaces1")).toBe(false);
  });
});

describe("canonicalYoutubeWatchUrl / isOwnedYoutubeVideo", () => {
  it("canonical watch URL 형태", () => {
    expect(canonicalYoutubeWatchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it("isOwnedYoutubeVideo — 빈 집합이면 항상 false", () => {
    expect(isOwnedYoutubeVideo(`https://youtu.be/${ID}`, null)).toBe(false);
    expect(isOwnedYoutubeVideo(`https://youtu.be/${ID}`, new Set())).toBe(false);
  });

  it("isOwnedYoutubeVideo — 포함/미포함", () => {
    const owned = new Set([ID]);
    expect(isOwnedYoutubeVideo(`https://youtu.be/${ID}`, owned)).toBe(true);
    expect(isOwnedYoutubeVideo(`https://youtube.com/watch?v=${ID}`, owned)).toBe(true);
    expect(isOwnedYoutubeVideo(`https://youtu.be/${ID2}`, owned)).toBe(false);
    // 소유 ID 를 임베디드로 위장한 비유튜브 host → 소유 아님(과대매칭 차단)
    expect(isOwnedYoutubeVideo(`https://evil.com/?u=https://youtu.be/${ID}`, owned)).toBe(false);
  });
});
