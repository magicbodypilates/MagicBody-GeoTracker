import { useMemo, useState } from "react";
import type { PromptSet, TaggedPrompt } from "../types";
import {
  ALL_SETS,
  effectiveSetId,
  groupBySet,
  promptsInView,
  resolveAddTargetSetId,
  setNameOf,
  sortSets,
} from "@/lib/client/prompt-sets";

type PromptHubTabProps = {
  customPrompts: TaggedPrompt[];
  busy: boolean;
  activeProviderCount: number;
  /** "제거 + 데이터 삭제" 버튼 노출 여부 — 응답 일괄 삭제 권한 (admin 전용) */
  canCascadeDelete?: boolean;
  /**
   * 질문 세트(계획 prompt-sets-plan-v2 §5-1). 없으면(데모·세트 목록 실패) 세트 막대·옮기기를 숨기고
   * 예전 화면 그대로 쓴다.
   */
  promptSets?: PromptSet[];
  /** 보고 있는 세트 번호 또는 "all"(전체) — 부모가 워크스페이스별로 기억한다 */
  viewSetId?: string;
  onViewSetChange?: (setId: string) => void;
  onCreateSet?: (name: string) => Promise<boolean>;
  onRenameSet?: (setId: string, name: string) => Promise<boolean>;
  onDeleteSet?: (setId: string) => Promise<void>;
  onMovePrompts?: (promptIds: string[], setId: string) => Promise<boolean>;
  /** 질문 추가 — setId 가 없으면 서버가 기존 세트로 넣는다 */
  onAddCustomPrompt: (value: string, setId?: string) => void;
  onRemoveCustomPrompt: (value: string, deleteResponses?: boolean) => void;
  onUpdatePromptTags: (text: string, tags: string[]) => void;
  onRunPrompt: (prompt: string) => void;
  /** 보고 있는 범위의 질문만 실행 — 「전체」면 전부(예전과 같음) */
  onBatchRun: (texts: string[]) => void;
  /** 보고 있는 범위의 질문만 제거 — scopeName 은 확인 문구용(「전체」면 없음) */
  onClearScope?: (texts: string[], scopeName?: string) => void;
};

export function PromptHubTab({
  customPrompts,
  busy,
  activeProviderCount,
  canCascadeDelete = false,
  promptSets,
  viewSetId = ALL_SETS,
  onViewSetChange,
  onCreateSet,
  onRenameSet,
  onDeleteSet,
  onMovePrompts,
  onAddCustomPrompt,
  onRemoveCustomPrompt,
  onUpdatePromptTags,
  onRunPrompt,
  onBatchRun,
  onClearScope,
}: PromptHubTabProps) {
  const [newPrompt, setNewPrompt] = useState("");
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [filterTag, setFilterTag] = useState<string | null>(null);
  // 세트 편집 — 새 세트 이름 입력 · 이름 바꾸기 입력 · 메뉴 열림
  const [newSetName, setNewSetName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setBusy, setSetBusy] = useState(false);
  // 보기(세트)마다 따로 — 보기를 바꾸면 넣을 세트·선택이 자연히 초기화된다
  const [addTarget, setAddTarget] = useState<{ view: string; setId: string } | null>(null);
  const [selection, setSelection] = useState<{ view: string; ids: Set<string> }>({ view: viewSetId, ids: new Set() });
  const [moveTarget, setMoveTarget] = useState<string>("");

  // {brand} 치환 제거 — 편향 방지. 프롬프트를 리터럴 그대로 사용.
  const interpolateBrand = (value: string) => value;

  const setsOn = !!promptSets && promptSets.length > 0;
  const sets = useMemo(() => (promptSets ? sortSets(promptSets) : []), [promptSets]);
  const view = setsOn && (viewSetId === ALL_SETS || sets.some((s) => s.id === viewSetId)) ? viewSetId : ALL_SETS;
  const viewSet = sets.find((s) => s.id === view) ?? null;

  // 세트 막대 숫자 — 화면 목록(낙관 추가 반영)으로 센다
  const groups = useMemo(() => (setsOn ? groupBySet(customPrompts, sets) : []), [setsOn, customPrompts, sets]);
  const scoped = useMemo(
    () => (setsOn ? promptsInView(customPrompts, sets, view) : customPrompts),
    [setsOn, customPrompts, sets, view],
  );

  // Collect all unique tags across prompts (보고 있는 범위 기준)
  const allTags = Array.from(new Set(scoped.flatMap((p) => p.tags))).sort();
  const activeTag = filterTag && allTags.includes(filterTag) ? filterTag : null;
  const filteredPrompts = activeTag ? scoped.filter((p) => p.tags.includes(activeTag)) : scoped;

  const defaultTarget = setsOn ? resolveAddTargetSetId(view, sets) : undefined;
  const addTargetId = addTarget && addTarget.view === view && sets.some((s) => s.id === addTarget.setId)
    ? addTarget.setId
    : defaultTarget;

  const selectedIds = selection.view === view ? selection.ids : new Set<string>();
  const selectableInList = filteredPrompts.filter((p) => !!p.id).map((p) => p.id!) as string[];
  const allInListSelected = selectableInList.length > 0 && selectableInList.every((id) => selectedIds.has(id));
  const moveOptions = sets.filter((s) => s.id !== view);
  const moveTargetId = moveOptions.some((s) => s.id === moveTarget) ? moveTarget : (moveOptions[0]?.id ?? "");

  function setSelected(next: Set<string>) {
    setSelection({ view, ids: next });
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

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

  function submitNewPrompt() {
    if (!newPrompt.trim()) return;
    onAddCustomPrompt(newPrompt, addTargetId);
    setNewPrompt("");
  }

  async function submitNewSet() {
    const name = (newSetName ?? "").trim();
    if (!name || !onCreateSet) return;
    setSetBusy(true);
    try {
      if (await onCreateSet(name)) setNewSetName(null);
    } finally {
      setSetBusy(false);
    }
  }

  async function submitRename() {
    const name = (renameDraft ?? "").trim();
    if (!name || !viewSet || !onRenameSet) return;
    setSetBusy(true);
    try {
      if (await onRenameSet(viewSet.id, name)) {
        setRenameDraft(null);
        setMenuOpen(false);
      }
    } finally {
      setSetBusy(false);
    }
  }

  async function submitMove() {
    if (!onMovePrompts || !moveTargetId || selectedIds.size === 0) return;
    setSetBusy(true);
    try {
      if (await onMovePrompts(Array.from(selectedIds), moveTargetId)) setSelected(new Set());
    } finally {
      setSetBusy(false);
    }
  }

  const viewCount = viewSet ? (groups.find((g) => g.key === viewSet.id)?.items.length ?? 0) : customPrompts.length;
  const deleteBlockReason = !viewSet
    ? ""
    : viewSet.isDefault
      ? "기존 세트는 지울 수 없어요. 이름만 바꿀 수 있습니다."
      : viewCount > 0
        ? `질문 ${viewCount}개가 남아 있어 지울 수 없어요. 다른 세트로 옮기거나 제거한 뒤 지워 주세요.`
        : "";
  const scopeTexts = scoped.map((p) => p.text);
  const runLabel = viewSet ? "▶ 이 세트 실행" : "▶ 전체 실행";
  const clearLabel = viewSet ? "이 세트 질문 전체 제거" : "전체 삭제";

  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition-colors ${on ? "bg-th-accent text-white" : "bd-chip hover:bg-th-border"}`;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-th-border bg-th-card-alt p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium uppercase tracking-wider text-th-text-muted">
            추적 프롬프트 라이브러리
          </div>
          {scoped.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                disabled={busy}
                onClick={() => onBatchRun(scopeTexts)}
                className="bd-btn-primary rounded-lg px-3 py-1.5 text-sm disabled:opacity-60"
                title={`${viewSet ? `‘${viewSet.name}’ 세트` : "전체"} 프롬프트 ${scoped.length}개 × ${activeProviderCount}개 모델 실행`}
              >
                {runLabel} ({scoped.length} × {activeProviderCount})
              </button>
              {onClearScope && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onClearScope(scopeTexts, viewSet?.name)}
                  className="rounded-lg border border-th-border bg-th-card-alt px-3 py-1.5 text-sm text-th-text-muted hover:bg-th-card-hover hover:text-th-text disabled:opacity-60"
                  title={viewSet ? `‘${viewSet.name}’ 세트의 프롬프트를 모두 제거 (응답 이력은 유지)` : "저장된 프롬프트를 모두 삭제 (응답 이력은 유지)"}
                >
                  {clearLabel}
                </button>
              )}
            </div>
          )}
        </div>

        {/* 세트 막대 — 전체 · 세트별 · + 새 세트 */}
        {setsOn && (
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="질문 세트">
              <button type="button" onClick={() => onViewSetChange?.(ALL_SETS)} className={chip(view === ALL_SETS)}>
                전체 ({customPrompts.length})
              </button>
              {groups.map((g) =>
                g.set ? (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => {
                      onViewSetChange?.(g.key);
                      setMenuOpen(false);
                      setRenameDraft(null);
                    }}
                    className={chip(view === g.key)}
                  >
                    {g.label} ({g.items.length})
                  </button>
                ) : (
                  <span key={g.key} className="rounded-full px-3 py-1 text-xs text-th-text-muted">
                    {g.label} ({g.items.length})
                  </span>
                ),
              )}
              {onCreateSet && newSetName === null && (
                <button
                  type="button"
                  onClick={() => setNewSetName("")}
                  className="rounded-full border border-dashed border-th-border px-3 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover"
                >
                  + 새 세트
                </button>
              )}
              {viewSet && (onRenameSet || onDeleteSet) && (
                <div className="relative">
                  <button
                    type="button"
                    aria-label="세트 메뉴"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((o) => !o)}
                    className="rounded-full border border-th-border px-2.5 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover"
                  >
                    ⋯
                  </button>
                  {menuOpen && (
                    <div className="absolute left-0 z-20 mt-1 w-44 rounded-lg border border-th-border bg-th-card p-1 shadow-lg">
                      {onRenameSet && (
                        <button
                          type="button"
                          onClick={() => {
                            setRenameDraft(viewSet.name);
                            setMenuOpen(false);
                          }}
                          className="block w-full rounded px-2 py-1.5 text-left text-xs text-th-text hover:bg-th-card-hover"
                        >
                          이름 바꾸기
                        </button>
                      )}
                      {onDeleteSet && (
                        <button
                          type="button"
                          disabled={!!deleteBlockReason || setBusy}
                          title={deleteBlockReason || `‘${viewSet.name}’ 세트를 지웁니다`}
                          onClick={async () => {
                            if (!window.confirm(`‘${viewSet.name}’ 세트를 지울까요?`)) return;
                            setMenuOpen(false);
                            setSetBusy(true);
                            try {
                              await onDeleteSet(viewSet.id);
                            } finally {
                              setSetBusy(false);
                            }
                          }}
                          className="block w-full rounded px-2 py-1.5 text-left text-xs text-th-danger hover:bg-th-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          세트 삭제
                        </button>
                      )}
                      {deleteBlockReason && (
                        <p className="px-2 pb-1 pt-0.5 text-[11px] leading-snug text-th-text-muted">{deleteBlockReason}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {newSetName !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  autoFocus
                  value={newSetName}
                  maxLength={40}
                  onChange={(e) => setNewSetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitNewSet();
                    if (e.key === "Escape") setNewSetName(null);
                  }}
                  placeholder="새 세트 이름 (40자까지)"
                  className="bd-input min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm sm:max-w-xs"
                />
                <button
                  type="button"
                  disabled={setBusy || !newSetName.trim()}
                  onClick={() => void submitNewSet()}
                  className="bd-btn-primary rounded-lg px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  만들기
                </button>
                <button type="button" onClick={() => setNewSetName(null)} className="bd-chip rounded-lg px-3 py-1.5 text-sm">
                  취소
                </button>
              </div>
            )}

            {renameDraft !== null && viewSet && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  autoFocus
                  value={renameDraft}
                  maxLength={40}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitRename();
                    if (e.key === "Escape") setRenameDraft(null);
                  }}
                  aria-label="세트 새 이름"
                  className="bd-input min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm sm:max-w-xs"
                />
                <button
                  type="button"
                  disabled={setBusy || !renameDraft.trim()}
                  onClick={() => void submitRename()}
                  className="bd-btn-primary rounded-lg px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  이름 저장
                </button>
                <button type="button" onClick={() => setRenameDraft(null)} className="bd-chip rounded-lg px-3 py-1.5 text-sm">
                  취소
                </button>
              </div>
            )}
          </div>
        )}

        <p className="mb-3 text-sm text-th-text-secondary">
          추적할 프롬프트를 추가하세요. <span className="font-semibold">{"{brand}"}</span>를 쓰면 브랜드명이 자동 삽입됩니다.
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
                activeTag === null
                  ? "bg-th-accent text-white"
                  : "bd-chip hover:bg-th-border"
              }`}
            >
              전체 ({scoped.length})
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setFilterTag(activeTag === tag ? null : tag)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  activeTag === tag
                    ? "bg-th-accent text-white"
                    : "bd-chip hover:bg-th-border"
                }`}
              >
                {tag} ({scoped.filter((p) => p.tags.includes(tag)).length})
              </button>
            ))}
          </div>
        )}

        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewPrompt();
            }}
            placeholder="예: AI 에게 물어볼 실제 질문 (카테고리 · 추천 · 비교)"
            className="bd-input w-full min-w-0 rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            {setsOn && (
              <select
                value={addTargetId ?? ""}
                onChange={(e) => setAddTarget({ view, setId: e.target.value })}
                aria-label="넣을 세트"
                title="새 질문을 넣을 세트"
                className="bd-input min-w-0 flex-1 rounded-lg px-2 py-2 text-sm sm:w-40 sm:flex-none"
              >
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    넣을 세트: {s.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={submitNewPrompt}
              className="bd-btn-primary shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm"
            >
              추가
            </button>
          </div>
        </div>

        {setsOn && onMovePrompts && selectableInList.length > 0 && (
          <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-th-text-secondary">
            <input
              type="checkbox"
              checked={allInListSelected}
              onChange={() => {
                const next = new Set(selectedIds);
                if (allInListSelected) selectableInList.forEach((id) => next.delete(id));
                else selectableInList.forEach((id) => next.add(id));
                setSelected(next);
              }}
            />
            {viewSet ? "이 세트 모두 선택" : "목록 모두 선택"}
          </label>
        )}

        <ul className="space-y-2 pr-1 text-sm">
          {filteredPrompts.length === 0 && (
            <li className="text-th-text-secondary">
              {scoped.length === 0
                ? viewSet
                  ? "이 세트에는 아직 질문이 없습니다. 위에서 추가하거나 다른 세트의 질문을 옮겨 오세요."
                  : "아직 추가된 프롬프트가 없습니다."
                : "해당 필터에 일치하는 프롬프트가 없습니다."}
            </li>
          )}
          {filteredPrompts.map((item, index) => {
            const setName = setsOn && view === ALL_SETS ? setNameOf(effectiveSetId(item.setId, sets), sets) : undefined;
            return (
              <li
                key={`${item.text}-${index}`}
                className="rounded-lg border border-th-border bg-th-card p-3"
              >
                {/* PC: 프롬프트 텍스트 + 태그 같은 라인. 모바일: 세로로 */}
                <div className="mb-2 flex flex-col gap-2 md:flex-row md:items-start md:gap-3">
                  <div className="flex flex-1 items-start gap-2">
                    {setsOn && onMovePrompts && (
                      <input
                        type="checkbox"
                        aria-label="옮길 질문 선택"
                        // 번호가 아직 없는 낙관 항목(서버 저장 전)은 옮길 수 없어 잠근다
                        disabled={!item.id}
                        title={item.id ? undefined : "저장이 끝나면 고를 수 있어요"}
                        checked={!!item.id && selectedIds.has(item.id)}
                        onChange={() => item.id && toggleOne(item.id)}
                        className="mt-1 shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-3 text-th-text">{interpolateBrand(item.text)}</div>
                      {setName && <div className="mt-0.5 text-xs text-th-text-muted">세트: {setName}</div>}
                    </div>
                  </div>

                  {/* Tags row */}
                  <div className="flex flex-wrap items-center gap-1.5 md:shrink-0 md:justify-end">
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
                  {canCascadeDelete && (
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
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 옮기기 막대 — 고른 질문이 있을 때만 화면 아래에 고정 */}
      {setsOn && onMovePrompts && selectedIds.size > 0 && (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-th-accent/40 bg-th-card p-3 shadow-lg">
          <span className="text-sm font-medium text-th-text">{selectedIds.size}개 선택</span>
          {moveOptions.length === 0 ? (
            <span className="text-xs text-th-text-muted">옮길 다른 세트가 없어요. 「+ 새 세트」로 먼저 만들어 주세요.</span>
          ) : (
            <>
              <select
                value={moveTargetId}
                onChange={(e) => setMoveTarget(e.target.value)}
                aria-label="옮길 세트"
                className="bd-input min-w-0 rounded-lg px-2 py-1.5 text-sm"
              >
                {moveOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={setBusy || !moveTargetId}
                onClick={() => void submitMove()}
                className="bd-btn-primary rounded-lg px-3 py-1.5 text-sm disabled:opacity-60"
              >
                옮기기
              </button>
            </>
          )}
          <button type="button" onClick={() => setSelected(new Set())} className="bd-chip rounded-lg px-3 py-1.5 text-sm">
            선택 해제
          </button>
          <span className="w-full text-xs text-th-text-muted">옮겨도 지금까지 쌓인 AI 응답과 자동 조사 설정은 그대로입니다.</span>
        </div>
      )}
    </div>
  );
}
