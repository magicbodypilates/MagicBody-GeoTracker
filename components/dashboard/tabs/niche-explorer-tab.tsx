import { useMemo, useState } from "react";

type NicheExplorerTabProps = {
  niche: string;
  nicheQueries: string[];
  trackedPrompts: string[];
  busy?: boolean;
  onNicheChange: (value: string) => void;
  onGenerateQueries: () => void;
  onAddToTracking: (query: string) => void;
};

// 프리셋 제거됨 — 모든 입력은 사용자가 직접 작성 (편향 방지)

function classifyQuery(q: string): "정보형" | "비교형" | "결정형" {
  const comparison = /(비교|차이|vs|대비|어느|어떤.*이(?:나|지))/;
  const decision = /(추천|선택|가성비|어디|어떻게 등록|신청|후기|가격|비용|일정|등록|모집)/;
  if (comparison.test(q)) return "비교형";
  if (decision.test(q)) return "결정형";
  return "정보형";
}

const TYPE_STYLES: Record<string, string> = {
  정보형: "bg-th-accent-soft text-th-text-accent border-th-accent/30",
  비교형: "bg-th-success-soft text-th-success border-th-success/30",
  결정형: "bg-th-warning-soft text-th-warning border-th-warning/30",
};

export function NicheExplorerTab({
  niche,
  nicheQueries,
  trackedPrompts,
  busy = false,
  onNicheChange,
  onGenerateQueries,
  onAddToTracking,
}: NicheExplorerTabProps) {
  const [addedSet, setAddedSet] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "정보형" | "비교형" | "결정형">("all");

  const classified = useMemo(
    () => nicheQueries.map((q) => ({ query: q, type: classifyQuery(q) })),
    [nicheQueries],
  );

  const visible = useMemo(() => {
    return classified.filter((c) => {
      const matchesText = filter
        ? c.query.toLowerCase().includes(filter.toLowerCase())
        : true;
      const matchesType = typeFilter === "all" ? true : c.type === typeFilter;
      return matchesText && matchesType;
    });
  }, [classified, filter, typeFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { 정보형: 0, 비교형: 0, 결정형: 0 };
    classified.forEach((it) => {
      c[it.type] += 1;
    });
    return c;
  }, [classified]);

  function handleAdd(query: string) {
    onAddToTracking(query);
    setAddedSet((prev) => new Set(prev).add(query));
  }

  function handleAddAll() {
    visible.forEach((c) => {
      if (!addedSet.has(c.query) && !trackedPrompts.includes(c.query)) {
        handleAdd(c.query);
      }
    });
  }

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-semibold text-th-text">니치 탐색기</h2>
        <p className="mt-1 text-sm text-th-text-secondary">
          우리 비즈니스가 자리잡고 싶은 <strong>세부 니치</strong>를 입력하면, 실제 한국 사용자가
          AI에게 물어볼 만한 질문 12개를 자동 생성해 프롬프트 허브로 바로 추가할 수 있습니다.
        </p>
      </header>

      {/* 사용법 */}
      <details className="rounded-lg border border-th-border bg-th-card-alt p-3 text-sm">
        <summary className="cursor-pointer font-medium text-th-text">
          사용법 — 3단계
        </summary>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-th-text-secondary">
          <li>타겟 니치를 한 줄로 구체화 (예: "국내 재활 필라테스 강사 자격증 과정")</li>
          <li><strong>쿼리 생성</strong> 클릭 → AI가 정보형/비교형/결정형 질문을 고르게 뽑아냅니다.</li>
          <li>원하는 질문을 개별 또는 <strong>전체 추적</strong>으로 프롬프트 허브에 추가 → 허브에서 실제 조사 실행.</li>
        </ol>
      </details>

      {/* 니치 입력 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
          타겟 니치
        </label>
        <div className="flex gap-2">
          <input
            value={niche}
            onChange={(e) => onNicheChange(e.target.value)}
            className="bd-input flex-1 rounded-lg p-2.5 text-sm"
            placeholder="예: 국내 재활 필라테스 강사 자격증 과정"
          />
          <button
            onClick={onGenerateQueries}
            disabled={busy || !niche.trim()}
            className="bd-btn-primary shrink-0 rounded-lg px-4 py-2.5 text-sm disabled:opacity-50"
            title="입력한 니치를 기반으로 AI가 한국어 질문 12개를 생성합니다"
          >
            {busy ? "생성 중..." : "쿼리 생성"}
          </button>
        </div>
        <p className="mt-2 text-xs text-th-text-muted">
          팁: 지역(국내/서울), 대상(강사/수강생/치료사), 단계(자격증/심화/온라인) 을 함께 명시하면 더 정교한 질문이 나옵니다.
        </p>
      </div>

      {/* 결과 */}
      <div className="rounded-xl border border-th-border bg-th-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-th-text">고의도 프롬프트 뱅크</div>
            {nicheQueries.length > 0 && (
              <div className="mt-1 text-xs text-th-text-muted">
                총 {nicheQueries.length}개 · 정보형 {counts.정보형} · 비교형 {counts.비교형} · 결정형 {counts.결정형}
              </div>
            )}
          </div>
          {visible.length > 0 && (
            <button
              onClick={handleAddAll}
              className="bd-btn-primary rounded-lg px-3 py-1.5 text-xs"
              title="현재 필터에 보이는 질문을 모두 프롬프트 허브에 추가"
            >
              + 보이는 전체 추적
            </button>
          )}
        </div>

        {nicheQueries.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="검색..."
              className="bd-input w-40 rounded-lg p-2 text-xs"
            />
            {(["all", "정보형", "비교형", "결정형"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  typeFilter === t
                    ? "border-th-accent bg-th-accent-soft text-th-text-accent font-medium"
                    : "border-th-border bg-th-card-alt text-th-text-muted hover:bg-th-card-hover"
                }`}
              >
                {t === "all" ? "전체" : t}
              </button>
            ))}
          </div>
        )}

        {nicheQueries.length === 0 && !busy && (
          <p className="text-sm text-th-text-secondary">
            아직 생성된 프롬프트가 없습니다. 위에서 니치를 설정하고 <strong>쿼리 생성</strong>을 눌러보세요.
          </p>
        )}
        {busy && nicheQueries.length === 0 && (
          <p className="text-sm text-th-text-muted">AI가 한국어 질문을 생성하는 중입니다... (약 5-15초)</p>
        )}
        {nicheQueries.length > 0 && visible.length === 0 && (
          <p className="text-sm text-th-text-muted">필터와 일치하는 질문이 없습니다.</p>
        )}

        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {visible.map(({ query, type }) => {
            const alreadyTracked =
              addedSet.has(query) || trackedPrompts.includes(query);
            return (
              <li
                key={query}
                className="flex items-start gap-2 rounded-lg border border-th-border bg-th-card-alt p-3"
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <span
                    className={`inline-block w-fit rounded-full border px-2 py-0.5 text-[10px] font-medium ${TYPE_STYLES[type]}`}
                  >
                    {type}
                  </span>
                  <span className="text-th-text-secondary">{query}</span>
                </div>
                <button
                  onClick={() => handleAdd(query)}
                  disabled={alreadyTracked}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    alreadyTracked
                      ? "bg-th-success-soft text-th-success cursor-default"
                      : "bd-btn-primary"
                  }`}
                  title={alreadyTracked ? "이미 추적 라이브러리에 있음" : "프롬프트 허브 추적 라이브러리에 추가"}
                >
                  {alreadyTracked ? "✓ 추적 중" : "+ 추적"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
