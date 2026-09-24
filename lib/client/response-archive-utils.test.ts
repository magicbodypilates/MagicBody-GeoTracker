/**
 * response-archive-utils.test.ts — 보관 화면 문구·표시 (계획 geotracker-response-archive-260924 §5-3 · §6-1).
 * ⚠️ PUBLIC 저장소 — 문구는 가짜 값이다.
 */

import { describe, it, expect } from "vitest";
import {
  archiveDoneMessage,
  buildArchiveConfirm,
  buildBulkArchiveConfirm,
  buildPurgeConfirm,
  formatArchivePeriod,
  formatArchiveRunCounts,
  purgeDoneMessage,
  readdRestoredMessage,
  restoreDoneMessage,
  shortPromptLabel,
  splitTrackedGroups,
} from "./response-archive-utils";

describe("확인 창 문구", () => {
  it("보관(1개) — 문구 40자 + 빈 줄 + 계획의 세 줄", () => {
    const text = "가".repeat(45);
    expect(buildArchiveConfirm(text)).toBe(
      [
        `'${"가".repeat(40)}…'`,
        "",
        "이 질문의 응답을 모두 보관함으로 옮길까요? (자동·수동, 기간 구분 없이 전부)",
        "옮긴 응답은 AI 응답 목록과 홈·가시성·인용 통계에서 빠집니다.",
        "보관함에서 언제든 되돌릴 수 있습니다.",
      ].join("\n"),
    );
  });

  it("모두 보관 — 전체 질문·응답 수와 기준 시각 안내", () => {
    const msg = buildBulkArchiveConfirm(250, 1234);
    expect(msg.split("\n")).toEqual([
      "질문 250개의 응답 1234건을 모두 보관함으로 옮길까요?",
      "화면에 다 보이지 않는 질문도 포함합니다. 이 목록을 불러온 뒤 새로 생긴 응답은 옮기지 않습니다.",
      "옮긴 응답은 AI 응답 목록과 홈·가시성·인용 통계에서 빠집니다.",
      "보관함에서 언제든 되돌릴 수 있습니다.",
    ]);
  });

  it("영구 삭제 — 건수가 있으면 건수, 없으면(AI 응답 탭) 「모두」", () => {
    expect(buildPurgeConfirm("가짜 질문", 12).split("\n")).toEqual([
      "'가짜 질문'",
      "",
      "이 질문의 응답 12건을 영구 삭제할까요?",
      "삭제하면 되돌릴 수 없습니다.",
    ]);
    expect(buildPurgeConfirm("가짜 질문").split("\n")[2]).toBe("이 질문의 응답을 모두 영구 삭제할까요?");
  });

  it("40자 이하 문구는 그대로 · 이모지 같은 긴 문자도 글자 단위로 자른다", () => {
    expect(shortPromptLabel("짧은 가짜 질문")).toBe("짧은 가짜 질문");
    expect(shortPromptLabel("😀".repeat(41))).toBe(`${"😀".repeat(40)}…`);
  });
});

describe("표시", () => {
  it("기간 — KST 날짜로, 같은 날이면 하루만, 범위 기호는 전각 물결표", () => {
    expect(formatArchivePeriod("2026-07-31T15:30:00.000000Z", "2026-09-20T01:00:00.123456Z")).toBe("2026-08-01 ～ 2026-09-20");
    expect(formatArchivePeriod("2026-09-20T01:00:00Z", "2026-09-20T05:00:00Z")).toBe("2026-09-20");
    expect(formatArchivePeriod("", "")).toBe("");
  });

  it("건수", () => {
    expect(formatArchiveRunCounts(12, 10, 2)).toBe("응답 12건 (자동 10 · 수동 2)");
  });

  it("목록 분리 — 문구 정확 일치(공백·대소문자 다르면 다른 질문)", () => {
    const groups = [{ prompt: "가짜 A" }, { prompt: "가짜 B" }, { prompt: "가짜 a " }, { prompt: "Fake" }];
    const r = splitTrackedGroups(groups, ["가짜 A", "fake"]);
    expect(r.tracked.map((g) => g.prompt)).toEqual(["가짜 A"]);
    expect(r.untracked.map((g) => g.prompt)).toEqual(["가짜 B", "가짜 a ", "Fake"]);
  });
});

describe("끝난 뒤 안내", () => {
  it("보관 · 건너뛴 문구가 있으면 한 문장 더", () => {
    expect(archiveDoneMessage(8)).toBe("응답 8건을 보관함으로 옮겼습니다.");
    expect(archiveDoneMessage(3, ["x", "y"])).toBe("응답 3건을 보관함으로 옮겼습니다. 질문 목록에 있는 질문 2개는 옮기지 않았습니다.");
  });

  it("되돌리기 · 영구 삭제 · 재추가", () => {
    expect(restoreDoneMessage(5)).toBe("응답 5건을 되돌렸습니다. 통계에 다시 들어갑니다.");
    expect(purgeDoneMessage(4)).toBe("응답 4건을 영구 삭제했습니다.");
    expect(readdRestoredMessage(7)).toBe("추적 프롬프트가 추가되었습니다. 보관함에 있던 이 질문의 응답 7건도 함께 되돌렸습니다.");
  });
});
