import type { BrandConfig } from "@/components/dashboard/types";

type ProjectSettingsTabProps = {
  brand: BrandConfig;
  onBrandChange: (patch: Partial<BrandConfig>) => void;
  onReset?: () => void;
};

export function ProjectSettingsTab({ brand, onBrandChange, onReset }: ProjectSettingsTabProps) {
  return (
    <div className="space-y-5">
      <div>
        <div className="mb-3 text-base font-semibold text-th-text">Brand & Website</div>
        <p className="mb-4 text-sm leading-relaxed text-th-text-muted">
          Configure your brand so every prompt, audit, and analysis is contextualized
          for your website. All data stays local in your browser.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Field
          label="Brand / Company Name"
          placeholder="Acme Corp"
          value={brand.brandName}
          onChange={(v) => onBrandChange({ brandName: v })}
        />
        <Field
          label="Brand Aliases (comma-separated)"
          placeholder="ACME, Acme Inc, acme.com"
          value={brand.brandAliases}
          onChange={(v) => onBrandChange({ brandAliases: v })}
        />
        <Field
          label="Website URL"
          placeholder="https://acme.com"
          value={brand.website}
          onChange={(v) => onBrandChange({ website: v })}
        />
        <Field
          label="Industry / Vertical"
          placeholder="B2B SaaS, E-commerce, Healthcare…"
          value={brand.industry}
          onChange={(v) => onBrandChange({ industry: v })}
        />
        <Field
          label="Target Keywords (comma-separated)"
          placeholder="AI analytics, answer engine optimization, GEO tools"
          value={brand.keywords}
          onChange={(v) => onBrandChange({ keywords: v })}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
          Brand Description
        </label>
        <textarea
          value={brand.description}
          onChange={(e) => onBrandChange({ description: e.target.value })}
          placeholder="Brief description of your product/service so AI models can assess relevance…"
          className="bd-input h-28 w-full rounded-lg p-2.5 text-sm"
        />
      </div>

      {/* Quick status */}
      <div className="grid gap-2 sm:grid-cols-3">
        <StatusChip
          label="Brand Name"
          ok={brand.brandName.trim().length > 0}
        />
        <StatusChip
          label="Website"
          ok={brand.website.trim().length > 0}
        />
        <StatusChip
          label="Keywords"
          ok={brand.keywords.trim().length > 0}
        />
      </div>

      {/* Danger zone */}
      {onReset && (
        <div className="rounded-lg border border-th-danger/30 bg-th-danger-soft p-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-th-danger">Danger Zone</div>
          <p className="mb-3 text-sm text-th-danger/70">Delete all saved data including runs, prompts, settings, and audit results. This cannot be undone.</p>
          <button
            onClick={onReset}
            className="rounded-lg border border-th-danger/40 bg-th-danger-soft px-4 py-2 text-sm font-medium text-th-danger hover:bg-th-danger/20"
          >
            Reset All Data
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bd-input w-full rounded-lg p-2.5 text-sm"
      />
    </div>
  );
}

function StatusChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-th-border bg-th-card-alt px-3 py-2.5">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-th-success" : "bg-th-text-muted"}`}
      />
      <span className="text-sm text-th-text-secondary">{label}</span>
      <span className={`ml-auto text-xs font-medium ${ok ? "text-th-success" : "text-th-text-muted"}`}>
        {ok ? "Set" : "Missing"}
      </span>
    </div>
  );
}
