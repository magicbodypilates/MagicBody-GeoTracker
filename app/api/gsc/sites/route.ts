import { NextRequest, NextResponse } from "next/server";
import { gscListSites, setSavedSiteUrl } from "@/lib/server/gsc-client";
import { z } from "zod";

export async function GET() {
  try {
    const sites = await gscListSites();
    return NextResponse.json({ sites });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

const Body = z.object({ siteUrl: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.parse(await req.json());
    await setSavedSiteUrl(parsed.siteUrl);
    return NextResponse.json({ ok: true, siteUrl: parsed.siteUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
