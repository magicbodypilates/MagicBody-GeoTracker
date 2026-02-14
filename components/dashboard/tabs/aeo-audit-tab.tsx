import { useState } from "react";
import type { AuditReport, AuditCheck } from "@/components/dashboard/types";

type AeoAuditTabProps = {
  auditUrl: string;
  auditReport: AuditReport | null;
  onAuditUrlChange: (value: string) => void;
  onRunAudit: () => void;
};

const CATEGORY_META: Record<
  AuditCheck["category"],
  { label: string; icon: string; color: string }
> = {
  discovery: { label: "Discovery", icon: "🔍", color: "var(--th-accent)" },
  structure: { label: "Structure & Schema", icon: "🏗️", color: "#8b5cf6" },
  content: { label: "Content Quality", icon: "📝", color: "var(--th-success)" },
  technical: { label: "Technical", icon: "⚙️", color: "var(--th-warning)" },
  rendering: { label: "Server-Side Rendering", icon: "🖥️", color: "#ec4899" },
};

function ScoreRing({ score }: { score: number }) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  const color =
    score >= 80 ? "var(--th-success)" : score >= 50 ? "var(--th-warning)" : "var(--th-danger)";
  return (
    <div className="relative flex items-center justify-center" style={{ width: 110, height: 110 }}>
      <svg width="110" height="110" viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={r} fill="none" stroke="var(--th-score-ring-bg)" strokeWidth="8" />
        <circle
          cx="55"
          cy="55"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          transform="rotate(-90 55 55)"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <span className="absolute text-2xl font-bold" style={{ color }}>
        {score}
      </span>
    </div>
  );
}

function CheckRow({ check }: { check: AuditCheck }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-th-card-hover transition-colors"
      >
        <span className={check.pass ? "text-th-success" : "text-th-danger"}>
          {check.pass ? "✓" : "✗"}
        </span>
        <span className="flex-1 font-medium text-th-text">{check.label}</span>
        <span className="rounded-md bg-th-card-hover px-2 py-0.5 text-xs text-th-text-secondary">
          {check.value}
        </span>
        <span className="text-xs text-th-text-muted">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-th-border px-4 py-2.5 text-sm text-th-text-secondary leading-relaxed">
          {check.detail}
        </div>
      )}
    </div>
  );
}

export function AeoAuditTab({
  auditUrl,
  auditReport,
  onAuditUrlChange,
  onRunAudit,
}: AeoAuditTabProps) {
  const categories: AuditCheck["category"][] = [
    "discovery",
    "structure",
    "content",
    "technical",
    "rendering",
  ];

  return (
    <div className="space-y-4">
      {/* ── Input bar ────────────────────────────── */}
      <div className="flex gap-2">
        <input
          value={auditUrl}
          onChange={(e) => onAuditUrlChange(e.target.value)}
          placeholder="https://example.com"
          className="bd-input flex-1 rounded-lg p-2.5 text-sm"
        />
        <button
          onClick={onRunAudit}
          className="bd-btn-primary whitespace-nowrap rounded-lg px-4 py-2.5 text-sm"
        >
          Run AEO Audit
        </button>
      </div>

      {/* ── Results ──────────────────────────────── */}
      {auditReport && (
        <div className="space-y-4">
          {/* Score header */}
          <div className="flex items-center gap-6 rounded-xl border border-th-border bg-th-card p-5 shadow-sm">
            <ScoreRing score={auditReport.score ?? 0} />
            <div>
              <div className="text-lg font-semibold text-th-text">
                AEO Readiness Score
              </div>
              <div className="mt-1 text-sm text-th-text-secondary">
                {(auditReport.checks ?? []).filter((c) => c.pass).length} of{" "}
                {(auditReport.checks ?? []).length} checks passed for{" "}
                <span className="text-th-text-accent">{auditReport.url}</span>
              </div>
              {/* Category summary pills */}
              <div className="mt-3 flex flex-wrap gap-2">
                {categories.map((cat) => {
                  const meta = CATEGORY_META[cat];
                  const group = (auditReport.checks ?? []).filter((c) => c.category === cat);
                  if (group.length === 0) return null;
                  const passed = group.filter((c) => c.pass).length;
                  return (
                    <span
                      key={cat}
                      className="inline-flex items-center gap-1 rounded-full border border-th-border bg-th-card-alt px-2.5 py-1 text-xs font-medium"
                      style={{ color: meta.color }}
                    >
                      {meta.icon} {meta.label}: {passed}/{group.length}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Category sections */}
          {categories.map((cat) => {
            const meta = CATEGORY_META[cat];
            const group = (auditReport.checks ?? []).filter((c) => c.category === cat);
            if (group.length === 0) return null;
            return (
              <div key={cat}>
                <h3
                  className="mb-2 flex items-center gap-2 text-sm font-semibold"
                  style={{ color: meta.color }}
                >
                  {meta.icon} {meta.label}
                </h3>
                <div className="space-y-1.5">
                  {group.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
