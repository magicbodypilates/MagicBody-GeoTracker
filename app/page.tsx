import { SovereignDashboard } from "@/components/sovereign-dashboard";

const isDemoOnly = (process.env.NEXT_PUBLIC_DEMO_ONLY ?? "").trim().toLowerCase() === "true";

export default function Home() {
  return <SovereignDashboard demoMode={isDemoOnly} />;
}
