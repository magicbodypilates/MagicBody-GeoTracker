import { useState } from "react";

type NicheExplorerTabProps = {
  niche: string;
  nicheQueries: string[];
  trackedPrompts: string[];
  onNicheChange: (value: string) => void;
  onGenerateQueries: () => void;
  onAddToTracking: (query: string) => void;
};

export function NicheExplorerTab({
  niche,
  nicheQueries,
  trackedPrompts,
  onNicheChange,
  onGenerateQueries,
  onAddToTracking,
}: NicheExplorerTabProps) {
  const [addedSet, setAddedSet] = useState<Set<string>>(new Set());

  function handleAdd(query: string) {
    onAddToTracking(query);
    setAddedSet((prev) => new Set(prev).add(query));
  }

  function handleAddAll() {
    nicheQueries.forEach((q) => handleAdd(q));
  }

  return (
    <div className="space-y-4">
      <label className="text-sm font-medium uppercase tracking-wider text-th-text-muted">Target Niche</label>
      <input
        value={niche}
        onChange={(e) => onNicheChange(e.target.value)}
        className="bd-input w-full rounded-lg p-2.5 text-sm"
      />
      <button
        onClick={onGenerateQueries}
        className="bd-btn-primary rounded-lg px-4 py-2.5 text-sm"
      >
        Generate Queries
      </button>
      <div className="rounded-xl border border-th-border bg-th-card-alt p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium uppercase tracking-wider text-th-text-muted">
            High-Intent Prompt Bank
          </div>
          {nicheQueries.length > 0 && (
            <button
              onClick={handleAddAll}
              className="bd-btn-primary rounded-lg px-3 py-1.5 text-xs"
            >
              + Track All
            </button>
          )}
        </div>
        {nicheQueries.length === 0 && (
          <p className="text-sm text-th-text-secondary">No generated prompts yet.</p>
        )}
        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {nicheQueries.map((query) => {
            const alreadyTracked =
              addedSet.has(query) || trackedPrompts.includes(query);
            return (
              <li
                key={query}
                className="flex items-start gap-2 rounded-lg border border-th-border bg-th-card p-3"
              >
                <span className="flex-1 text-th-text-secondary">{query}</span>
                <button
                  onClick={() => handleAdd(query)}
                  disabled={alreadyTracked}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    alreadyTracked
                      ? "bg-th-success-soft text-th-success cursor-default"
                      : "bd-btn-primary"
                  }`}
                  title={alreadyTracked ? "Already in tracking library" : "Add to Prompt Hub tracking library"}
                >
                  {alreadyTracked ? "✓ Tracked" : "+ Track"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
