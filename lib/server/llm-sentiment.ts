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

=== CRITICAL DECISION TREE — read in order ===

Step 1 — Is this a comparison list of multiple brands (3+)?
  Signs: numbered/bulleted list, multiple brand names with descriptions of similar length,
  headers like "주요 추천", "주요 교육기관", "추천 X 종", "Top N", "옵션 비교",
  pattern of "Brand A: ... / Brand B: ... / Brand C: ...".
  → If YES, go to Step 2.
  → If NO (single brand focus), go to Step 3.

Step 2 — In this comparison list, is the TARGET brand emphasized DIFFERENTLY than others?
  Differentiating signs:
    - Target brand has noticeably longer / more praising description than peers
    - Target brand is explicitly placed in #1 position with ranking phrase
    - Conclusion or final sentence singles out the target brand for recommendation
  → If YES (target uniquely emphasized) → "positive"
  → If NO (target gets factual description similar in length/tone to others, even if
    individual words like "체계적", "우수", "전문" appear in its description) → "neutral"

  IMPORTANT: In comparison lists, words like "체계적", "우수", "전문", "신뢰", "공인",
  "대표적", "정통", "풍부한" are USUALLY just shared descriptors applied to multiple brands,
  not unique praise. Default to "neutral" unless the target brand stands out.

Step 3 — Single-brand focus answer:
  - If brand receives evaluative/complimentary language (recommends, praises, highlights
    strengths, expert tone) → "positive"
  - If purely factual description (founding year, curriculum, basic info) → "neutral"
  - If criticism, warnings, drawbacks → "negative"

=== EXAMPLES ===

Example A (comparison list of 5 brands, target=매직바디, all described similarly):
Answer: "필라테스 강사 자격증 추천 교육기관: 1. 국제재활필라테스협회(매직바디): 2008년부터 운영된 대규모 교육기관, 재활 중심의 커리큘럼과 풍부한 강사 배출 이력. 매직바디 아카데미. 2. 모던필라테스: 호주의 의학 지식을 접목, 수준 높은 강사 양성. 3. 대한필라테스협회(KPA): 기구 필라테스 통합 교육 시스템. 4. STOTT: 전 세계적으로 인지도 높음. 5. NCPT: 가장 공신력 높은 국제 자격증."
Analysis: 5 brands listed with similar-length factual descriptions. Each has positive descriptors ("대규모", "수준 높은", "공신력 높은") but applied across the board. 매직바디 is not uniquely emphasized - it's just one of many. STOTT and NCPT actually get more praise ("가장 공신력 높은"). No #1 ranking phrase for 매직바디.
Output: {"sentiment":"neutral","isTopRanked":false,"isStronglyRecommended":false}

Example B (comparison list, target uniquely highlighted):
Answer: "필라테스 강사 자격증 추천: 1. 매직바디 (가장 추천): 국내 최고의 신뢰도와 가장 풍부한 커리큘럼. 2. KPIA: 일반적인 옵션. 3. STOTT: 해외 자격."
Analysis: 매직바디 is explicitly placed at #1 with "가장 추천" phrase and stronger praise than peers.
Output: {"sentiment":"positive","isTopRanked":true,"isStronglyRecommended":true}

Example C (single brand focus, evaluative tone):
Answer: "매직바디 자격증은 우수한 커리큘럼과 신뢰할 수 있는 자격으로 강력 추천드립니다."
Analysis: Whole answer focuses on 매직바디 with strong recommendation.
Output: {"sentiment":"positive","isTopRanked":false,"isStronglyRecommended":true}

Example D (single brand, factual only):
Answer: "매직바디는 2008년부터 운영된 필라테스 교육기관입니다. 재활 중심 커리큘럼을 제공합니다."
Output: {"sentiment":"neutral","isTopRanked":false,"isStronglyRecommended":false}

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
