import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { countryOrDefault, runAiScraper } from "@/lib/server/brightdata-scraper";

const InputSchema = z.object({
  provider: z.enum([
    "chatgpt",
    "perplexity",
    "copilot",
    "gemini",
    "google_ai",
    "grok",
  ]),
  prompt: z.string().min(3),
  requireSources: z.boolean().optional(),
  country: z.string().optional(),
  forceRefresh: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = InputSchema.parse(body);
    // 화면의 수동 실행은 국가를 보내지 않는다 — 자동 수집과 같은 기본값(countryOrDefault — 없으면 KR)으로 맞춘다.
    // Perplexity 는 runAiScraper 안에서 국가가 빠진다(§ PERPLEXITY_NO_COUNTRY).
    const result = await runAiScraper({ ...parsed, country: countryOrDefault(parsed.country) });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[/api/scrape] failed:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
