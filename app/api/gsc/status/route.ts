import { NextResponse } from "next/server";
import { isAuthed, getSavedSiteUrl } from "@/lib/server/gsc-client";

export async function GET() {
  const authed = await isAuthed();
  const siteUrl = authed ? await getSavedSiteUrl() : null;
  return NextResponse.json({ authed, siteUrl });
}
