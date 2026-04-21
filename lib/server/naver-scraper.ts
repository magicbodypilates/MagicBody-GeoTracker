import { scrapePage } from "./unlocker";
import type {
  NaverAiBriefingResult,
  NaverAiSource,
} from "./sro-types";

export interface NaverAiOptions {
  /** 브랜드 공식 도메인들 (인용 판정용) */
  brandDomains: string[];
  /** 브랜드명/별칭 (멘션 판정용) */
  brandAliases: string[];
  /** 경쟁사명 (멘션 감지용) */
  competitors?: string[];
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function emptyResult(
  keyword: string,
  sourceUrl: string
): NaverAiBriefingResult {
  return {
    keyword,
    exists: false,
    snippet: "",
    mentionCount: 0,
    brandMentioned: false,
    brandCited: false,
    sources: [],
    competitorsMentioned: [],
    fetchedAt: new Date().toISOString(),
    sourceUrl,
  };
}

/**
 * NAVER disclaimer / 안내 문구 패턴. 본문으로 오인되지 않도록 제거한다.
 * 네이버가 AI 브리핑 블록 바로 아래에 항상 노출하는 정형 문구들.
 */
const DISCLAIMER_PATTERNS: RegExp[] = [
  /실험\s*단계로\s*정확하지\s*않을\s*수\s*있어요\.?/g,
  /네이버의\s*AI\s*기반\s*검색\s*기술을\s*활용하여[^]*?답변입니다\.?/g,
  /출처에\s*기재된\s*여러\s*문서를\s*기반으로[^]*?확인하세요\.?/g,
  /AI\s*브리핑에서\s*제공하는\s*이미지와\s*동영상은[^]*?가지지\s*않습니다\.?/g,
];

function stripDisclaimers(block: string): string {
  let out = block;
  for (const re of DISCLAIMER_PATTERNS) {
    out = out.replace(re, "");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * NAVER 검색 결과 HTML에서 "AI 브리핑" 블록을 추출하는 휴리스틱 파서.
 * Bright Data Web Unlocker가 markdown 형태로 렌더링된 본문을 반환한다고 가정한다.
 *
 * NAVER는 공식 API가 없고 블록 구조가 변경될 수 있어 여러 키워드 패턴으로 탐지한다:
 *   - "AI 브리핑"
 *   - "AI Briefing"
 *   - "AI 요약"
 *
 * 본문 추출 전략:
 *   1) "AI 브리핑" 키워드 라인부터 시작
 *   2) 다음 heading을 만나도 네이버 고정 섹션("관련도순", "최신순", "이미지", "VIEW", "블로그",
 *      "카페", "지식iN", "지도", "쇼핑", "뉴스", "인플루언서", "동영상")이면 거기까지 본문으로 포함
 *   3) 빈 줄 3개 연속 또는 파일 끝에서 종료
 */
/** 시작 패턴 매칭 결과 — 진단용으로 어떤 패턴이 매칭됐는지 반환 */
function findAiBriefingStart(md: string): { startIdx: number; matched: string } {
  const startPatterns: Array<[string, RegExp]> = [
    ["AI 브리핑", /AI\s*브리핑/i],
    ["AI Briefing", /AI\s*Briefing/i],
    ["AI 요약", /AI\s*요약/i],
    ["AI 답변", /AI\s*답변/i],
    ["AI 추천", /AI\s*추천/i],
    ["AI Summary", /AI\s*Summary/i],
    ["네이버 AI", /네이버\s*AI/i],
    ["Cue:", /Cue\s*[:：]/i],
  ];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [name, p] of startPatterns) {
      if (p.test(lines[i])) return { startIdx: i, matched: name };
    }
  }
  return { startIdx: -1, matched: "" };
}

function extractAiBriefingBlock(md: string): { block: string; startedBy: string } {
  const sectionBreakHeadings = [
    /관련도순/,
    /최신순/,
    /VIEW/,
    /블로그/,
    /카페/,
    /지식iN/,
    /지식인/,
    /이미지/,
    /동영상/,
    /뉴스/,
    /쇼핑/,
    /지도/,
    /인플루언서/,
    /파워링크/,
    /연관검색어/,
  ];

  const { startIdx, matched } = findAiBriefingStart(md);
  if (startIdx === -1) return { block: "", startedBy: "" };

  const lines = md.split(/\r?\n/);
  let endIdx = lines.length;
  let emptyRun = 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // 네이버 다른 섹션 heading을 만나면 블록 종료
    if (/^#{1,4}\s+/.test(line)) {
      const headText = line.replace(/^#+\s*/, "");
      if (sectionBreakHeadings.some((p) => p.test(headText))) {
        endIdx = i;
        break;
      }
    }
    if (line.trim() === "") {
      emptyRun++;
      // 긴 AI 답변을 너무 일찍 자르지 않도록 5줄 연속 공백에서 종료
      if (emptyRun >= 5) {
        endIdx = i;
        break;
      }
    } else {
      emptyRun = 0;
    }
  }
  return {
    block: lines.slice(startIdx, endIdx).join("\n").trim(),
    startedBy: matched,
  };
}

/** markdown에서 URL 추출 (링크 형식 + 베어 URL) */
function extractUrls(md: string): Array<{ url: string; title: string }> {
  const results: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();

  // [title](url)
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) {
    const url = m[2];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, title: m[1].trim() });
    }
  }

  // 베어 URL
  const bareRe = /(?<!\]\()(https?:\/\/[^\s)<>]+)/g;
  while ((m = bareRe.exec(md)) !== null) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, title: "" });
    }
  }
  return results;
}

/**
 * NAVER AI 브리핑을 조회하고 브랜드 멘션/인용 여부를 판정한다.
 */
export async function fetchNaverAiBriefing(
  keyword: string,
  options: NaverAiOptions
): Promise<NaverAiBriefingResult> {
  const searchUrl =
    "https://search.naver.com/search.naver?query=" +
    encodeURIComponent(keyword);

  const page = await scrapePage(searchUrl);
  if (page.error) {
    console.error("[NAVER-AI] scrape error:", page.error);
    return { ...emptyResult(keyword, searchUrl), error: page.error };
  }

  const md = page.fullText ?? "";
  if (!md.trim()) {
    return {
      ...emptyResult(keyword, searchUrl),
      error: "빈 응답 (스크래핑 실패 가능성)",
    };
  }

  const { block: rawBlock, startedBy } = extractAiBriefingBlock(md);
  if (!rawBlock) {
    return {
      ...emptyResult(keyword, searchUrl),
      markdownPreview: md.slice(0, 5000),
      error:
        "AI 브리핑 시작 패턴을 응답에서 찾지 못했습니다. 네이버가 이 키워드에 AI 브리핑을 생성하지 않았거나, Bright Data Unlocker가 동적 로드된 블록을 캡처하지 못했을 수 있습니다. 프리뷰에서 'AI', '브리핑', 'Cue' 등의 단어가 보이는지 확인하세요.",
    };
  }

  // disclaimer/안내 문구 제거 후 실제 본문만 남김
  const block = stripDisclaimers(rawBlock);

  // disclaimer만 있었고 실제 답변 본문이 없으면 실패로 간주
  const bodyWithoutHeading = block
    .replace(/^#{1,4}\s+AI\s*브리핑\s*$/gm, "")
    .replace(/^#{1,4}\s+AI\s*Briefing\s*$/gim, "")
    .replace(/^#{1,4}\s+AI\s*요약\s*$/gm, "")
    .replace(/^#{1,4}\s+AI\s*답변\s*$/gm, "")
    .trim();
  if (bodyWithoutHeading.length < 30) {
    return {
      ...emptyResult(keyword, searchUrl),
      markdownPreview: rawBlock.slice(0, 5000),
      error: `AI 브리핑 블록은 감지됐으나("${startedBy}" 패턴 매칭) 본문이 비어있습니다. 네이버 렌더링 지연 또는 disclaimer만 캡처되었을 가능성. 프리뷰를 확인하세요.`,
    };
  }

  const brandDomainSet = new Set(
    options.brandDomains
      .map((d) => extractHost(d))
      .filter((d) => d.length > 0)
  );

  // 블록 내 URL → 소스 변환. NAVER 내부 URL 제외 (인용은 외부 사이트만)
  const urls = extractUrls(block);
  const sources: NaverAiSource[] = urls
    .filter((u) => {
      const host = extractHost(u.url);
      return host && !host.endsWith("naver.com") && !host.endsWith("naver.net");
    })
    .map((u) => {
      const domain = extractHost(u.url);
      return {
        url: u.url,
        domain,
        title: u.title,
        isBrand: brandDomainSet.has(domain),
      };
    });

  const blockLower = block.toLowerCase();
  const aliasesLower = options.brandAliases
    .map(normalize)
    .filter((a) => a.length > 0);

  let mentionCount = 0;
  for (const a of aliasesLower) {
    const re = new RegExp(
      a.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
      "gi"
    );
    const matches = blockLower.match(re);
    if (matches) mentionCount += matches.length;
  }
  const brandMentioned = mentionCount > 0 || sources.some((s) => s.isBrand);
  const brandCited = sources.some((s) => s.isBrand);

  const competitorsMentioned = (options.competitors ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter((c) => blockLower.includes(c.toLowerCase()));

  // 스니펫은 본문을 800자 이내로 자름 (400 → 800으로 확대)
  const snippet =
    bodyWithoutHeading.length > 800
      ? bodyWithoutHeading.slice(0, 800) + "..."
      : bodyWithoutHeading;

  return {
    keyword,
    exists: true,
    snippet,
    mentionCount,
    brandMentioned,
    brandCited,
    sources,
    competitorsMentioned,
    fetchedAt: new Date().toISOString(),
    sourceUrl: searchUrl,
  };
}
