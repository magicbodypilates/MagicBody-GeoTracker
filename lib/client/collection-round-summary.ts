/**
 * collection-round-summary.ts — 자동 조사 탭의 "진행 한 줄" 문구 (순수 함수).
 * 계획 geotracker-collect-speed-260924 §10 (Step 7).
 *
 * 사용자가 "추가해도 실행이 안 되는 것 같다"고 느낀 이유의 절반은 진행 상황이 안 보여서다.
 * 스케줄 줄마다 지금 회차 또는 지난 회차를 쉬운 말 한 줄로 보여 준다.
 *   진행 중 · 저장 40/88 · 남음 45 · 빠짐 3
 *   지난 회차 · 저장 85/88 (빠짐: Perplexity 3 — 상대 사이트가 가입 화면으로 막음)
 * 원인은 코드 대신 쉬운 말로만 보여 준다(요청 번호·원문 오류는 API 가 애초에 내보내지 않는다).
 */

/** 상태 API(GET /api/workspaces/:id/collection-rounds)가 돌려주는 회차 중 화면에 쓰는 칸. */
export type RoundOverviewLite = {
  id: string;
  scheduleId: string | null;
  status: string;
  expected: number;
  createdAt: string;
  counts: Partial<Record<"queued" | "submitting" | "submitted" | "saved" | "duplicate" | "failed" | "cancelled", number>>;
  topErrors: { provider: string; code: string; count: number }[];
};

/** 원인 코드 → 화면 문구 (계획 v2 §10 표). */
export function reasonLabel(code: string): string {
  switch (code) {
    case "CRAWLER_AUTH_WALL":
      return "상대 사이트가 가입 화면으로 막음";
    case "CRAWLER_BROWSER_DISCONNECTED":
      return "수집 브라우저 끊김";
    case "CRAWLER_SELECTOR_TIMEOUT":
    case "CRAWLER_ERROR":
      return "수집 오류";
    case "TIMEOUT":
      return "응답 지연";
    case "PARSE_FAILURE":
      return "응답 형식 이상";
    case "EMPTY_ANSWER":
      return "내용 없는 답";
    case "SNAPSHOT_FAILED":
    case "SNAPSHOT_MISSING":
    case "SNAPSHOT_CANCELED":
      return "수집 실패";
    case "RATE_LIMITED":
    case "SUBMIT_UNKNOWN":
    case "SUBMIT_FAILED":
      return "요청 전송 실패";
    default:
      return "기타";
  }
}

/** 스케줄의 회차 중 보여 줄 것 — 진행 중이 있으면 그것, 없으면 가장 최근에 끝난 회차(겹쳐서 건너뛴 표시 행은 제외). */
export function pickRoundForSchedule(
  rounds: RoundOverviewLite[],
  scheduleId: string,
): RoundOverviewLite | null {
  const mine = rounds
    .filter((r) => r.scheduleId === scheduleId && r.status !== "skipped_overlap")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return mine.find((r) => r.status === "running") ?? mine.find((r) => r.status === "completed") ?? null;
}

function n(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 회차 1개 → 한 줄. providerLabel 은 AI 이름을 화면 이름으로 바꾼다. */
export function formatRoundLine(round: RoundOverviewLite, providerLabel: (p: string) => string): string {
  const c = round.counts ?? {};
  const got = n(c.saved) + n(c.duplicate);
  const missing = n(c.failed) + n(c.cancelled);
  const pending = n(c.queued) + n(c.submitting) + n(c.submitted);

  if (round.status === "running") {
    return `진행 중 · 저장 ${got}/${round.expected} · 남음 ${pending}${missing > 0 ? ` · 빠짐 ${missing}` : ""}`;
  }

  const base = `지난 회차 · 저장 ${got}/${round.expected}`;
  if (missing === 0) return base;
  const parts = [...(round.topErrors ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((e) => `${providerLabel(e.provider)} ${e.count} — ${reasonLabel(e.code)}`);
  const cancelled = n(c.cancelled);
  if (cancelled > 0) parts.push(`취소 ${cancelled}`);
  return parts.length > 0 ? `${base} (빠짐: ${parts.join(" · ")})` : `${base} (빠짐 ${missing})`;
}
