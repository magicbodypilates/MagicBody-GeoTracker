import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/server/gsc-client";
import { getDefaultPropertyId } from "@/lib/server/ga4-client";

export async function GET() {
  const authed = await isAuthed();
  const propertyId = getDefaultPropertyId();
  return NextResponse.json({ authed, propertyId });
}
