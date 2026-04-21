import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runAiScraper } from "@/lib/server/brightdata-scraper";

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
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = InputSchema.parse(body);
    const result = await runAiScraper(parsed);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[/api/scrape] failed:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
