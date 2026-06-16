import { NextResponse } from "next/server";
import { isAuthed, gscConfigStatus } from "@/lib/server/gsc-client";
import { getDefaultPropertyId } from "@/lib/server/ga4-client";

export async function GET() {
  const authed = await isAuthed();
  const propertyId = getDefaultPropertyId();
  // HIGH-7/AD-5: GA4도 동일 OAuth/토큰 파일을 공유하므로 같은 설정 진단을 노출.
  // gscConfigStatus는 boolean/경로/경고만 반환 — 토큰 '값'은 절대 노출하지 않음.
  const config = await gscConfigStatus();
  return NextResponse.json({ authed, propertyId, config });
}
