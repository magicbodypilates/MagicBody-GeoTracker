/**
 * LLM 기반 브랜드 sentiment 분류기.
 *
 * OpenAI Chat Completions (JSON mode) 로 "positive | neutral | negative" 중 하나를 받아온다.
 * 단순 언급/인용은 neutral 로, 추천/우수/권장은 positive 로, 경고/비판/단점은 negative 로 판정.
 *
 * 실패 시 null 을 반환해 호출자가 키워드 휴리스틱으로 폴백할 수 있게 한다.
 * 타임아웃 5초 — Bright Data 응답 수집 파이프라인을 블로킹하지 않도록.
 *
 * 환경변수:
 *   - OPENAI_API_KEY      (필수. 없으면 항상 null)
 *   - OPENAI_API_URL      (선택, 기본 https://api.openai.com/v1)
 *   - OPENAI_API_MODEL    (선택, 기본 gpt-4o-mini)
 *
 * 향후 Claude Haiku 4.5 로 교체 시 이 파일 하나만 수정하면 됨.
 */

export type LlmSentiment = "positive" | "neutral" | "negative";

const OPENAI_API_URL = process.env.OPENAI_API_URL ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_API_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = 5_000;

export async function classifySentiment(params: {
  answerText: string;
  brandName: string;
  brandAliases?: string[];
}): Promise<LlmSentiment | null> {
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

  const systemPrompt =
    "You classify how an AI-generated answer treats a specific brand. " +
    "Output JSON only. Rules:\n" +
    '- "positive" = the answer recommends, praises, highlights strengths, or lists the brand as a top choice.\n' +
    '- "negative" = the answer warns against, criticizes, lists drawbacks, or discourages the brand.\n' +
    '- "neutral" = the answer only mentions or cites the brand without clear evaluation (mere mention, factual description, one of many options in a list, background info).\n' +
    "A plain mention or citation without evaluative language MUST be neutral, not positive.";

  const userPrompt = `Brand: ${brandRef}

Answer:
"""
${truncated}
"""

Respond with JSON: {"sentiment":"positive"|"neutral"|"negative"}`;

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
        max_tokens: 30,
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

    const parsed = JSON.parse(content) as { sentiment?: unknown };
    const s = parsed.sentiment;
    if (s === "positive" || s === "neutral" || s === "negative") return s;
    return null;
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
