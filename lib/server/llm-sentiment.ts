/**
 * LLM 기반 brand sentiment + ranking signal 분류기.
 *
 * 반환 필드:
 *   - sentiment: "positive" | "neutral" | "negative"
 *   - isTopRanked: 응답이 brand 를 명시적 1위로 콕 집어 추천 (일반 검색 보너스 트리거)
 *   - isStronglyRecommended: 응답이 brand 를 강한 추천 어조로 권유 (brand 명 검색 보너스 트리거)
 *
 * Provider 선택:
 *   LLM_PROVIDER=openrouter → OpenRouter 통한 Claude (OPENROUTER_KEY 재활용, prompt caching 지원)
 *   LLM_PROVIDER=claude     → Anthropic 직접 (claude-haiku-4-5, 비용 최저)
 *   LLM_PROVIDER=openai (기본) → OpenAI gpt-4o-mini
 *
 * 환경변수:
 *   - LLM_PROVIDER          (선택, 기본 "openai")
 *   - ANTHROPIC_API_KEY     (provider=claude 시 필수)
 *   - ANTHROPIC_API_MODEL   (선택, 기본 "claude-haiku-4-5-20251001")
 *   - OPENROUTER_KEY        (provider=openrouter 시 필수)
 *   - OPENROUTER_MODEL      (선택, 기본 "anthropic/claude-haiku-4.5")
 *   - OPENAI_API_KEY        (provider=openai 시 필수)
 *   - OPENAI_API_URL / OPENAI_API_MODEL (선택)
 *
 * 타임아웃 8초 — 실패 시 null 반환 → 호출자가 키워드 휴리스틱으로 폴백.
 */

import Anthropic from "@anthropic-ai/sdk";

export type LlmSentiment = "positive" | "neutral" | "negative";

export type LlmClassification = {
  sentiment: LlmSentiment;
  isTopRanked: boolean;
  isStronglyRecommended: boolean;
};

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const OPENAI_API_URL = process.env.OPENAI_API_URL ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_API_MODEL || "gpt-4o-mini";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_API_MODEL || "claude-haiku-4-5-20251001";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";
const TIMEOUT_MS = 8_000;

export async function classifySentiment(params: {
  answerText: string;
  brandName: string;
  brandAliases?: string[];
}): Promise<LlmClassification | null> {
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
true ONLY if the recommendation phrase is DIRECTLY about the TARGET brand.
The recommendation must be syntactically attached to the target brand name.

Verify both conditions:
  (a) Strong recommendation language exists near the target brand:
      한국어: "강력 추천", "꼭 추천", "적극 추천", "권유합니다", "가장 좋은 선택"
      English: "highly recommend", "strongly recommend", "definitely worth", "absolute best"
  (b) The phrase's grammatical SUBJECT/OBJECT is the target brand
      (not a different brand, not the question, not the user's situation in general)

CRITICAL false positive examples to AVOID:
  - "스탓이나 폴스타를 추천합니다" — recommends STOTT/Polestar, NOT the target brand → false
  - "대표 기관: 모던, 케어, 매직바디 등" — listing only, no recommendation → false
  - "응답 전체가 추천 어조" but target brand only appears as one of many examples → false

Only mark true when target brand is the explicit object of recommendation.
A mild positive description ("우수한 협회", "좋은 옵션") alone is NOT strong recommendation.

If both isTopRanked and isStronglyRecommended apply, output both as true.`;

  const userPrompt = `Brand: ${brandRef}

Answer:
"""
${truncated}
"""

Respond with JSON: {"sentiment":"positive"|"neutral"|"negative","isTopRanked":boolean,"isStronglyRecommended":boolean}`;

  // Provider 분기
  if (LLM_PROVIDER === "openrouter") {
    return classifyWithOpenRouter(systemPrompt, userPrompt);
  }
  if (LLM_PROVIDER === "claude") {
    return classifyWithClaude(systemPrompt, userPrompt);
  }
  return classifyWithOpenAI(systemPrompt, userPrompt);
}

function parseClassification(content: string): LlmClassification | null {
  try {
    // Claude 응답엔 가끔 ```json ... ``` 블록이 섞일 수 있어 정리
    const cleaned = content
      .replace(/```json\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    // 첫 번째 { ... } 블록 추출
    const match = cleaned.match(/\{[\s\S]*?\}/);
    const jsonStr = match ? match[0] : cleaned;
    const parsed = JSON.parse(jsonStr) as {
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
  } catch {
    return null;
  }
}

async function classifyWithOpenAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmClassification | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

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
      console.warn(`[llm-sentiment][openai] HTTP ${res.status} — 폴백`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseClassification(content);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("[llm-sentiment][openai] 타임아웃 — 폴백");
    } else {
      console.warn("[llm-sentiment][openai] 실패:", err instanceof Error ? err.message : err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * OpenRouter 통한 Claude 호출 — OpenAI 호환 /chat/completions 사용.
 * Anthropic prompt caching: system 메시지를 content array 로 보내면서 cache_control: ephemeral 적용.
 * 응답의 usage.cache_read_input_tokens / usage.cache_creation_input_tokens 로 캐시 동작 검증.
 */
async function classifyWithOpenRouter(
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmClassification | null> {
  const apiKey = process.env.OPENROUTER_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // OpenRouter 추천 헤더 — 사용량 통계/모델 라우팅에 활용
        "HTTP-Referer": "https://cms.magicbodypilates.co.kr/geo-tracker",
        "X-Title": "MagicBody GeoTracker",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0,
        max_tokens: 100,
        // Anthropic prompt caching — system content array + cache_control: ephemeral.
        // OpenRouter 가 Anthropic 으로 패스스루하면서 캐시 적용.
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[llm-sentiment][openrouter] HTTP ${res.status} — ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    // 캐시 히트 검증 로그 — Anthropic 패스스루 필드 또는 OpenAI 호환 필드 모두 확인
    const u = data.usage ?? {};
    const cacheRead =
      u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    if (cacheRead > 0 || cacheCreate > 0) {
      console.log(
        `[llm-sentiment][openrouter] cache: read=${cacheRead} create=${cacheCreate} prompt=${u.prompt_tokens ?? "?"} comp=${u.completion_tokens ?? "?"}`,
      );
    } else {
      console.log(
        `[llm-sentiment][openrouter] no-cache: prompt=${u.prompt_tokens ?? "?"} comp=${u.completion_tokens ?? "?"}`,
      );
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseClassification(content);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("[llm-sentiment][openrouter] 타임아웃 — 폴백");
    } else {
      console.warn(
        "[llm-sentiment][openrouter] 실패:",
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyWithClaude(
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmClassification | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS });

  try {
    // prompt caching: 시스템 프롬프트는 매 요청 동일 → cache_control 로 90% 비용 절감.
    // 다건 분류 시 system prompt 만 한 번 캐시에 올라가고 나머지는 재사용.
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 100,
      temperature: 0,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });

    const block = response.content[0];
    if (!block || block.type !== "text") return null;
    return parseClassification(block.text);
  } catch (err) {
    console.warn(
      "[llm-sentiment][claude] 실패:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
