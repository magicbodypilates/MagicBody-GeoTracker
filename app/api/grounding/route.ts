import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { analyzeGrounding } from "@/lib/server/gemini-grounding";

const bodySchema = z.object({
  keyword: z.string().min(1),
  targetUrl: z.string().url(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = bodySchema.parse(await req.json());
    const result = await analyzeGrounding(parsed.keyword, parsed.targetUrl);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
