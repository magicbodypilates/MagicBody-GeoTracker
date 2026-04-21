import { NextResponse } from "next/server";
import { clearScrapeCache } from "@/lib/server/brightdata-scraper";

export async function POST() {
  const cleared = clearScrapeCache();
  return NextResponse.json({ ok: true, cleared });
}
