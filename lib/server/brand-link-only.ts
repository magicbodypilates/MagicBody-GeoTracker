/**
 * 「링크만 언급」 판정 — 응답 본문에서 브랜드 용어가 주소·채널 이름·출처 칩·영상 카드
 * 형태로만 나온 자리를 지우고, 남은 글에 본문 언급이 있는지 본다.
 *
 * 지우는 형태(브랜드 용어 목록을 받아 일반화한다 — 특정 브랜드를 코드에 두지 않는다):
 *   1. 주소 — `http(s)://…`, `www.…` 덩어리 전체
 *   2. 영문 용어가 더 긴 영숫자·점·슬래시·하이픈 덩어리 안에 붙은 경우
 *      (`magicbodypilates.co.kr`, `magicbodypilates`, `youtube.com/@magicbody`)
 *      — `MagicBody Pilates`·`매직바디(MagicBody)` 처럼 독립 단어면 본문으로 남긴다.
 *   3. 플랫폼 출처 카드 — `YouTube · <용어>` 류
 *   4. 채널 이름 라벨 — `<용어> | <용어>` (표 칸 안의 `| 용어 | 용어 |` 는 제외)
 *   5. 출처 칩 — `<용어> +N`
 *
 * 지운 자리는 같은 길이의 공백으로 바꾼다 — 남은 글의 위치가 원문과 그대로 맞는다.
 *
 * 순수 함수 · DB/네트워크 무의존.
 */

/** 주소·도메인 덩어리를 이루는 문자. */
const LINK_TOKEN_CHAR = /[A-Za-z0-9._/@:%?#=&~-]/;
/** 덩어리 끝에 붙어도 링크로 보지 않는 문장부호(문장 끝 마침표·콜론 등). */
const TRAILING_PUNCT = /[.:;!?~_-]+$/;
const LEADING_PUNCT = /^[.:;~_-]+/;
const HAS_ASCII_LETTER = /[A-Za-z]/;

const URL_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s<>"'()[\]{}]+/gi,
  /\bwww\.[^\s<>"'()[\]{}]+/gi,
];

const PLATFORM_NAMES = [
  "YouTube",
  "유튜브",
  "Instagram",
  "인스타그램",
  "Facebook",
  "페이스북",
  "TikTok",
  "틱톡",
  "Naver Blog",
  "네이버 블로그",
  "Threads",
  "스레드",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerms(terms: readonly string[]): string[] {
  const set = new Set<string>();
  for (const t of terms) {
    const trimmed = (t ?? "").trim();
    if (trimmed) set.add(trimmed);
  }
  // 긴 용어부터 — 정규식 선택지에서 짧은 용어가 긴 용어의 앞부분만 먹지 않게 한다.
  return [...set].sort((a, b) => b.length - a.length);
}

type Range = [number, number];

function collectRegexRanges(text: string, re: RegExp, ranges: Range[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
}

/** 규칙 2 — 영문 용어가 더 긴 링크 덩어리 안에 붙어 있으면 그 덩어리 전체를 범위로 낸다. */
function collectEmbeddedTokenRanges(text: string, terms: readonly string[], ranges: Range[]): void {
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (!HAS_ASCII_LETTER.test(term)) continue;
    const t = term.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(t, from);
      if (idx < 0) break;
      let start = idx;
      while (start > 0 && LINK_TOKEN_CHAR.test(text[start - 1])) start -= 1;
      let end = idx + t.length;
      while (end < text.length && LINK_TOKEN_CHAR.test(text[end])) end += 1;
      const core = text.slice(start, end).replace(TRAILING_PUNCT, "").replace(LEADING_PUNCT, "");
      if (core.toLowerCase() !== t) ranges.push([start, end]);
      from = idx + t.length;
    }
  }
}

/**
 * 응답 본문에서 링크·칩·카드 형태의 브랜드 표기를 공백으로 지운 글을 돌려준다.
 * 용어 목록이 비어 있으면 원문 그대로.
 */
export function stripLinkOnlyBrandForms(text: string, terms: readonly string[]): string {
  if (!text) return text ?? "";
  const ranges: Range[] = [];

  for (const re of URL_PATTERNS) collectRegexRanges(text, re, ranges);

  const list = normalizeTerms(terms);
  if (list.length > 0) {
    collectEmbeddedTokenRanges(text, list, ranges);

    const termAlt = list.map(escapeRegExp).join("|");
    const platformAlt = PLATFORM_NAMES.map(escapeRegExp).join("|");
    // 규칙 3 — 플랫폼 출처 카드(`YouTube ·매직바디`).
    collectRegexRanges(
      text,
      new RegExp(`(?:${platformAlt})[ \\t]*[·•・|][ \\t]*(?:${termAlt})`, "gi"),
      ranges,
    );
    // 규칙 4 — 채널 이름 라벨(`매직바디 | 국제재활필라테스협회`). 줄이 `|` 로 시작하면
    // 마크다운 표 행이라 본문으로 남긴다.
    collectRegexRanges(
      text,
      new RegExp(`(?<!^[ \\t]*\\|[^\\n]*)(?:${termAlt})[ \\t]*\\|[ \\t]*(?:${termAlt})`, "gim"),
      ranges,
    );
    // 규칙 5 — 출처 칩(`매직바디 + 1`).
    collectRegexRanges(text, new RegExp(`(?:${termAlt})[ \\t]*\\+[ \\t]*\\d+`, "gi"), ranges);
  }

  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const [s, e] of ranges) {
    for (let i = s; i < e && i < chars.length; i++) {
      // 줄바꿈은 남긴다 — 표 칸 판정(같은 줄)과 위치가 흔들리지 않게.
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

/** 링크·칩·카드 형태를 뺀 본문에 브랜드 용어가 하나라도 남아 있는가. */
export function hasProseBrandMention(text: string | null | undefined, terms: readonly string[]): boolean {
  if (!text) return false;
  const list = normalizeTerms(terms);
  if (list.length === 0) return false;
  const lower = stripLinkOnlyBrandForms(text, list).toLowerCase();
  return list.some((t) => lower.includes(t.toLowerCase()));
}

/** 원문에는 용어가 있는데 본문 언급은 없는 경우(링크·칩·카드뿐). */
export function isLinkOnlyBrandMention(
  text: string | null | undefined,
  terms: readonly string[],
): boolean {
  if (!text) return false;
  const list = normalizeTerms(terms);
  if (list.length === 0) return false;
  const lower = text.toLowerCase();
  const raw = list.some((t) => lower.includes(t.toLowerCase()));
  return raw && !hasProseBrandMention(text, list);
}
