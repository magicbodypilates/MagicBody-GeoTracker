import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchAiOverview } from "@/lib/server/serp";

const Input = z.object({
  keyword: z.string().min(1),
  brandDomains: z.array(z.string()).default([]),
  brandAliases: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
  country: z.string().length(2).optional(),
  hl: z.string().min(2).max(5).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = Input.parse(body);
    const result = await fetchAiOverview(parsed.keyword, {
      brandDomains: parsed.brandDomains,
      brandAliases: parsed.brandAliases,
      competitors: parsed.competitors,
      country: parsed.country,
      hl: parsed.hl,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
