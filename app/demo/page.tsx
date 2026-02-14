import { SovereignDashboard } from "@/components/sovereign-dashboard";

export const metadata = {
  title: "Sovereign AEO Tracker — Demo",
  description: "Read-only demo of the Sovereign AEO Tracker. Explore AI visibility tracking, competitor battlecards, citation analysis, and more.",
};

export default function DemoPage() {
  return <SovereignDashboard demoMode />;
}
