/**
 * Next.js Middleware — 경로별 인증 게이트.
 *
 * basePath 는 `/geo-tracker`. 미들웨어의 `pathname`은 basePath가 **제거된** 경로가 들어온다.
 * 예) 브라우저 URL `/geo-tracker/admin` → pathname `/admin`
 *
 * 분기 규칙:
 *   /login                  → 통과 (일반관리자 로그인 브릿지)
 *   /admin/login            → 통과 (최고관리자 로그인 폼)
 *   /admin(/*)              → geo_admin_session 쿠키 필요, 없으면 /admin/login
 *   /api/auth/**            → 통과 (인증 엔드포인트)
 *   /api/**                 → geo_user_session OR geo_admin_session 필요 (JSON 401)
 *   그 외 모든 페이지        → geo_user_session 필요, 없으면 /login
 */

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const USER_SESSION_COOKIE = "geo_user_session";
const ADMIN_SESSION_COOKIE = "geo_admin_session";
const BASE_PATH = "/geo-tracker";

let cachedSecret: Uint8Array | null = null;
function getSecret(): Uint8Array | null {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) return null;
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

async function verifyCookie(
  token: string | undefined,
  kind: "user" | "admin",
): Promise<boolean> {
  if (!token) return false;
  const secret = getSecret();
  if (!secret) return false;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.kind === kind;
  } catch {
    return false;
  }
}

function redirect(req: NextRequest, path: string) {
  const url = req.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  return NextResponse.redirect(url);
}

function redirectWithReturnTo(req: NextRequest, loginPath: string) {
  const url = req.nextUrl.clone();
  // basePath 가 적용된 원래 경로를 returnTo 로 저장
  const returnTo = `${BASE_PATH}${req.nextUrl.pathname}${req.nextUrl.search}`;
  url.pathname = loginPath;
  url.search = `?returnTo=${encodeURIComponent(returnTo)}`;
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1) 공개 경로 — 로그인 페이지 & 인증 엔드포인트
  if (
    pathname === "/login" ||
    pathname === "/admin/login" ||
    pathname.startsWith("/api/auth/")
  ) {
    return NextResponse.next();
  }

  const userCookie = req.cookies.get(USER_SESSION_COOKIE)?.value;
  const adminCookie = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;

  // 2) /admin(/*) — 최고관리자 전용
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const ok = await verifyCookie(adminCookie, "admin");
    if (ok) return NextResponse.next();

    // API 경로면 401 JSON, 페이지면 로그인으로 리다이렉트
    if (pathname.startsWith("/admin/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return redirectWithReturnTo(req, "/admin/login");
  }

  // 3) /api/** — 일반/최고관리자 둘 다 허용
  if (pathname.startsWith("/api/")) {
    const userOk = await verifyCookie(userCookie, "user");
    const adminOk = await verifyCookie(adminCookie, "admin");
    if (userOk || adminOk) return NextResponse.next();
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 4) 나머지 페이지 — 일반관리자 세션 필요
  const userOk = await verifyCookie(userCookie, "user");
  if (userOk) return NextResponse.next();
  return redirectWithReturnTo(req, "/login");
}

export const config = {
  matcher: [
    /*
     * 모든 경로에서 동작하되 아래는 제외:
     * - _next (Next.js 내부 자산)
     * - favicon.ico, robots.txt
     * - 파일 확장자를 가진 정적 자원 (.png, .svg 등)
     * 루트 경로("/")를 명시적으로 포함하기 위해 2개의 matcher를 병기.
     */
    "/",
    "/((?!_next/|favicon\\.ico|robots\\.txt|.*\\..*).*)",
  ],
};
