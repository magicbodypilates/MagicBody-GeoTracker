/**
 * Firebase Admin SDK 서버 싱글톤.
 *
 * 일반관리자 경로에서 클라이언트가 전달한 Firebase ID 토큰을 서버에서 검증하기 위해 사용.
 * `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` 환경변수가 비어 있으면 초기화 실패 → verifyIdToken()은 null 반환.
 * 개발 단계에선 `DEV_AUTH_BYPASS=true` 로 검증 자체를 생략할 수 있다.
 */

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";

let cachedApp: App | null | undefined = undefined;

function getAdminApp(): App | null {
  if (cachedApp !== undefined) return cachedApp;

  const raw = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    cachedApp = null;
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const existing = getApps().find((a) => a.name === "geo-admin");
    cachedApp = existing ?? initializeApp({ credential: cert(parsed) }, "geo-admin");
    return cachedApp;
  } catch (err) {
    console.error("[firebase-admin] 초기화 실패:", err);
    cachedApp = null;
    return null;
  }
}

export type VerifiedToken = {
  uid: string;
  email?: string;
  name?: string;
};

/**
 * ID 토큰 검증. 성공 시 uid/email/name 반환, 실패 시 null.
 * Admin SDK가 초기화되지 않았거나 `DEV_AUTH_BYPASS=true`면 null — 호출 측에서 별도 처리.
 */
export async function verifyIdToken(idToken: string): Promise<VerifiedToken | null> {
  const app = getAdminApp();
  if (!app) return null;

  try {
    const decoded = await getAdminAuth(app).verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
    };
  } catch (err) {
    console.error("[firebase-admin] verifyIdToken 실패:", err);
    return null;
  }
}

export function isAdminSdkAvailable(): boolean {
  return getAdminApp() !== null;
}
