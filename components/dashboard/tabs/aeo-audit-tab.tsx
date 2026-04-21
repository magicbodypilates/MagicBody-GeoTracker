import { useState } from "react";
import type {
  AuditReport,
  AuditCheck,
  AuditHistoryEntry,
} from "@/components/dashboard/types";

type AeoAuditTabProps = {
  auditUrl: string;
  auditReport: AuditReport | null;
  auditHistory: AuditHistoryEntry[];
  onAuditUrlChange: (value: string) => void;
  onRunAudit: () => void;
  onDeleteAuditHistory: (id: string) => void;
  onUpdateAuditNote: (id: string, note: string) => void;
  onViewAuditHistory: (id: string) => void;
};

const CATEGORY_META: Record<
  AuditCheck["category"],
  { label: string; icon: string; color: string }
> = {
  discovery: { label: "발견", icon: "🔍", color: "var(--th-accent)" },
  structure: { label: "구조 및 스키마", icon: "🏗️", color: "#8b5cf6" },
  content: { label: "콘텐츠 품질", icon: "📝", color: "var(--th-success)" },
  technical: { label: "기술적 요소", icon: "⚙️", color: "var(--th-warning)" },
  rendering: { label: "서버사이드 렌더링", icon: "🖥️", color: "#ec4899" },
};

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

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
  auditHistory,
  onAuditUrlChange,
  onRunAudit,
  onDeleteAuditHistory,
  onUpdateAuditNote,
  onViewAuditHistory,
}: AeoAuditTabProps) {
  const categories: AuditCheck["category"][] = [
    "discovery",
    "structure",
    "content",
    "technical",
    "rendering",
  ];

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  return (
    <div className="space-y-4">
      {/* ── 입력 ────────────────────────────── */}
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
          AEO 감사 실행
        </button>
      </div>

      {/* ── 결과 ──────────────────────────────── */}
      {auditReport && (
        <div className="space-y-4">
          {/* 점수 */}
          <div className="flex items-center gap-6 rounded-xl border border-th-border bg-th-card p-5 shadow-sm">
            <ScoreRing score={auditReport.score ?? 0} />
            <div>
              <div className="text-lg font-semibold text-th-text">
                AEO 준비도 점수
              </div>
              <div className="mt-1 text-sm text-th-text-secondary">
                <span className="text-th-text-accent">{auditReport.url}</span>에 대해{" "}
                {(auditReport.checks ?? []).length}개 중{" "}
                {(auditReport.checks ?? []).filter((c) => c.pass).length}개 통과
              </div>
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

          {/* 카테고리별 체크 */}
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

      {/* ── 이력 ─────────────────────────── */}
      {auditHistory.length > 0 && (
        <div className="rounded-xl border border-th-border bg-th-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-th-text">
              감사 이력 ({auditHistory.length}건)
            </h3>
            <span className="text-xs text-th-text-muted">최대 30건까지 자동 저장됩니다. 클릭하면 해당 감사 상세 내역을 위에 다시 표시합니다.</span>
          </div>
          <div className="space-y-1.5">
            {auditHistory.map((entry) => {
              const isEditing = editingNoteId === entry.id;
              return (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-sm"
                >
                  <span className="text-xs text-th-text-muted whitespace-nowrap">
                    {formatDate(entry.createdAt)}
                  </span>
                  <span
                    className="rounded-md px-2 py-0.5 text-xs font-medium"
                    style={{
                      background:
                        entry.report.score >= 80
                          ? "color-mix(in srgb, var(--th-success) 15%, transparent)"
                          : entry.report.score >= 50
                            ? "color-mix(in srgb, var(--th-warning) 15%, transparent)"
                            : "color-mix(in srgb, var(--th-danger) 15%, transparent)",
                      color:
                        entry.report.score >= 80
                          ? "var(--th-success)"
                          : entry.report.score >= 50
                            ? "var(--th-warning)"
                            : "var(--th-danger)",
                    }}
                  >
                    {entry.report.score}점
                  </span>
                  <button
                    onClick={() => onViewAuditHistory(entry.id)}
                    className="flex-1 min-w-0 truncate text-left text-th-text-secondary hover:text-th-text-accent hover:underline"
                    title="이 이력의 상세 내역을 위에 다시 표시"
                  >
                    {entry.url}
                  </button>
                  {isEditing ? (
                    <>
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="메모 입력"
                        className="bd-input rounded-md px-2 py-1 text-xs"
                      />
                      <button
                        onClick={() => {
                          onUpdateAuditNote(entry.id, noteDraft.trim());
                          setEditingNoteId(null);
                        }}
                        className="rounded-md bg-th-accent/15 px-2 py-1 text-xs text-th-accent hover:bg-th-accent/25"
                      >
                        저장
                      </button>
                      <button
                        onClick={() => setEditingNoteId(null)}
                        className="rounded-md bg-th-card-hover px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover/70"
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      {entry.note && (
                        <span className="rounded-md bg-th-card-hover px-2 py-0.5 text-xs text-th-text-secondary">
                          {entry.note}
                        </span>
                      )}
                      <button
                        onClick={() => onViewAuditHistory(entry.id)}
                        className="rounded-md bg-th-accent/15 px-2 py-1 text-xs text-th-accent hover:bg-th-accent/25"
                        title="이 이력을 현재 감사 결과로 다시 표시"
                      >
                        상세 보기
                      </button>
                      <button
                        onClick={() => {
                          setEditingNoteId(entry.id);
                          setNoteDraft(entry.note ?? "");
                        }}
                        className="rounded-md bg-th-card-hover px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover/70"
                      >
                        {entry.note ? "메모 수정" : "메모"}
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm("이 이력을 삭제하시겠습니까?")) {
                            onDeleteAuditHistory(entry.id);
                          }
                        }}
                        className="rounded-md bg-th-danger/15 px-2 py-1 text-xs text-th-danger hover:bg-th-danger/25"
                      >
                        삭제
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
