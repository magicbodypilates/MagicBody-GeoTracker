/**
 * LLM 기반 brand sentiment + ranking signal 분류기.
 *
 * 반환 필드:
 *   - sentiment: "positive" | "neutral" | "negative"
 *   - isTopRanked: 응답이 brand 를 명시적 1위로 콕 집어 추천 (일반 검색 보너스 트리거)
 *   - isStronglyRecommended: 응답이 brand 를 강한 추천 어조로 권유 (brand 명 검색 보너스 트리거)
 *
 * 환경변수: OPENAI_API_KEY, OPENAI_API_URL, OPENAI_API_MODEL
 * 타임아웃 5초 — 실패 시 null 반환 → 호출자가 키워드 휴리스틱으로 폴백.
 */

export type LlmSentiment = "positive" | "neutral" | "negative";

export type LlmClassification = {
  sentiment: LlmSentiment;
  isTopRanked: boolean;
  isStronglyRecommended: boolean;
};

const OPENAI_API_URL = process.env.OPENAI_API_URL ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_API_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = 5_000;

export async function classifySentiment(params: {
  answerText: string;
  brandName: string;
  brandAliases?: string[];
}): Promise<LlmClassification | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!params.answerText || params.answerText.trim().length < 20) return null;

  const brandLabels = [params.brandName, ...(params.brandAliases ?? [])]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .slice(0, 6);
  if (brandLabels.length === 0) return null;

  const brandRef = brandLabels.join(" / ");
  const truncated = params.answerText.slice(0, 4000);

  const systemPrompt = `You classify how an AI-generated answer treats a specific brand.
Output JSON with three fields: { "sentiment", "isTopRanked", "isStronglyRecommended" }

=== sentiment ===
"positive" — the answer uses evaluative, complimentary language toward the brand
  (e.g. "체계적", "우수", "전문적", "신뢰할 수 있는", "장점이 많은", "강점", "대표적", "정통",
   "well-regarded", "leading", "established", "respected", "comprehensive", "proven").

"neutral" — the answer only mentions the brand factually (mere mention, basic facts like
  founding year, curriculum description, one of many options listed in similar tone).
  IMPORTANT: If MULTIPLE brands are described in similar positive tone (each gets a list of
  strengths), the target brand counts as NEUTRAL — there is no differentiation.
  POSITIVE requires the target brand to be highlighted DIFFERENTLY than other brands listed.

"negative" — warns against, criticizes, lists drawbacks, or discourages.

=== isTopRanked (boolean) ===
true ONLY if the answer EXPLICITLY ranks this brand #1 or singles it out as THE top
recommendation among multiple options. Look for explicit comparative ranking phrases:
  - 한국어: "가장 적절", "가장 적합", "가장 합리적", "가장 추천", "최고",
    "1위", "1순위", "단연", "귀하 케이스에 적합", "이 분에게는 X 추천",
    "우선 추천", "이 중 X 가 가장 ~", "종합적으로 X 가 ~", "X 가 가장 좋은 선택"
  - English: "top pick", "#1 choice", "best fit", "most suitable",
    "the best option for", "would recommend X above all"

false if:
  - The brand is just one of several recommendations without explicit ranking
  - The answer is purely informational/factual
  - The answer is about a single brand (no comparison)

=== isStronglyRecommended (boolean) ===
true if the answer actively recommends/endorses the brand with strong recommendation
language, urging the reader to consider it. Independent of comparison context.
  - 한국어 예: "강력 추천", "꼭 추천", "적극 추천", "권유합니다", "가장 좋은 선택"
  - English 예: "highly recommend", "strongly recommend", "definitely worth", "absolute best"
A mild positive description ("우수한 협회", "좋은 옵션") alone is NOT strong recommendation.

If both isTopRanked and isStronglyRecommended apply, output both as true.`;

  const userPrompt = `Brand: ${brandRef}

Answer:
"""
${truncated}
"""

Respond with JSON: {"sentiment":"positive"|"neutral"|"negative","isTopRanked":boolean,"isStronglyRecommended":boolean}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[llm-sentiment] HTTP ${res.status} — 폴백`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      sentiment?: unknown;
      isTopRanked?: unknown;
      isStronglyRecommended?: unknown;
    };
    const s = parsed.sentiment;
    if (s !== "positive" && s !== "neutral" && s !== "negative") return null;

    return {
      sentiment: s,
      isTopRanked: parsed.isTopRanked === true,
      isStronglyRecommended: parsed.isStronglyRecommended === true,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("[llm-sentiment] 5초 타임아웃 — 폴백");
    } else {
      console.warn("[llm-sentiment] 실패:", err instanceof Error ? err.message : err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
