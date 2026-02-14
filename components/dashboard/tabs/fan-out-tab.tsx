type FanOutTabProps = {
  prompt: string;
  personas: string;
  fanoutPrompts: string[];
  busy: boolean;
  onPromptChange: (value: string) => void;
  onPersonasChange: (value: string) => void;
  onGenerateFanout: () => void;
  onRunPrompt: (prompt: string) => void;
};

export function FanOutTab({
  prompt,
  personas,
  fanoutPrompts,
  busy,
  onPromptChange,
  onPersonasChange,
  onGenerateFanout,
  onRunPrompt,
}: FanOutTabProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <label className="text-sm font-medium uppercase tracking-wider text-th-text-muted">
          Core Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          className="bd-input h-28 w-full rounded-lg p-2.5 text-sm"
        />
        <label className="text-sm font-medium uppercase tracking-wider text-th-text-muted">
          Personas (one per line)
        </label>
        <textarea
          value={personas}
          onChange={(e) => onPersonasChange(e.target.value)}
          className="bd-input h-32 w-full rounded-lg p-2.5 text-sm"
          placeholder={"CMO\nSEO Lead\nProduct Marketing Manager\nFounder"}
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onGenerateFanout}
            className="bd-btn-primary rounded-lg px-4 py-2.5 text-sm"
          >
            Generate Persona Fan-Out
          </button>
          <button
            disabled={busy}
            onClick={() => onRunPrompt(prompt)}
            className="bd-chip rounded-lg px-4 py-2.5 text-sm disabled:opacity-60"
          >
            Run Core Prompt
          </button>
        </div>
      </div>

      {/* Fan-out queue sidebar */}
      <div className="rounded-xl border border-th-border bg-th-card-alt p-4">
        <div className="mb-3 text-sm font-medium uppercase tracking-wider text-th-text-muted">
          Fan-Out Queue
        </div>
        {fanoutPrompts.length === 0 && (
          <p className="text-sm text-th-text-secondary">
            Generate fan-out prompts to populate this queue.
          </p>
        )}
        <ul className="max-h-[420px] space-y-2 overflow-auto pr-1 text-sm">
          {fanoutPrompts.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="rounded-lg border border-th-border bg-th-card p-3"
            >
              <div className="mb-2 line-clamp-3 text-th-text">{item}</div>
              <button
                onClick={() => onRunPrompt(item)}
                className="bd-btn-primary rounded-md px-3 py-1.5 text-xs"
              >
                Run
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
