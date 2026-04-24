/**
 * POST /geo-tracker/api/auth/cms-session
 *
 * CMS 경유 진입용 세션 발급 엔드포인트.
 *
 * 경로 분리 원칙:
 *   - /geo-tracker (이 경로)        = 항상 "일반관리자 UI" (12개 탭, 워크스페이스 스위처 숨김)
 *   - /geo-tracker/admin (별도 경로) = 최고관리자 전용 테스트 UI (전체 18개 탭)
 *
 * CMS 계정이 최고관리자(CMS role === 0)라도 이 경로에서는 일반관리자 UI 를 보여줌.
 * 최고관리자 전용 기능이 필요하면 /geo-tracker/admin 으로 별도 로그인 필요.
 *
 * 흐름:
 *   1. 클라이언트가 CMS Firebase 로그인 상태에서 ID 토큰을 첨부해 호출
 *   2. 서버에서 Firebase Admin SDK로 토큰 검증 → uid 추출
 *   3. CMS API `GetAdminInfo/{uid}` 로 role 조회
 *   4. 세션 쿠키에는 항상 role=1 (일반관리자) 로 강제 저장 — 경로 분리 원칙 준수
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

  // 3) role 유효성 검증 — CMS 에 등록된 계정(0 이상)이면 허용
  if (typeof role !== "number" || role < 0) {
    return NextResponse.json({ error: "invalid_role" }, { status: 403 });
  }

  // 4) 세션 쿠키 발급 — CMS 경유는 경로 분리 원칙에 따라 항상 role=1 (일반관리자 UI) 로 저장.
  //    CMS role === 0 (최고관리자) 계정이라도 /geo-tracker 에서는 일반관리자 화면을 보여줌.
  //    최고관리자 전용 기능은 /geo-tracker/admin 으로 별도 로그인해야 사용 가능.
  const effectiveRole = 1;
  const token = await signUserSession({ uid, role: effectiveRole, email, name });
  const cookie = buildSessionCookie(USER_SESSION_COOKIE, token, USER_COOKIE_PATH);

  const res = NextResponse.json({ ok: true, role: effectiveRole, cmsRole: role, name });
  res.headers.append("Set-Cookie", cookie);
  return res;
}
