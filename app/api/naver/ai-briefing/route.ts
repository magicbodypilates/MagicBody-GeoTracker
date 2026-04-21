import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchNaverAiBriefing } from "@/lib/server/naver-scraper";

const Input = z.object({
  keyword: z.string().min(1),
  brandDomains: z.array(z.string()).default([]),
  brandAliases: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = Input.parse(body);
    const result = await fetchNaverAiBriefing(parsed.keyword, {
      brandDomains: parsed.brandDomains,
      brandAliases: parsed.brandAliases,
      competitors: parsed.competitors,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
