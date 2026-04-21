/**
 * Role 기반 AuthContext.
 * 서버 컴포넌트에서 쿠키를 파싱해 role 을 결정하고 클라이언트 컴포넌트에 주입.
 *
 * role 의미:
 *   0  — 최고관리자 (/geo-tracker/admin 경로)
 *   >0 — 일반관리자 (CMS 세션 통해 진입)
 *   -1 — 비로그인/알 수 없음 (미들웨어가 차단하므로 실제로 이 값으로 들어올 일은 없음)
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";

export type AuthInfo = {
  role: number;
  uid?: string;
  name?: string;
  email?: string;
  /** "user" = CMS 경유 일반관리자, "admin" = 최고관리자 자체 로그인 */
  kind: "user" | "admin";
};

const AuthContext = createContext<AuthInfo | null>(null);

export function AuthProvider({
  value,
  children,
}: {
  value: AuthInfo;
  children: ReactNode;
}) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** null-safe getter — AuthProvider 바깥에서 호출해도 안전 (기본값 반환) */
export function useAuth(): AuthInfo {
  const ctx = useContext(AuthContext);
  return ctx ?? { role: -1, kind: "user" };
}

export function useIsSuperAdmin(): boolean {
  return useAuth().role === 0;
}
