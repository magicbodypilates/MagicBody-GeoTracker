/**
 * POST /geo-tracker/api/auth/logout
 * - kind=user (기본): 일반관리자 세션 쿠키 삭제 → CMS 로그인 페이지로 이동하도록 클라이언트가 후속 처리
 * - kind=admin: 최고관리자 세션 쿠키 삭제 → /geo-tracker/admin/login 으로 이동
 */

import { NextResponse } from "next/server";
import {
  buildClearCookie,
  USER_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE,
  USER_COOKIE_PATH,
  ADMIN_COOKIE_PATH,
} from "@/lib/server/session";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") === "admin" ? "admin" : "user";

  const res = NextResponse.json({ ok: true, kind });
  if (kind === "admin") {
    res.headers.append("Set-Cookie", buildClearCookie(ADMIN_SESSION_COOKIE, ADMIN_COOKIE_PATH));
  } else {
    res.headers.append("Set-Cookie", buildClearCookie(USER_SESSION_COOKIE, USER_COOKIE_PATH));
  }
  return res;
}
