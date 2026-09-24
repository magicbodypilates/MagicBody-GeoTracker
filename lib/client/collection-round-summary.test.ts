/**
 * collection-round-summary.test.ts — 자동 조사 탭 "진행 한 줄" 문구 (계획 geotracker-collect-speed-260924 §10).
 */

import { describe, it, expect } from "vitest";
import {
  formatRoundLine,
  pickRoundForSchedule,
  reasonLabel,
  type RoundOverviewLite,
} from "./collection-round-summary";

const label = (p: string) => ({ perplexity: "Perplexity", chatgpt: "ChatGPT" })[p] ?? p;

function round(o: Partial<RoundOverviewLite>): RoundOverviewLite {
  return {
    id: "r",
    scheduleId: "s1",
    status: "running",
    expected: 88,
    createdAt: "2030-01-01T00:00:00Z",
    counts: {},
    topErrors: [],
    ...o,
  };
}

describe("reasonLabel — 원인 코드는 쉬운 말로만", () => {
  it.each([
    ["CRAWLER_AUTH_WALL", "상대 사이트가 가입 화면으로 막음"],
    ["CRAWLER_BROWSER_DISCONNECTED", "수집 브라우저 끊김"],
    ["CRAWLER_SELECTOR_TIMEOUT", "수집 오류"],
    ["CRAWLER_ERROR", "수집 오류"],
    ["TIMEOUT", "응답 지연"],
    ["PARSE_FAILURE", "응답 형식 이상"],
    ["SNAPSHOT_FAILED", "수집 실패"],
    ["SNAPSHOT_MISSING", "수집 실패"],
    ["SNAPSHOT_CANCELED", "수집 실패"],
    ["RATE_LIMITED", "요청 전송 실패"],
    ["SUBMIT_UNKNOWN", "요청 전송 실패"],
    ["SUBMIT_FAILED", "요청 전송 실패"],
    ["PERSIST_FAILED", "기타"],
    ["WHATEVER", "기타"],
  ])("%s → %s", (code, text) => expect(reasonLabel(code)).toBe(text));
});

describe("formatRoundLine", () => {
  it("진행 중 — 저장(저장+이미 모음)/예상 · 남음(대기+보내는 중+진행 중) · 빠짐", () => {
    const line = formatRoundLine(
      round({ counts: { saved: 38, duplicate: 2, queued: 30, submitting: 3, submitted: 12, failed: 2, cancelled: 1 } }),
      label,
    );
    expect(line).toBe("진행 중 · 저장 40/88 · 남음 45 · 빠짐 3");
  });

  it("진행 중이고 빠진 것이 없으면 빠짐을 쓰지 않는다", () => {
    expect(formatRoundLine(round({ counts: { saved: 4, queued: 84 } }), label)).toBe("진행 중 · 저장 4/88 · 남음 84");
  });

  it("지난 회차 — 빠진 원인을 AI 이름과 쉬운 말로", () => {
    const line = formatRoundLine(
      round({
        status: "completed",
        counts: { saved: 85, failed: 3 },
        topErrors: [{ provider: "perplexity", code: "CRAWLER_AUTH_WALL", count: 3 }],
      }),
      label,
    );
    expect(line).toBe("지난 회차 · 저장 85/88 (빠짐: Perplexity 3 — 상대 사이트가 가입 화면으로 막음)");
  });

  it("지난 회차 — 원인은 많은 순 2개까지 + 취소 수", () => {
    const line = formatRoundLine(
      round({
        status: "completed",
        counts: { saved: 80, failed: 6, cancelled: 2 },
        topErrors: [
          { provider: "chatgpt", code: "TIMEOUT", count: 1 },
          { provider: "perplexity", code: "CRAWLER_AUTH_WALL", count: 4 },
          { provider: "perplexity", code: "TIMEOUT", count: 1 },
        ],
      }),
      label,
    );
    expect(line).toBe(
      "지난 회차 · 저장 80/88 (빠짐: Perplexity 4 — 상대 사이트가 가입 화면으로 막음 · ChatGPT 1 — 응답 지연 · 취소 2)",
    );
  });

  it("지난 회차 — 빠진 것이 없으면 저장 수만", () => {
    expect(formatRoundLine(round({ status: "completed", counts: { saved: 88 } }), label)).toBe("지난 회차 · 저장 88/88");
  });
});

describe("pickRoundForSchedule", () => {
  const rounds: RoundOverviewLite[] = [
    round({ id: "old", status: "completed", createdAt: "2030-01-01T00:00:00Z" }),
    round({ id: "skip", status: "skipped_overlap", createdAt: "2030-01-01T06:00:00Z" }),
    round({ id: "newer", status: "completed", createdAt: "2030-01-01T05:00:00Z" }),
    round({ id: "other", scheduleId: "s2", status: "running", createdAt: "2030-01-01T07:00:00Z" }),
  ];
  it("진행 중이 없으면 가장 최근에 끝난 회차 (겹침 표시 행 제외)", () => {
    expect(pickRoundForSchedule(rounds, "s1")?.id).toBe("newer");
  });
  it("진행 중이 있으면 그것", () => {
    const withRunning = [...rounds, round({ id: "live", status: "running", createdAt: "2030-01-01T03:00:00Z" })];
    expect(pickRoundForSchedule(withRunning, "s1")?.id).toBe("live");
  });
  it("회차가 없으면 null", () => {
    expect(pickRoundForSchedule(rounds, "none")).toBeNull();
  });
});
