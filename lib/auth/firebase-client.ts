/**
 * Firebase Web SDK 클라이언트 싱글톤 (일반관리자 경로 전용).
 *
 * CMS(`cms.magicbodypilates.co.kr`)에서 로그인한 사용자가 `/geo-tracker` 로 진입했을 때
 * 같은 브라우저의 Firebase Auth 세션을 그대로 감지하기 위해 사용한다.
 * CMS 프로젝트(`classnaom`)와 동일한 설정을 쓰므로 별도 로그인 불필요.
 */

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut, type Auth, type User } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (!app) {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  }
  if (!auth) auth = getAuth(app);
  return auth;
}

/** onAuthStateChanged 래퍼 — unsubscribe 함수를 반환 */
export function watchAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), cb);
}

export async function getIdToken(forceRefresh = false): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

export async function firebaseSignOut(): Promise<void> {
  try {
    await signOut(getFirebaseAuth());
  } catch {
    /* noop */
  }
}
