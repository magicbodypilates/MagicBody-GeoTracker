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

const PERSONA_PLACEHOLDER =
  "재활 목적 수강생\n강사 자격증 준비생\n필라테스 스튜디오 원장\n초보 회원";

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
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-semibold text-th-text">페르소나 분화 (Fan-Out)</h2>
        <p className="mt-1 text-sm text-th-text-secondary">
          하나의 코어 프롬프트를 여러 사용자 페르소나 관점으로 확장해, 같은 질문이 다른 맥락에서 어떤 답을 받는지 비교합니다.
        </p>
      </header>

      <details className="rounded-lg border border-th-border bg-th-card-alt p-3 text-sm">
        <summary className="cursor-pointer font-medium text-th-text">사용법</summary>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-th-text-secondary">
          <li>왼쪽에 코어 프롬프트 입력 (예: "필라테스 강사 자격증 추천해줘").</li>
          <li>아래에 페르소나를 한 줄에 하나씩 입력.</li>
          <li><strong>분화 프롬프트 생성</strong> 클릭 → 오른쪽 큐에 페르소나별 변형 프롬프트가 쌓입니다.</li>
          <li>각 프롬프트의 <strong>실행</strong> 버튼으로 개별 조사, 또는 <strong>코어 실행</strong>으로 원본을 조사.</li>
        </ol>
      </details>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
              코어 프롬프트
            </label>
            <textarea
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              placeholder="예: 필라테스 강사 자격증 교육기관을 추천해줘."
              className="bd-input h-28 w-full rounded-lg p-2.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
              페르소나 목록 (한 줄에 하나)
            </label>
            <textarea
              value={personas}
              onChange={(e) => onPersonasChange(e.target.value)}
              className="bd-input h-32 w-full rounded-lg p-2.5 text-sm"
              placeholder={PERSONA_PLACEHOLDER}
            />
            <p className="mt-1 text-xs text-th-text-muted">
              팁: 수강생/강사/운영자/일반인 등 서로 다른 구매 여정·의도를 가진 역할을 섞어야 대비가 잘 드러납니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onGenerateFanout}
              disabled={busy}
              className="bd-btn-primary rounded-lg px-4 py-2.5 text-sm disabled:opacity-50"
            >
              분화 프롬프트 생성
            </button>
            <button
              disabled={busy || !prompt.trim()}
              onClick={() => onRunPrompt(prompt)}
              className="bd-chip rounded-lg px-4 py-2.5 text-sm disabled:opacity-50"
              title="코어 프롬프트 그대로 선택된 AI 모델들로 실행"
            >
              코어 프롬프트 실행
            </button>
          </div>
        </div>

        {/* Fan-out queue */}
        <div className="rounded-xl border border-th-border bg-th-card-alt p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-th-text">분화 큐</div>
            {fanoutPrompts.length > 0 && (
              <span className="text-xs text-th-text-muted">
                {fanoutPrompts.length}개
              </span>
            )}
          </div>
          {fanoutPrompts.length === 0 && (
            <p className="text-sm text-th-text-secondary">
              생성된 분화 프롬프트가 없습니다. 왼쪽에서 페르소나와 코어 프롬프트를 입력하고 생성을 눌러주세요.
            </p>
          )}
          <ul className="space-y-2 pr-1 text-sm">
            {fanoutPrompts.map((item, index) => (
              <li
                key={`${item}-${index}`}
                className="rounded-lg border border-th-border bg-th-card p-3"
              >
                <div className="mb-2 line-clamp-4 text-th-text-secondary">{item}</div>
                <button
                  onClick={() => onRunPrompt(item)}
                  disabled={busy}
                  className="bd-btn-primary rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  실행
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
