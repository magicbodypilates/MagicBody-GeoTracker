import { NextResponse } from "next/server";
import {
  isAuthed,
  getSavedSiteUrl,
  gscConfigStatus,
} from "@/lib/server/gsc-client";

export async function GET() {
  const authed = await isAuthed();
  const siteUrl = authed ? await getSavedSiteUrl() : null;
  // HIGH-7/AD-5: GSC_TOKEN_FILE 미설정·토큰 부재를 status 탭(부팅 시 호출)에서 조기 감지.
  // gscConfigStatus는 boolean/경로/경고만 반환 — 토큰 '값'은 절대 노출하지 않음.
  const config = await gscConfigStatus();
  return NextResponse.json({ authed, siteUrl, config });
}
