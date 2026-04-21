/**
 * POST /geo-tracker/api/auth/cms-session
 *
 * 일반관리자 경로 진입용 세션 발급 엔드포인트.
 * 흐름:
 *   1. 클라이언트가 CMS Firebase 로그인 상태에서 ID 토큰을 첨부해 호출
 *   2. 서버에서 Firebase Admin SDK로 토큰 검증 → uid 추출
 *   3. CMS API `GetAdminInfo/{uid}` 로 role 조회
 *   4. role === 0 (최고관리자)면 거부 — 최고관리자는 별도 경로(/admin)를 사용해야 함
 *   5. role > 0 이면 서명된 세션 쿠키 발급
 *
 * 개발 편의: `DEV_AUTH_BYPASS=true` 면 토큰 검증·role 조회를 생략하고 임의 role=1 로 처리.
 */

import { NextResponse } from "next/server";
import { verifyIdToken, isAdminSdkAvailable } from "@/lib/server/firebase-admin";
import { getAdminInfoByUid } from "@/lib/server/cms-api";
import {
  signUserSession,
  buildSessionCookie,
  USER_SESSION_COOKIE,
  USER_COOKIE_PATH,
} from "@/lib/server/session";

const DEV_BYPASS = process.env.DEV_AUTH_BYPASS === "true";

export async function POST(req: Request) {
  let body: { idToken?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const idToken = body.idToken?.trim();
  if (!idToken && !DEV_BYPASS) {
    return NextResponse.json({ error: "missing_id_token" }, { status: 400 });
  }

  // 1) ID 토큰 검증 (개발 우회 모드에선 생략)
  let uid: string;
  let email: string | undefined;
  let name: string | undefined;

  if (DEV_BYPASS) {
    uid = "dev-bypass-uid";
    email = "dev@local";
    name = "Dev User";
  } else {
    if (!isAdminSdkAvailable()) {
      return NextResponse.json(
        { error: "firebase_project_not_configured", hint: "FIREBASE_PROJECT_ID 환경변수 설정 필요" },
        { status: 500 },
      );
    }
    const verified = await verifyIdToken(idToken!);
    if (!verified) {
      return NextResponse.json({ error: "invalid_id_token" }, { status: 401 });
    }
    uid = verified.uid;
    email = verified.email;
    name = verified.name;
  }

  // 2) CMS API로 role 조회 (개발 우회 모드에선 role=1 고정)
  let role: number;
  if (DEV_BYPASS) {
    role = 1;
  } else {
    const info = await getAdminInfoByUid(uid);
    if (!info) {
      return NextResponse.json(
        { error: "admin_info_not_found", hint: "CMS에 등록되지 않은 계정" },
        { status: 403 },
      );
    }
    role = info.role;
    email = email ?? info.email;
    name = name ?? info.name;
  }

  // 3) 최고관리자는 이 경로로 들어올 수 없음 → 별도 URL 안내
  if (role === 0) {
    return NextResponse.json(
      {
        error: "super_admin_use_admin_path",
        hint: "최고관리자는 /geo-tracker/admin 으로 접속",
      },
      { status: 403 },
    );
  }

  if (role < 1) {
    return NextResponse.json({ error: "invalid_role" }, { status: 403 });
  }

  // 4) 세션 쿠키 발급
  const token = await signUserSession({ uid, role, email, name });
  const cookie = buildSessionCookie(USER_SESSION_COOKIE, token, USER_COOKIE_PATH);

  const res = NextResponse.json({ ok: true, role, name });
  res.headers.append("Set-Cookie", cookie);
  return res;
}
