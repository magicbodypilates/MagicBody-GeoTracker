import { cookies } from "next/headers";
import { SovereignDashboard } from "@/components/sovereign-dashboard";
import { AuthProvider, type AuthInfo } from "@/components/auth/auth-context";
import { USER_SESSION_COOKIE, verifyUserSession } from "@/lib/server/session";

const isDemoOnly = (process.env.NEXT_PUBLIC_DEMO_ONLY ?? "").trim().toLowerCase() === "true";

export default async function Home() {
  const jar = await cookies();
  const raw = jar.get(USER_SESSION_COOKIE)?.value;
  const payload = await verifyUserSession(raw);

  const auth: AuthInfo = payload
    ? {
        role: payload.role,
        uid: payload.uid,
        name: payload.name,
        email: payload.email,
        kind: "user",
      }
    : { role: -1, kind: "user" };

  return (
    <AuthProvider value={auth}>
      <SovereignDashboard demoMode={isDemoOnly} />
    </AuthProvider>
  );
}
