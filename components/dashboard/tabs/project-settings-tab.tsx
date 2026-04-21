import { useState } from "react";
import type { BrandConfig } from "@/components/dashboard/types";

type ProjectSettingsTabProps = {
  brand: BrandConfig;
  onBrandChange: (patch: Partial<BrandConfig>) => void;
  onReset?: () => void;
  onResetResponses?: () => void;
};

export function ProjectSettingsTab({
  brand,
  onBrandChange,
  onReset,
  onResetResponses,
}: ProjectSettingsTabProps) {
  return (
    <div className="space-y-5">
      <div>
        <div className="mb-3 text-base font-semibold text-th-text">브랜드 &amp; 웹사이트</div>
        <p className="mb-4 text-sm leading-relaxed text-th-text-muted">
          브랜드 정보를 설정하면 모든 프롬프트, AEO 감사, 분석이 해당 웹사이트 기준으로 실행됩니다.
          입력한 데이터는 서버 DB 에 저장되어 여러 관리자가 공유합니다.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Field
          label="브랜드 / 회사명"
          placeholder="예: 내 브랜드명"
          value={brand.brandName}
          onChange={(v) => onBrandChange({ brandName: v })}
        />
        <Field
          label="브랜드 별칭 (쉼표로 구분)"
          placeholder="예: 영문명, 줄임말, 운영사 이름"
          value={brand.brandAliases}
          onChange={(v) => onBrandChange({ brandAliases: v })}
        />
        <div className="xl:col-span-2">
          <WebsiteListField
            websites={brand.websites}
            onChange={(websites) => onBrandChange({ websites })}
          />
        </div>
        <Field
          label="산업 / 업종"
          placeholder="예: 업종, 분야, 전문 영역"
          value={brand.industry}
          onChange={(v) => onBrandChange({ industry: v })}
        />
        <Field
          label="타깃 키워드 (쉼표로 구분)"
          placeholder="예: 주요 검색 키워드"
          value={brand.keywords}
          onChange={(v) => onBrandChange({ keywords: v })}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
          브랜드 설명
        </label>
        <textarea
          value={brand.description}
          onChange={(e) => onBrandChange({ description: e.target.value })}
          placeholder="AI가 관련성을 판단할 수 있도록 제품/서비스를 간략히 설명해 주세요…"
          className="bd-input h-28 w-full rounded-lg p-2.5 text-sm"
        />
      </div>

      {/* Quick status */}
      <div className="grid gap-2 sm:grid-cols-3">
        <StatusChip
          label="브랜드명"
          ok={brand.brandName.trim().length > 0}
        />
        <StatusChip
          label="웹사이트"
          ok={brand.websites.length > 0 && brand.websites.some((w) => w.trim().length > 0)}
        />
        <StatusChip
          label="키워드"
          ok={brand.keywords.trim().length > 0}
        />
      </div>

      {/* Phase 5A 이관 UI 제거됨 — 서버 DB 가 source of truth */}

      {/* 부분 초기화 — 응답 이력만 */}
      {onResetResponses && (
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-th-text-muted">응답 이력 초기화</div>
          <p className="mb-3 text-sm text-th-text-secondary">AI 응답, 배틀카드, 감사 결과, 변동 알림만 삭제합니다. 브랜드 설정과 프롬프트는 그대로 유지됩니다.</p>
          <button
            onClick={onResetResponses}
            className="rounded-lg border border-th-border bg-th-card-alt px-4 py-2 text-sm font-medium text-th-text hover:bg-th-card-hover"
          >
            응답 이력만 초기화
          </button>
        </div>
      )}

      {/* Danger zone */}
      {onReset && (
        <div className="rounded-lg border border-th-danger/30 bg-th-danger-soft p-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-th-danger">위험 영역</div>
          <p className="mb-3 text-sm text-th-danger/70">저장된 모든 데이터(실행 이력, 프롬프트, 설정, 감사 결과)를 삭제합니다. 되돌릴 수 없습니다.</p>
          <button
            onClick={onReset}
            className="rounded-lg border border-th-danger/40 bg-th-danger-soft px-4 py-2 text-sm font-medium text-th-danger hover:bg-th-danger/20"
          >
            모든 데이터 초기화
          </button>
        </div>
      )}
    </div>
  );
}

function WebsiteListField({
  websites,
  onChange,
}: {
  websites: string[];
  onChange: (websites: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function addUrl() {
    const url = draft.trim();
    if (!url) return;
    onChange([...websites, url]);
    setDraft("");
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
        웹사이트 URL
      </label>
      {websites.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {websites.map((url, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full bg-th-card-alt border border-th-border px-3 py-1 text-sm text-th-text"
            >
              {url.replace(/^https?:\/\//, "")}
              <button
                onClick={() => onChange(websites.filter((_, j) => j !== i))}
                className="rounded-full p-0.5 hover:bg-th-danger-soft hover:text-th-danger"
                title="삭제"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } }}
          placeholder="https://example.com"
          className="bd-input flex-1 rounded-lg p-2.5 text-sm"
        />
        <button
          onClick={addUrl}
          disabled={!draft.trim()}
          className="rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-white hover:bg-th-accent-hover disabled:opacity-50"
        >
          추가
        </button>
      </div>
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
        {ok ? "입력완료" : "미입력"}
      </span>
    </div>
  );
}
