/**
 * POST /geo-tracker/api/auth/admin-session
 *
 * 최고관리자 자체 로그인 엔드포인트.
 * - 사용자명 없이 비밀번호만 대조 (`ADMIN_PASSWORD_HASH` 환경변수의 bcrypt 해시와 일치해야 통과)
 * - 성공 시 `/geo-tracker/admin` 경로 전용 세션 쿠키 발급
 * - 이 세션은 CMS 세션과 완전히 분리됨 — 최고관리자 경로는 항상 켜진 테스트 환경 역할
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  signAdminSession,
  buildSessionCookie,
  ADMIN_SESSION_COOKIE,
  ADMIN_COOKIE_PATH,
} from "@/lib/server/session";

// 매우 단순한 인메모리 레이트 리밋 (프로세스 재시작 시 초기화)
const failureLog = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10분

function getClientIp(req: Request): string {
  const h = (k: string) => req.headers.get(k) ?? "";
  return (
    h("x-forwarded-for").split(",")[0]?.trim() ||
    h("x-real-ip") ||
    "unknown"
  );
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = failureLog.get(ip);
  if (!entry || entry.resetAt < now) {
    return { allowed: true, remaining: MAX_FAILURES };
  }
  return { allowed: entry.count < MAX_FAILURES, remaining: MAX_FAILURES - entry.count };
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failureLog.get(ip);
  if (!entry || entry.resetAt < now) {
    failureLog.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailures(ip: string): void {
  failureLog.delete(ip);
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "too_many_attempts", hint: "10분 후 다시 시도" },
      { status: 429 },
    );
  }

  let body: { password?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const password = body.password?.trim();
  if (!password) {
    return NextResponse.json({ error: "missing_password" }, { status: 400 });
  }

  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (!hash) {
    return NextResponse.json(
      { error: "admin_not_configured", hint: "ADMIN_PASSWORD_HASH 미설정" },
      { status: 500 },
    );
  }

  const match = await bcrypt.compare(password, hash);
  if (!match) {
    recordFailure(ip);
    return NextResponse.json(
      { error: "invalid_password", remaining: Math.max(0, rate.remaining - 1) },
      { status: 401 },
    );
  }

  clearFailures(ip);

  const token = await signAdminSession();
  const cookie = buildSessionCookie(ADMIN_SESSION_COOKIE, token, ADMIN_COOKIE_PATH);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", cookie);
  return res;
}
