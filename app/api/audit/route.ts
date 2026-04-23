import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  url: z.string().url(),
});

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Check = {
  id: string;
  label: string;
  category: "discovery" | "structure" | "content" | "technical" | "rendering";
  pass: boolean;
  value: string;
  detail: string;
};

async function tryFetch(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GEO-AEO-Tracker/1.0" },
      cache: "no-store",
      redirect: "follow",
    });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, text, status: res.status };
  } catch {
    return { ok: false, text: "", status: 0 };
  }
}

/**
 * SPA(Vue/React) 사이트는 존재하지 않는 경로에도 try_files 설정으로
 * index.html 을 HTTP 200 으로 반환한다. llms.txt, sitemap.xml 등
 * 순수 텍스트 파일 존재 여부를 확인할 때 이 fallback 을 걸러낸다.
 */
function isRealTextFile(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return !trimmed.startsWith("<!doctype") && !trimmed.startsWith("<html");
}

export async function POST(req: NextRequest) {
  try {
    const { url } = bodySchema.parse(await req.json());
    const target = new URL(url);
    const checks: Check[] = [];

    // ── Fetch the page ─────────────────────────────────
    const pageRes = await tryFetch(url);
    if (!pageRes.ok) {
      return NextResponse.json(
        { error: `Unable to fetch page (${pageRes.status})` },
        { status: 400 },
      );
    }
    const html = pageRes.text;
    const plain = stripHtml(html);

    // ── Parallel fetches ───────────────────────────────
    const [llmsRes, llmsFullRes, robotsRes, sitemapRes] = await Promise.all([
      tryFetch(`${target.origin}/llms.txt`),
      tryFetch(`${target.origin}/llms-full.txt`),
      tryFetch(`${target.origin}/robots.txt`),
      tryFetch(`${target.origin}/sitemap.xml`),
    ]);

    // ═══════════════════════════════════════════════════
    // CATEGORY: DISCOVERY
    // ═══════════════════════════════════════════════════

    // 1. llms.txt
    const llmsReal = llmsRes.ok && isRealTextFile(llmsRes.text);
    checks.push({
      id: "llms_txt",
      label: "llms.txt",
      category: "discovery",
      pass: llmsReal,
      value: llmsReal ? "있음" : "없음",
      detail: llmsReal
        ? `${target.origin}/llms.txt 에 존재 (${llmsRes.text.length} bytes)`
        : "llms.txt 파일이 없습니다. 이 파일은 AI 모델에게 사이트의 목적과 우선 콘텐츠를 알려줍니다.",
    });

    // 2. llms-full.txt
    const llmsFullReal = llmsFullRes.ok && isRealTextFile(llmsFullRes.text);
    checks.push({
      id: "llms_full_txt",
      label: "llms-full.txt",
      category: "discovery",
      pass: llmsFullReal,
      value: llmsFullReal ? "있음" : "없음",
      detail: llmsFullReal
        ? `${target.origin}/llms-full.txt 에 존재 (${llmsFullRes.text.length} bytes)`
        : "llms-full.txt 가 없습니다. AI 모델에 상세 컨텍스트를 제공하는 확장 파일입니다.",
    });

    // 3. robots.txt ‑ AI bot access
    const aiBots = ["gptbot", "chatgpt-user", "claudebot", "anthropic-ai", "google-extended", "googleother", "cohere-ai", "bytespider", "perplexitybot", "ccbot"];
    const blockedBots: string[] = [];
    const allowedBots: string[] = [];
    if (robotsRes.ok) {
      for (const bot of aiBots) {
        const botPattern = new RegExp(`user-agent:\\s*${bot}[\\s\\S]*?disallow:\\s*/`, "i");
        if (botPattern.test(robotsRes.text)) {
          blockedBots.push(bot);
        } else {
          allowedBots.push(bot);
        }
      }
    }
    const botAccessOk = robotsRes.ok && blockedBots.length <= 2;
    checks.push({
      id: "robots_ai_access",
      label: "AI 봇 접근 (robots.txt)",
      category: "discovery",
      pass: botAccessOk,
      value: robotsRes.ok ? `${aiBots.length}개 중 ${blockedBots.length}개 차단` : "robots.txt 없음",
      detail: robotsRes.ok
        ? blockedBots.length > 0
          ? `차단됨: ${blockedBots.join(", ")}. 허용됨: ${allowedBots.slice(0, 5).join(", ")}${allowedBots.length > 5 ? "\u2026" : ""}`
          : "주요 AI 봇이 모두 크롤링 허용 상태입니다."
        : "robots.txt 파일이 없습니다 \u2014 AI 봇이 기본적으로 모든 페이지를 크롤링합니다.",
    });

    // 4. Sitemap
    const hasSitemap = sitemapRes.ok && isRealTextFile(sitemapRes.text) && sitemapRes.text.includes("<url");
    const sitemapUrlCount = (sitemapRes.text.match(/<url>/gi) ?? []).length;
    checks.push({
      id: "sitemap",
      label: "XML 사이트맵",
      category: "discovery",
      pass: hasSitemap,
      value: hasSitemap ? `URL ${sitemapUrlCount}개` : "없음",
      detail: hasSitemap
        ? `사이트맵에 ${sitemapUrlCount}개의 URL 항목이 등록되어 있습니다.`
        : "sitemap.xml 파일이 없습니다. 사이트맵은 AI 시스템이 페이지를 발견하고 색인하도록 돕습니다.",
    });

    // ═══════════════════════════════════════════════════
    // CATEGORY: STRUCTURE
    // ═══════════════════════════════════════════════════

    // 5. JSON-LD Structured Data
    const jsonLdBlocks = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
    const schemaTypes: string[] = [];
    for (const block of jsonLdBlocks) {
      const inner = block.replace(/<script[^>]*>|<\/script>/gi, "");
      try {
        const parsed = JSON.parse(inner);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item?.["@type"]) {
            const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
            schemaTypes.push(...types);
          }
        }
      } catch { /* skip invalid JSON-LD */ }
    }
    checks.push({
      id: "json_ld",
      label: "JSON-LD 구조화 데이터",
      category: "structure",
      pass: jsonLdBlocks.length > 0,
      value: jsonLdBlocks.length > 0 ? `${jsonLdBlocks.length}개 블록 (${schemaTypes.length}개 타입)` : "없음",
      detail: schemaTypes.length > 0
        ? `스키마 타입: ${[...new Set(schemaTypes)].join(", ")}`
        : "JSON-LD 구조화 데이터가 없습니다. Organization, Product, FAQPage, Article 등의 스키마를 추가하세요.",
    });

    // 6. FAQ Schema
    const hasFaqSchema = schemaTypes.some((t) => /faq/i.test(t));
    const hasFaqHtml = /<details|<summary|class="faq"|id="faq"|class="accordion"/i.test(html);
    checks.push({
      id: "faq_schema",
      label: "FAQ / Q&A 스키마",
      category: "structure",
      pass: hasFaqSchema || hasFaqHtml,
      value: hasFaqSchema ? "스키마 있음" : hasFaqHtml ? "HTML만 있음 (스키마 없음)" : "없음",
      detail: hasFaqSchema
        ? "FAQPage 스키마가 있습니다 \u2014 AI 모델이 Q&A 쌍을 추출할 수 있습니다."
        : hasFaqHtml
          ? "FAQ 형태의 HTML 요소는 있지만 FAQPage 스키마 마크업이 없습니다. JSON-LD FAQPage 스키마를 추가하세요."
          : "FAQ 콘텐츠나 스키마가 감지되지 않습니다. FAQ 스키마는 AI 답변 인용률을 크게 향상시킵니다.",
    });

    // 7. Open Graph Tags
    const ogTags = html.match(/<meta[^>]*property=["']og:[^"']*["'][^>]*>/gi) ?? [];
    const ogTitle = /og:title/i.test(html);
    const ogDesc = /og:description/i.test(html);
    const ogImage = /og:image/i.test(html);
    const ogComplete = ogTitle && ogDesc && ogImage;
    checks.push({
      id: "open_graph",
      label: "Open Graph 태그",
      category: "structure",
      pass: ogComplete,
      value: `태그 ${ogTags.length}개${ogComplete ? " (완전)" : ""}`,
      detail: ogComplete
        ? "og:title, og:description, og:image가 모두 존재합니다."
        : `누락: ${[!ogTitle && "og:title", !ogDesc && "og:description", !ogImage && "og:image"].filter(Boolean).join(", ")}. OG 태그는 AI 도구가 콘텐츠를 미리보기하고 인용하는 데 도움이 됩니다.`,
    });

    // 8. Meta Description
    const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
    const metaDesc = metaDescMatch?.[1] ?? "";
    const metaDescOk = metaDesc.length >= 50 && metaDesc.length <= 300;
    checks.push({
      id: "meta_description",
      label: "메타 설명 (Meta Description)",
      category: "structure",
      pass: metaDescOk,
      value: metaDesc ? `${metaDesc.length}자` : "없음",
      detail: metaDesc
        ? metaDescOk
          ? `적절한 길이 (${metaDesc.length}자): "${metaDesc.slice(0, 100)}\u2026"`
          : `길이 ${metaDesc.length}자 \u2014 ${metaDesc.length < 50 ? "너무 짧음" : "너무 김"}. 50\u2013160자를 목표로 하세요.`
        : "메타 설명이 없습니다. AI 도구가 콘텐츠 요약으로 사용합니다.",
    });

    // 9. Canonical Tag
    const hasCanonical = /<link[^>]*rel=["']canonical["']/i.test(html);
    checks.push({
      id: "canonical",
      label: "Canonical 태그",
      category: "structure",
      pass: hasCanonical,
      value: hasCanonical ? "있음" : "없음",
      detail: hasCanonical
        ? "Canonical 태그가 있습니다 \u2014 중복 콘텐츠 문제를 방지합니다."
        : "Canonical 태그가 없습니다. AI 모델이 올바른 URL을 참조하도록 추가하세요.",
    });

    // ═══════════════════════════════════════════════════
    // CATEGORY: CONTENT
    // ═══════════════════════════════════════════════════

    // 10. BLUF / Direct-Answer Style
    const firstChunkLen = Math.max(plain.length * 0.2, 400);
    const firstChunk = plain.slice(0, Math.floor(firstChunkLen));
    const bulletCount = (html.match(/<li\b/gi) ?? []).length;
    const hasDirectAnswer = /\b(in short|tl;dr|summary|key takeaways|bottom line|the answer is|here('?s| is) (what|how|why))\b/i.test(firstChunk);
    const blufScore = Math.min(1, (Number(hasDirectAnswer) + Number(bulletCount > 3) + Number(firstChunk.length > 100)) / 2);
    checks.push({
      id: "bluf_style",
      label: "BLUF / 직답형 스타일",
      category: "content",
      pass: blufScore >= 0.5,
      value: `${Math.round(blufScore * 100)}%`,
      detail: hasDirectAnswer
        ? "콘텐츠가 직답으로 시작합니다 \u2014 AI 인용에 유리합니다."
        : "콘텐츠가 명확한 직답으로 시작하지 않습니다. BLUF(Bottom Line Up Front, 결론 먼저) 형식으로 작성하세요.",
    });

    // 11. Heading Hierarchy
    const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
    const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
    const h3Count = (html.match(/<h3[\s>]/gi) ?? []).length;
    const headingOk = h1Count === 1 && h2Count >= 2;
    checks.push({
      id: "heading_hierarchy",
      label: "제목 계층 구조",
      category: "content",
      pass: headingOk,
      value: `H1:${h1Count} H2:${h2Count} H3:${h3Count}`,
      detail: h1Count === 0
        ? "H1 태그가 없습니다. 모든 페이지에는 반드시 하나의 H1이 있어야 합니다."
        : h1Count > 1
          ? `H1 태그가 ${h1Count}개 \u2014 정확히 하나만 사용하세요. AI 모델은 H1을 주제 신호로 사용합니다.`
          : h2Count < 2
            ? "H2가 1개 이하입니다. H2 소제목으로 콘텐츠를 훑어보기 쉬운 섹션으로 나누세요."
            : "좋은 제목 구조입니다 \u2014 단일 H1과 여러 H2/H3 소제목.",
    });

    // 12. Content Length
    const wordCount = plain.split(/\s+/).filter(Boolean).length;
    const contentLengthOk = wordCount >= 300;
    checks.push({
      id: "content_length",
      label: "콘텐츠 깊이",
      category: "content",
      pass: contentLengthOk,
      value: `${wordCount.toLocaleString()}개 단어`,
      detail: contentLengthOk
        ? wordCount > 2000
          ? "풍부한 콘텐츠 \u2014 심층 AI 인용에 유리합니다."
          : "AI 답변 추출에 적절한 콘텐츠 길이입니다."
        : "콘텐츠가 빈약합니다 \u2014 AI 모델은 인용 대상으로 300단어 이상의 페이지를 선호합니다. 내용을 더 보강하세요.",
    });

    // 13. Internal Links
    const internalLinkPattern = new RegExp(`<a[^>]*href=["'](?:https?://(?:www\\.)?${target.hostname.replace(/\./g, "\\.")})?/[^"']*["']`, "gi");
    const internalLinks = (html.match(internalLinkPattern) ?? []).length;
    const internalLinkOk = internalLinks >= 3;
    checks.push({
      id: "internal_links",
      label: "내부 링크",
      category: "content",
      pass: internalLinkOk,
      value: `${internalLinks}개 링크`,
      detail: internalLinkOk
        ? "내부 링크가 잘 구성되어 있습니다 \u2014 AI 모델이 관련 콘텐츠를 발견하는 데 도움이 됩니다."
        : "내부 링크가 적습니다. 문맥에 맞는 내부 링크를 3개 이상 추가하여 AI 모델이 콘텐츠를 연결하도록 도우세요.",
    });

    // ═══════════════════════════════════════════════════
    // CATEGORY: TECHNICAL
    // ═══════════════════════════════════════════════════

    // 14. HTTPS
    const isHttps = target.protocol === "https:";
    checks.push({
      id: "https",
      label: "HTTPS",
      category: "technical",
      pass: isHttps,
      value: isHttps ? "적용" : "미적용",
      detail: isHttps ? "사이트가 HTTPS를 사용합니다 \u2014 신뢰 신호에 필수적입니다." : "사이트가 HTTPS를 사용하지 않습니다. 신뢰도와 AI 인용 가능성이 떨어집니다.",
    });

    // 15. Page Size
    const pageSizeKb = Math.round(html.length / 1024);
    const pageSizeOk = pageSizeKb < 500;
    checks.push({
      id: "page_size",
      label: "페이지 크기",
      category: "technical",
      pass: pageSizeOk,
      value: `${pageSizeKb} KB`,
      detail: pageSizeOk
        ? "페이지 크기가 빠른 로딩에 적절합니다."
        : "페이지가 큽니다 (500KB 초과). 무거운 페이지는 AI 크롤러가 타임아웃될 수 있습니다.",
    });

    // 16. Language Tag
    const langMatch = html.match(/<html[^>]*lang=["']([^"']+)["']/i);
    const hasLang = !!langMatch;
    checks.push({
      id: "lang_tag",
      label: "언어 속성",
      category: "technical",
      pass: hasLang,
      value: hasLang ? langMatch![1] : "없음",
      detail: hasLang
        ? `언어가 "${langMatch![1]}" 로 설정됨 \u2014 AI 모델이 올바른 언어로 결과를 제공하는 데 도움이 됩니다.`
        : '<html> 에 lang 속성이 없습니다. AI 지역화를 위해 lang="ko" (또는 해당 언어)를 추가하세요.',
    });

    // ═══════════════════════════════════════════════════
    // CATEGORY: RENDERING (SSR)
    // LLM bots cannot execute JavaScript — if a page
    // relies on client-side rendering, bots see a blank page.
    // ═══════════════════════════════════════════════════

    // 17. Client-Side Rendering Detection
    // Check if the page has very little text relative to HTML size,
    // combined with signals of JS frameworks that render client-side.
    const csrFrameworkSignals = [
      { name: "React CSR", pattern: /<div\s+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i },
      { name: "Vue CSR", pattern: /<div\s+id=["'](app|__vue_app__)["'][^>]*>\s*<\/div>/i },
      { name: "Angular", pattern: /<app-root[^>]*>\s*<\/app-root>/i },
      { name: "Svelte", pattern: /<div\s+id=["']svelte["'][^>]*>\s*<\/div>/i },
    ];
    const detectedCsrFrameworks = csrFrameworkSignals.filter((s) => s.pattern.test(html)).map((s) => s.name);
    // A page with SSR should have substantial text content even without JS
    const textToHtmlRatio = plain.length / Math.max(html.length, 1);
    const hasMinimalContent = plain.length < 200 && html.length > 2000;
    const likelyCsr = detectedCsrFrameworks.length > 0 && (hasMinimalContent || textToHtmlRatio < 0.02);
    // Also check for __NEXT_DATA__ (Next.js SSR marker) or data-reactroot (React SSR)
    const hasNextData = /__NEXT_DATA__/i.test(html);
    const hasReactRoot = /data-reactroot/i.test(html);
    const hasSsrMarkers = hasNextData || hasReactRoot;
    const csrCheckPass = !likelyCsr || hasSsrMarkers;
    checks.push({
      id: "csr_detection",
      label: "클라이언트 렌더링 (CSR) 감지",
      category: "rendering",
      pass: csrCheckPass,
      value: likelyCsr
        ? hasSsrMarkers
          ? "CSR 감지됨, SSR 마커 존재"
          : `CSR 가능성 높음 (${detectedCsrFrameworks.join(", ")})`
        : "서버 렌더링됨",
      detail: likelyCsr && !hasSsrMarkers
        ? `${detectedCsrFrameworks.join(", ")} 감지됨, 서버 렌더링 텍스트 최소 (${plain.length}자, 텍스트 비율 ${(textToHtmlRatio * 100).toFixed(1)}%). GPTBot, ClaudeBot, PerplexityBot 같은 LLM 봇은 JavaScript를 실행할 수 없어 빈 페이지로 보입니다. SSR 또는 SSG를 사용하세요.`
        : likelyCsr && hasSsrMarkers
          ? `프레임워크 감지됨 (${detectedCsrFrameworks.join(", ")}), SSR 마커 발견 (${[hasNextData && "__NEXT_DATA__", hasReactRoot && "data-reactroot"].filter(Boolean).join(", ")}). 콘텐츠가 서버에서 렌더링된 것으로 보입니다.`
          : `페이지 콘텐츠가 서버에서 렌더링됨 (텍스트 ${plain.length.toLocaleString()}자, 비율 ${(textToHtmlRatio * 100).toFixed(1)}%). LLM 봇이 콘텐츠를 읽을 수 있습니다.`,
    });

    // 18. Noscript Fallback
    const hasNoscript = /<noscript[\s>]/i.test(html);
    const noscriptContent = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/i)?.[1] ?? "";
    const noscriptHasContent = stripHtml(noscriptContent).length > 20;
    checks.push({
      id: "noscript_fallback",
      label: "Noscript 대체 콘텐츠",
      category: "rendering",
      pass: hasNoscript && noscriptHasContent,
      value: hasNoscript ? (noscriptHasContent ? "콘텐츠 있음" : "비어있음/빈약") : "없음",
      detail: hasNoscript && noscriptHasContent
        ? "양호 \u2014 <noscript> 태그에 의미 있는 대체 콘텐츠가 있습니다. JS를 실행하지 않는 봇도 컨텍스트를 얻을 수 있습니다."
        : hasNoscript
          ? "<noscript> 태그는 있으나 콘텐츠가 부족합니다. JS 미실행 환경을 위한 의미 있는 대체 메시지나 링크를 추가하세요."
          : "<noscript> 태그가 없습니다. 대체 콘텐츠와 함께 추가하세요 \u2014 JS를 실행하지 않는 LLM 봇과 크롤러에 도움이 됩니다.",
    });

    // 19. JavaScript Bundle Weight
    const scriptTags = html.match(/<script[^>]*src=["'][^"']+["'][^>]*>/gi) ?? [];
    const inlineScripts = html.match(/<script(?![^>]*src=)[\s\S]*?<\/script>/gi) ?? [];
    const totalInlineScriptSize = inlineScripts.reduce((sum, s) => sum + s.length, 0);
    const externalScriptCount = scriptTags.length;
    // Heuristic: more than 15 external scripts or massive inline JS suggests heavy client-side app
    const jsHeavy = externalScriptCount > 15 || totalInlineScriptSize > 100_000;
    checks.push({
      id: "js_bundle_weight",
      label: "JavaScript 용량",
      category: "rendering",
      pass: !jsHeavy,
      value: `외부 ${externalScriptCount}개, 인라인 ${Math.round(totalInlineScriptSize / 1024)}KB`,
      detail: jsHeavy
        ? `과도한 JS 감지됨: 외부 스크립트 ${externalScriptCount}개, 인라인 JS ${Math.round(totalInlineScriptSize / 1024)}KB. 무거운 JavaScript를 가진 페이지는 CSR에 의존할 가능성이 높습니다. LLM 봇이 타임아웃되거나 부분적인 콘텐츠만 볼 수 있습니다. JS를 줄이거나 SSR 도입을 검토하세요.`
        : `JS 용량 적정: 외부 스크립트 ${externalScriptCount}개, 인라인 ${Math.round(totalInlineScriptSize / 1024)}KB. LLM 봇 크롤링에 지장을 주지 않을 수준입니다.`,
    });

    // 20. Server-Rendered Content Quality
    // Even if a page passes CSR checks, we want to ensure the server-rendered HTML
    // contains enough meaningful content for bots to extract value from.
    const serverContentLen = plain.length;
    const hasSemanticHtml = /<(article|main|section)[\s>]/i.test(html);
    const hasDataAttributes = /data-(testid|cy|component)/i.test(html);
    const serverContentOk = serverContentLen > 500 && (hasSemanticHtml || !hasDataAttributes);
    checks.push({
      id: "server_content_quality",
      label: "서버 렌더링 콘텐츠 품질",
      category: "rendering",
      pass: serverContentOk,
      value: serverContentOk ? `${serverContentLen.toLocaleString()}자` : `${serverContentLen}자에 불과`,
      detail: serverContentOk
        ? `서버 렌더링 HTML이 ${serverContentLen.toLocaleString()}자의 텍스트 콘텐츠를 포함${hasSemanticHtml ? "하며 시맨틱 HTML 요소(article/main/section)도 사용되었습니다" : "합니다"}. LLM 봇이 의미 있는 정보를 추출할 수 있습니다.`
        : serverContentLen <= 500
          ? `서버 렌더링 텍스트가 매우 적습니다 (${serverContentLen}자). LLM 봇은 JavaScript 없이 초기 HTML만 봅니다 \u2014 핵심 콘텐츠가 JS로 주입되지 않고 서버에서 렌더링되도록 하세요.`
          : "서버 렌더링 HTML에 시맨틱 구조가 부족합니다. <article>, <main>, <section> 요소를 사용하여 봇이 핵심 콘텐츠 영역을 식별하도록 도우세요.",
    });

    // ── Compute score ──────────────────────────────────
    const passed = checks.filter((c) => c.pass).length;
    const score = Math.round((passed / checks.length) * 100);

    // Legacy compat
    const schemaMentions = jsonLdBlocks.length + (html.match(/schema\.org/gi) ?? []).length;

    return NextResponse.json({
      url,
      score,
      checks,
      llmsTxtPresent: llmsReal,
      schemaMentions,
      blufDensity: blufScore,
      pass: {
        llmsTxt: llmsReal,
        schema: schemaMentions > 0,
        bluf: blufScore >= 0.5,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
