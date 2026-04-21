/**
 * 세션 쿠키 서명/검증 (HS256 JWT via `jose`).
 *
 * 두 종류의 세션:
 * - geo_user_session: CMS Firebase 로그인 검증 후 발급. {uid, role, email?, name?}
 * - geo_admin_session: 최고관리자 자체 로그인 후 발급. {role: 0}
 *
 * 쿠키 경로(Path)는 basePath(`/geo-tracker`)를 포함해 브라우저가 해당 경로에서만 전송하도록 한다.
 * 최고관리자 쿠키는 `/geo-tracker/admin` 범위로 제한해 일반 경로에 유출되지 않게 한다.
 */

import { SignJWT, jwtVerify } from "jose";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "/geo-tracker";

export const USER_SESSION_COOKIE = "geo_user_session";
export const ADMIN_SESSION_COOKIE = "geo_admin_session";

// 두 쿠키 모두 basePath 전체에서 유효 — API 경로(/geo-tracker/api/*)에도 전송되도록
// 최고관리자 쿠키는 내용(kind: "admin") 으로 식별되므로 path 제한 없이 안전.
// middleware 가 /admin(/*) 접근 시 geo_admin_session 필수 여부를 검사.
export const USER_COOKIE_PATH = BASE_PATH || "/";
export const ADMIN_COOKIE_PATH = BASE_PATH || "/";

const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12시간

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "SESSION_SECRET 환경변수가 없거나 너무 짧음 (32자 이상 필요). `.env.local` 확인.",
    );
  }
  return new TextEncoder().encode(raw);
}

export type UserSessionPayload = {
  uid: string;
  role: number;
  email?: string;
  name?: string;
};

export type AdminSessionPayload = {
  role: 0;
};

export async function signUserSession(
  payload: UserSessionPayload,
  ttlSec = DEFAULT_TTL_SECONDS,
): Promise<string> {
  return await new SignJWT({ ...payload, kind: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(getSecret());
}

export async function signAdminSession(
  ttlSec = DEFAULT_TTL_SECONDS,
): Promise<string> {
  return await new SignJWT({ role: 0, kind: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(getSecret());
}

export async function verifyUserSession(
  token: string | undefined,
): Promise<UserSessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.kind !== "user" || typeof payload.uid !== "string") return null;
    return {
      uid: payload.uid as string,
      role: Number(payload.role ?? -1),
      email: payload.email as string | undefined,
      name: payload.name as string | undefined,
    };
  } catch {
    return null;
  }
}

export async function verifyAdminSession(
  token: string | undefined,
): Promise<AdminSessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.kind !== "admin") return null;
    return { role: 0 };
  } catch {
    return null;
  }
}

/** Set-Cookie 헤더 값 빌더 */
export function buildSessionCookie(
  name: string,
  value: string,
  path: string,
  maxAgeSec = DEFAULT_TTL_SECONDS,
): string {
  const attrs = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

export function buildClearCookie(name: string, path: string): string {
  const attrs = [
    `${name}=`,
    `Path=${path}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}
