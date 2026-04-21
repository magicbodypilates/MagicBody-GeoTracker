import type {
  SerpResult,
  SerpOrganicResult,
  AiOverviewResult,
  AiOverviewSource,
} from "./sro-types";

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function emptyResult(keyword: string): SerpResult {
  return {
    keyword,
    totalResults: 0,
    organicResults: [],
    targetRank: null,
    topCompetitors: [],
  };
}

export async function fetchSerp(
  keyword: string,
  targetUrl: string
): Promise<SerpResult> {
  const apiKey = process.env.BRIGHT_DATA_KEY;
  const zone = process.env.BRIGHT_DATA_SERP_ZONE || "serp_n8n";

  if (!apiKey) {
    console.error("[SERP] Missing BRIGHT_DATA_KEY");
    return emptyResult(keyword);
  }

  const targetDomain = extractDomain(targetUrl);
  const encodedQuery = encodeURIComponent(keyword);
  const googleUrl = `https://www.google.com/search?q=${encodedQuery}&gl=us&brd_json=1`;

  try {
    const response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        zone,
        url: googleUrl,
        format: "json",
      }),
    });

    if (!response.ok) {
      console.error(`[SERP] API error: ${response.status} ${response.statusText}`);
      return emptyResult(keyword);
    }

    const data = await response.json();
    const body = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawOrganic: any[] = body?.organic ?? [];

    let targetRank: number | null = null;
    const organicResults: SerpOrganicResult[] = [];
    const topCompetitors: string[] = [];

    for (const item of rawOrganic) {
      const url = item.link ?? "";
      const domain = extractDomain(url);
      const position = item.rank ?? item.global_rank ?? organicResults.length + 1;
      const isTarget = domain === targetDomain;

      organicResults.push({
        position,
        url,
        domain,
        title: item.title ?? "",
        description: item.description ?? item.snippet ?? "",
        isTarget,
      });

      if (isTarget && targetRank === null) {
        targetRank = position;
      }

      if (!isTarget && topCompetitors.length < 5) {
        topCompetitors.push(url);
      }
    }

    return {
      keyword,
      totalResults: organicResults.length,
      organicResults,
      targetRank,
      topCompetitors,
    };
  } catch (error) {
    console.error("[SERP] Fetch failed:", error);
    return emptyResult(keyword);
  }
}

// ─── AI Overview scraping ────────────────────────────────────────────────

export interface AiOverviewOptions {
  /** 브랜드 공식 도메인들 (인용 판정용) */
  brandDomains: string[];
  /** 브랜드명/별칭 (답변 텍스트 멘션 판정용) */
  brandAliases: string[];
  /** 경쟁사명 (멘션 감지용) */
  competitors?: string[];
  /** 조회 국가 — 기본 kr */
  country?: string;
  /** 조회 언어 — 기본 ko */
  hl?: string;
}

function normalizeAlias(s: string): string {
  return s.trim().toLowerCase();
}

function emptyAiOverview(keyword: string, country: string): AiOverviewResult {
  return {
    keyword,
    exists: false,
    text: "",
    sources: [],
    brandMentioned: false,
    brandCited: false,
    competitorsMentioned: [],
    country,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Bright Data Google SERP에서 AI Overview 블록을 추출하고 브랜드 멘션/인용 여부 판정.
 * 응답 스키마는 Bright Data가 실제로 반환하는 필드명을 방어적으로 파싱한다.
 */
export async function fetchAiOverview(
  keyword: string,
  options: AiOverviewOptions
): Promise<AiOverviewResult> {
  const apiKey = process.env.BRIGHT_DATA_KEY;
  const zone = process.env.BRIGHT_DATA_SERP_ZONE || "serp_n8n";
  const country = options.country || "kr";
  const hl = options.hl || "ko";

  if (!apiKey) {
    console.error("[AI-OVERVIEW] Missing BRIGHT_DATA_KEY");
    return {
      ...emptyAiOverview(keyword, country),
      error: "BRIGHT_DATA_KEY가 설정되지 않았습니다 (.env.local).",
    };
  }

  const encodedQuery = encodeURIComponent(keyword);
  const googleUrl = `https://www.google.com/search?q=${encodedQuery}&gl=${country}&hl=${hl}&brd_json=1`;

  try {
    const response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ zone, url: googleUrl, format: "json" }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`[AI-OVERVIEW] API error: ${response.status} ${response.statusText}`);
      return {
        ...emptyAiOverview(keyword, country),
        error: `Bright Data API 오류 ${response.status} ${response.statusText}. Zone=${zone}. ${errText.slice(0, 300)}`,
      };
    }

    const data = await response.json();
    const body = typeof data.body === "string" ? JSON.parse(data.body) : data.body;

    // Bright Data는 AI Overview를 다양한 필드명으로 담을 수 있음. 여러 후보 필드 검사.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ai: any =
      body?.ai_overview ??
      body?.ai_overviews ??
      body?.answer_box ??
      body?.knowledge ??
      body?.generative_ai ??
      null;

    const bodyKeys = body && typeof body === "object" ? Object.keys(body).slice(0, 40) : [];
    const rawPreview = JSON.stringify(
      {
        topLevelKeys: bodyKeys,
        organicCount: Array.isArray(body?.organic) ? body.organic.length : 0,
        answerBoxPresent: Boolean(body?.answer_box),
        aiOverviewPresent: Boolean(body?.ai_overview ?? body?.ai_overviews),
        sample: typeof body === "object" ? JSON.stringify(body).slice(0, 2000) : String(body).slice(0, 2000),
      },
      null,
      2,
    );

    if (!ai) {
      return {
        ...emptyAiOverview(keyword, country),
        rawPreview,
        error:
          "Bright Data 응답에 AI Overview 관련 필드(ai_overview / ai_overviews / answer_box / knowledge / generative_ai)가 없습니다. Google이 해당 키워드에 AI Overview를 생성하지 않았거나, 지역(gl=" +
          country +
          ") · 언어(hl=" +
          hl +
          ") 조합에서 노출되지 않았을 수 있습니다.",
      };
    }

    const text: string = String(
      ai.text ?? ai.answer ?? ai.description ?? ai.snippet ?? ""
    ).trim();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSources: any[] = ai.sources ?? ai.citations ?? ai.references ?? ai.links ?? [];

    const brandDomainSet = new Set(
      options.brandDomains
        .map((d) => extractDomain(d))
        .filter((d) => d.length > 0)
    );

    const sources: AiOverviewSource[] = rawSources.map((item) => {
      const url = item.url ?? item.link ?? "";
      const domain = extractDomain(url);
      return {
        url,
        domain,
        title: item.title ?? item.name ?? "",
        snippet: item.snippet ?? item.description ?? item.text ?? "",
        isBrand: brandDomainSet.has(domain),
      };
    });

    const textLower = text.toLowerCase();
    const brandAliasesLower = options.brandAliases
      .map(normalizeAlias)
      .filter((a) => a.length > 0);
    const brandMentioned =
      brandAliasesLower.some((a) => textLower.includes(a)) ||
      sources.some((s) => s.isBrand);

    const brandCited = sources.some((s) => s.isBrand);

    const competitorsMentioned = (options.competitors ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .filter((c) => textLower.includes(c.toLowerCase()));

    const exists = text.length > 0 || sources.length > 0;
    return {
      keyword,
      exists,
      text,
      sources,
      brandMentioned,
      brandCited,
      competitorsMentioned,
      country,
      fetchedAt: new Date().toISOString(),
      ...(exists
        ? {}
        : {
            rawPreview,
            error:
              "AI Overview 필드는 감지됐으나 text/sources가 비어있습니다. Bright Data 스키마가 변경됐을 가능성.",
          }),
    };
  } catch (error) {
    console.error("[AI-OVERVIEW] Fetch failed:", error);
    return {
      ...emptyAiOverview(keyword, country),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
