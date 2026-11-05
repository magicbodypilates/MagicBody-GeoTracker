"use client";

/**
 * PromptSetPicker — 자동화 일정 만들기·고치기의 「실행할 프롬프트」 고르기 (계획 prompt-sets-plan-v2 §5-2).
 *
 * 세트별 접이식 묶음 — 머리 `기존 세트 (선택 8/45) [이 세트 전체 선택] [이 세트 해제]` + 위쪽
 * `모든 세트 전체 선택 / 전체 해제`. 고른 질문이 있는 세트는 처음부터 펼쳐 둔다.
 * 세트 정보가 없으면(세트 목록 실패) 묶음 하나(「전체」)로 예전 목록과 같게 그린다.
 * 선택 의미는 서버와 같다 — 아무것도 고르지 않으면 「켜진 질문 전체」(부모가 저장 때 확인을 받는다).
 */

import { useMemo, useState } from "react";
import type { PromptSet } from "@/components/dashboard/types";
import {
  countSelected,
  groupBySet,
  initiallyExpandedKeys,
  toggleGroupSelection,
  type SetGroup,
} from "@/lib/client/prompt-sets";

export type PickablePrompt = { id: string; text: string; setId?: string | null };

type Props = {
  /** 켜진 질문만 넘긴다 */
  prompts: PickablePrompt[];
  promptSets?: PromptSet[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
};

export function PromptSetPicker({ prompts, promptSets, selected, onChange }: Props) {
  const groups: SetGroup<PickablePrompt>[] = useMemo(() => {
    if (promptSets && promptSets.length > 0) return groupBySet(prompts, promptSets);
    return [{ key: "all", label: "전체", set: null, items: prompts }];
  }, [prompts, promptSets]);
  // 사용자가 한 번이라도 접거나 펼치기 전에는 「고른 질문이 있는 세트(없으면 첫 세트)」를 펼친다 — 질문·세트 목록이
  // 늦게 도착해도 맞게 펼쳐진다. 그 뒤로는 사용자가 정한 상태를 유지한다.
  const [manual, setManual] = useState<Set<string> | null>(null);
  const expanded = manual ?? initiallyExpandedKeys(groups, selected);

  const total = prompts.length;
  const selectedCount = countSelected(prompts, selected);

  if (total === 0) {
    return (
      <p className="rounded border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-muted">
        활성 프롬프트가 없습니다. Prompt Hub 에서 프롬프트를 먼저 추가하세요.
      </p>
    );
  }

  function toggleExpanded(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setManual(next);
  }

  const btn =
    "rounded border border-th-border px-2 py-0.5 text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-th-text-muted">
          {selectedCount === 0 ? `전체 ${total}개 (선택 0)` : `선택 ${selectedCount}/${total}`}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className={btn} onClick={() => onChange(new Set(prompts.map((p) => p.id)))}>
            {groups.length > 1 ? "모든 세트 전체 선택" : "전체 선택"}
          </button>
          <button type="button" className={btn} onClick={() => onChange(new Set())}>
            전체 해제
          </button>
        </div>
      </div>

      <div className="max-h-80 space-y-1.5 overflow-y-auto rounded-lg border border-th-border bg-th-card-alt p-2">
        {groups.map((g) => {
          const n = countSelected(g.items, selected);
          const open = expanded.has(g.key) || groups.length === 1;
          return (
            <div key={g.key} className="rounded-md border border-th-border bg-th-card">
              {groups.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(g.key)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium text-th-text"
                  >
                    <span className="inline-block w-3 text-th-text-muted">{open ? "▾" : "▸"}</span>
                    <span className="truncate">{g.label}</span>
                    <span className="shrink-0 font-normal text-th-text-muted">
                      (선택 {n}/{g.items.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={g.items.length === 0}
                    onClick={() => onChange(toggleGroupSelection(selected, g.items, true))}
                  >
                    이 세트 전체 선택
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={n === 0}
                    onClick={() => onChange(toggleGroupSelection(selected, g.items, false))}
                  >
                    이 세트 해제
                  </button>
                </div>
              )}
              {open && (
                <div className="space-y-0.5 border-t border-th-border p-1 first:border-t-0">
                  {g.items.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-th-text-muted">이 세트에는 질문이 없습니다.</p>
                  ) : (
                    g.items.map((p) => (
                      <label
                        key={p.id}
                        className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-th-card-hover"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            onChange(next);
                          }}
                          className="mt-0.5 shrink-0"
                        />
                        <span className="line-clamp-2 text-th-text">{p.text}</span>
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
