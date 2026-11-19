import { describe, it, expect } from "vitest";
import {
  hasProseBrandMention,
  isLinkOnlyBrandMention,
  stripLinkOnlyBrandForms,
} from "@/lib/server/brand-link-only";
import {
  LINK_ONLY_RULE_FROM_UTC,
  countProseMentionRuns,
  isBrandMentionedForBenchmark,
  isCompetitorMentionedForBenchmark,
  usesLinkOnlyRule,
} from "@/lib/server/benchmark-mention-rate";

const MB = ["매직바디", "국제재활필라테스협회", "magicbody"];

describe("링크만 언급 — 주소·채널 이름·출처 칩·영상 카드는 본문 언급이 아니다", () => {
  const linkOnly = [
    "자세한 내용은 www.magicbodypilates.co.kr 에서 확인하세요.",
    "출처 magicbodypilates.co +2",
    "YouTube ·매직바디 | 국제재활필라테스협회 +1",
    "관련 자료 매직바디 + 1",
    "53세 주부도 필라테스 강사 가능? 매직바디 | 국제재활필라테스협회 · 748 views",
    "참고 [web: magicbodypilates]",
    "magicbodypilates 5.",
    "https://www.youtube.com/@magicbody 영상 참고",
    "youtube.com/@magicbody 채널",
    "https://magicbodypilates.co.kr/guide/매직바디-소개",
  ];
  it.each(linkOnly)("%s", (text) => {
    expect(hasProseBrandMention(text, MB)).toBe(false);
    expect(isLinkOnlyBrandMention(text, MB)).toBe(true);
  });
});

describe("진짜 본문 언급은 남는다", () => {
  const prose = [
    "매직바디 (국제재활필라테스협회) 특징: 재활 중심",
    "MagicBody Pilates(국제재활필라테스협회 운영): 온라인 과정",
    "매직바디(MagicBody) — 재활 필라테스 교육",
    "예: 케이디에프, 대한필라테스협회, 매직바디, 기타",
    "4. 매직바디 필라테스 온라인 클래스: 기초부터",
    "상세 커리큘럼은 매직바디 온라인 과정 페이지에서 살펴보실 수 있습니다",
    "**국제재활필라테스협회/매직바디**: 재활 특화",
    "추천하는 곳은 MagicBody.",
  ];
  it.each(prose)("%s", (text) => {
    expect(hasProseBrandMention(text, MB)).toBe(true);
    expect(isLinkOnlyBrandMention(text, MB)).toBe(false);
  });

  it("본문 언급과 링크가 함께 있으면 본문 언급으로 본다", () => {
    expect(hasProseBrandMention("매직바디는 재활 중심입니다. 출처: www.magicbodypilates.co.kr", MB)).toBe(true);
  });

  it("마크다운 표 칸의 `| 매직바디 | 국제재활필라테스협회 |` 는 라벨로 지우지 않는다", () => {
    const table = "| 기관 | 운영 |\n|---|---|\n| 매직바디 | 국제재활필라테스협회 |";
    expect(hasProseBrandMention(table, MB)).toBe(true);
  });

  it("한 줄에 채널 라벨이 여럿이어도 모두 지운다", () => {
    const line = "매직바디 | 국제재활필라테스협회 · 10 views  매직바디 | 국제재활필라테스협회 · 20 views";
    expect(hasProseBrandMention(line, MB)).toBe(false);
  });
});

describe("용어 목록을 받아 일반화 — 경쟁사 영문 별칭도 같은 규칙", () => {
  const COMP = ["모던필라테스", "modernpilates", "STOTT"];
  it("주소에 붙은 영문 별칭은 링크, 독립 단어는 본문", () => {
    expect(hasProseBrandMention("출처: modernpilates.co.kr", COMP)).toBe(false);
    expect(hasProseBrandMention("stottpilates.com 참고", COMP)).toBe(false);
    expect(hasProseBrandMention("STOTT PILATES 는 캐나다 기반", COMP)).toBe(true);
    expect(hasProseBrandMention("모던필라테스 교육 과정", COMP)).toBe(true);
  });
});

describe("경계값", () => {
  it("빈 글·빈 용어 목록", () => {
    expect(hasProseBrandMention("", MB)).toBe(false);
    expect(hasProseBrandMention(null, MB)).toBe(false);
    expect(hasProseBrandMention("매직바디", [])).toBe(false);
    expect(isLinkOnlyBrandMention("무관한 글", MB)).toBe(false);
  });
  it("지운 자리는 같은 길이 공백 — 위치가 원문과 맞는다", () => {
    const text = "참고 www.magicbodypilates.co.kr 와 매직바디 과정";
    const stripped = stripLinkOnlyBrandForms(text, MB);
    expect(stripped.length).toBe(text.length);
    expect(stripped.indexOf("매직바디")).toBe(text.indexOf("매직바디"));
  });
  it("정규식 특수문자가 든 용어도 안전하다", () => {
    expect(hasProseBrandMention("요가+원 + 3", ["요가+원"])).toBe(false);
    expect(hasProseBrandMention("요가+원 수업", ["요가+원"])).toBe(true);
  });
});

describe("벤치마크 언급 수 — 우리 브랜드와 경쟁사가 같은 함수", () => {
  it("링크만 응답은 세지 않는다", () => {
    const answers = [
      "매직바디 (국제재활필라테스협회) 특징: …",
      "참고: www.magicbodypilates.co.kr",
      "YouTube ·매직바디 | 국제재활필라테스협회 +1",
      null,
      "modernpilates.co.kr 와 STOTT PILATES 비교",
    ];
    expect(countProseMentionRuns(answers, MB)).toBe(1);
    expect(countProseMentionRuns(answers, ["모던필라테스", "modernpilates"])).toBe(0);
    expect(countProseMentionRuns(answers, ["STOTT"])).toBe(1);
    expect(countProseMentionRuns(answers, [])).toBe(0);
  });
});

describe("벤치마크 기준일 — KST 11/10 00:00 이후 응답만 링크만 제외 규칙", () => {
  const LINK = "참고: www.magicbodypilates.co.kr";
  const before = "2026-11-09T14:59:59.999Z";
  const atCut = "2026-11-09T15:00:00.000Z";

  it("기준일 상수는 KST 11/10 00:00", () => {
    expect(LINK_ONLY_RULE_FROM_UTC).toBe("2026-11-09T15:00:00.000Z");
    expect(usesLinkOnlyRule(before)).toBe(false);
    expect(usesLinkOnlyRule(atCut)).toBe(true);
    expect(usesLinkOnlyRule(new Date(atCut))).toBe(true);
  });

  it("우리 브랜드 — 이전은 저장 배열, 이후는 본문 규칙", () => {
    const stored = ["magicbody"];
    expect(isBrandMentionedForBenchmark({ answer: LINK, createdAt: before, brandMentions: stored }, MB)).toBe(true);
    expect(isBrandMentionedForBenchmark({ answer: LINK, createdAt: atCut, brandMentions: stored }, MB)).toBe(false);
    expect(isBrandMentionedForBenchmark({ answer: "매직바디 추천", createdAt: before, brandMentions: [] }, MB)).toBe(false);
    expect(isBrandMentionedForBenchmark({ answer: "매직바디 추천", createdAt: atCut, brandMentions: [] }, MB)).toBe(true);
  });

  it("경쟁사 — 이전은 저장 배열 또는 본문 포함, 이후는 본문 규칙", () => {
    const COMP = ["모던필라테스", "modernpilates"];
    const link = "출처: modernpilates.co.kr";
    expect(isCompetitorMentionedForBenchmark({ answer: link, createdAt: before, competitorMentions: [] }, COMP)).toBe(true);
    expect(isCompetitorMentionedForBenchmark({ answer: link, createdAt: atCut, competitorMentions: [] }, COMP)).toBe(false);
    expect(
      isCompetitorMentionedForBenchmark({ answer: "무관", createdAt: before, competitorMentions: ["ModernPilates"] }, COMP),
    ).toBe(true);
    expect(isCompetitorMentionedForBenchmark({ answer: "모던필라테스 과정", createdAt: atCut }, COMP)).toBe(true);
  });
});
