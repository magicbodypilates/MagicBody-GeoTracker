import { useState } from "react";
import type { TaggedPrompt } from "../types";

type PromptHubTabProps = {
  customPrompts: TaggedPrompt[];
  brandName?: string;
  busy: boolean;
  activeProviderCount: number;
  onAddCustomPrompt: (value: string) => void;
  onRemoveCustomPrompt: (value: string, deleteResponses?: boolean) => void;
  onUpdatePromptTags: (text: string, tags: string[]) => void;
  onRunPrompt: (prompt: string) => void;
  onBatchRunAll: () => void;
};

export function PromptHubTab({
  customPrompts,
  brandName,
  busy,
  activeProviderCount,
  onAddCustomPrompt,
  onRemoveCustomPrompt,
  onUpdatePromptTags,
  onRunPrompt,
  onBatchRunAll,
}: PromptHubTabProps) {
  const [newPrompt, setNewPrompt] = useState("");
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const interpolateBrand = (value: string) => {
    if (!brandName?.trim()) return value;
    return value.replaceAll("{brand}", brandName.trim());
  };

  // Collect all unique tags across prompts
  const allTags = Array.from(new Set(customPrompts.flatMap((p) => p.tags))).sort();

  const filteredPrompts = filterTag
    ? customPrompts.filter((p) => p.tags.includes(filterTag))
    : customPrompts;

  function handleAddTag(promptText: string, tags: string[]) {
    const draft = (tagDrafts[promptText] ?? "").trim();
    if (!draft) return;
    if (!tags.includes(draft)) {
      onUpdatePromptTags(promptText, [...tags, draft]);
    }
    setTagDrafts((prev) => ({ ...prev, [promptText]: "" }));
  }

  function handleRemoveTag(promptText: string, tags: string[], tagToRemove: string) {
    onUpdatePromptTags(promptText, tags.filter((t) => t !== tagToRemove));
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-th-border bg-th-card-alt p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium uppercase tracking-wider text-th-text-muted">
            추적 프롬프트 라이브러리
          </div>
          {customPrompts.length > 0 && (
            <button
              disabled={busy}
              onClick={onBatchRunAll}
              className="bd-btn-primary rounded-lg px-3 py-1.5 text-sm disabled:opacity-60"
              title={`전체 프롬프트 ${customPrompts.length}개 × ${activeProviderCount}개 모델 실행`}
            >
              ▶ 전체 실행 ({customPrompts.length} × {activeProviderCount})
            </button>
          )}
        </div>
        <p className="mb-3 text-sm text-th-text-secondary">
          시간 경과에 따라 추적할 프롬프트를 추가하세요. <span className="font-semibold">{"{brand}"}</span>를 쓰면 브랜드명이 자동 삽입됩니다.
          {activeProviderCount > 1 && (
            <span className="ml-1 text-th-text-accent">· 선택한 {activeProviderCount}개 AI 모델을 병렬로 실행합니다.</span>
          )}
        </p>

        {/* Tag filter bar */}
        {allTags.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-th-text-muted">필터:</span>
            <button
              onClick={() => setFilterTag(null)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                filterTag === null
                  ? "bg-th-accent text-white"
                  : "bd-chip hover:bg-th-border"
              }`}
            >
              전체 ({customPrompts.length})
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setFilterTag(filterTag === tag ? null : tag)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  filterTag === tag
                    ? "bg-th-accent text-white"
                    : "bd-chip hover:bg-th-border"
                }`}
              >
                {tag} ({customPrompts.filter((p) => p.tags.includes(tag)).length})
              </button>
            ))}
          </div>
        )}

        <div className="mb-3 flex gap-2">
          <input
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newPrompt.trim()) {
                onAddCustomPrompt(newPrompt);
                setNewPrompt("");
              }
            }}
            placeholder="예: 재활 필라테스 자격증 추천, {brand} 수업 후기"
            className="bd-input w-full rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={() => {
              onAddCustomPrompt(newPrompt);
              setNewPrompt("");
            }}
            className="bd-btn-primary rounded-lg px-4 py-2 text-sm"
          >
            추가
          </button>
        </div>

        <ul className="space-y-2 pr-1 text-sm">
          {filteredPrompts.length === 0 && (
            <li className="text-th-text-secondary">
              {customPrompts.length === 0 ? "아직 추가된 프롬프트가 없습니다." : "해당 필터에 일치하는 프롬프트가 없습니다."}
            </li>
          )}
          {filteredPrompts.map((item, index) => (
            <li
              key={`${item.text}-${index}`}
              className="rounded-lg border border-th-border bg-th-card p-3"
            >
              <div className="mb-2 line-clamp-3 text-th-text">{interpolateBrand(item.text)}</div>

              {/* Tags row */}
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-th-accent/10 px-2 py-0.5 text-xs font-medium text-th-accent"
                  >
                    {tag}
                    <button
                      onClick={() => handleRemoveTag(item.text, item.tags, tag)}
                      className="ml-0.5 text-th-accent/60 hover:text-th-accent"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <div className="inline-flex items-center gap-1">
                  <input
                    value={tagDrafts[item.text] ?? ""}
                    onChange={(e) =>
                      setTagDrafts((prev) => ({ ...prev, [item.text]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddTag(item.text, item.tags);
                    }}
                    placeholder="+ 태그"
                    className="w-16 rounded-md border border-th-border bg-transparent px-1.5 py-0.5 text-xs focus:w-24 focus:outline-none focus:ring-1 focus:ring-th-accent transition-all"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => onRunPrompt(interpolateBrand(item.text))}
                  className="bd-btn-primary rounded-md px-3 py-1.5 text-xs"
                >
                  실행
                </button>
                <button
                  onClick={() => onRemoveCustomPrompt(item.text)}
                  className="bd-chip rounded-md px-3 py-1.5 text-xs"
                >
                  제거
                </button>
                <button
                  onClick={() => {
                    if (window.confirm("이 프롬프트와 수집된 모든 응답 데이터를 함께 삭제하시겠습니까?")) {
                      onRemoveCustomPrompt(item.text, true);
                    }
                  }}
                  className="bd-chip rounded-md px-3 py-1.5 text-xs text-th-danger hover:bg-th-danger-soft"
                >
                  제거 + 데이터 삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
