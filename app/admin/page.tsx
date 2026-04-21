/**
 * 최고관리자 경로 (/geo-tracker/admin)
 * - middleware가 geo_admin_session 쿠키를 검증. 여기까지 오면 이미 통과.
 * - role=0 으로 AuthProvider 주입 → 대시보드의 모든 탭 노출.
 */

import { cookies } from "next/headers";
import { SovereignDashboard } from "@/components/sovereign-dashboard";
import { AuthProvider, type AuthInfo } from "@/components/auth/auth-context";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/server/session";

const isDemoOnly = (process.env.NEXT_PUBLIC_DEMO_ONLY ?? "").trim().toLowerCase() === "true";

export default async function AdminHome() {
  const jar = await cookies();
  const raw = jar.get(ADMIN_SESSION_COOKIE)?.value;
  const payload = await verifyAdminSession(raw);

  const auth: AuthInfo = payload
    ? { role: 0, kind: "admin" }
    : { role: -1, kind: "admin" };

  return (
    <AuthProvider value={auth}>
      <SovereignDashboard demoMode={isDemoOnly} />
    </AuthProvider>
  );
}
