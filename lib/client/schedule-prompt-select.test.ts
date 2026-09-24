/**
 * schedule-prompt-select.test.ts — 편집 패널 진입 시 "선택 N/M" 표시가 실제 체크 상태와
 * 일치하는지의 근거가 되는 순수 규칙 계약.
 *
 * 재현 대상 결함: 유령 ID(삭제된 프롬프트)가 스케줄의 promptIds 에 섞여 있으면, 필터링
 * 없이 그대로 세팅한 선택 상태의 크기가 실제 렌더링되는 체크박스 수보다 커진다 — 운영에서
 * "선택 3/5"인데 실제 체크는 2개뿐인 사례로 재현됨(검수 스크린샷 review-03).
 */

import { describe, it, expect } from "vitest";
import { filterToActivePromptIds } from "./schedule-prompt-select";

describe("filterToActivePromptIds", () => {
  it("존재하지 않는(삭제된) 프롬프트 ID — 유령 ID — 는 걸러진다", () => {
    const prompts = [
      { id: "p1", active: true },
      { id: "p2", active: true },
    ];
    const result = filterToActivePromptIds(["p1", "ghost-id", "p2"], prompts);
    expect(result).toEqual(["p1", "p2"]);
  });

  it("존재는 하지만 비활성화된 프롬프트 ID 도 걸러진다 — 체크리스트에 렌더링되지 않으므로", () => {
    const prompts = [
      { id: "p1", active: true },
      { id: "p2", active: false },
    ];
    const result = filterToActivePromptIds(["p1", "p2"], prompts);
    expect(result).toEqual(["p1"]);
  });

  it("전부 유효하면 그대로(순서 유지) 반환된다", () => {
    const prompts = [
      { id: "p1", active: true },
      { id: "p2", active: true },
      { id: "p3", active: true },
    ];
    expect(filterToActivePromptIds(["p3", "p1"], prompts)).toEqual(["p3", "p1"]);
  });

  it("빈 선택은 빈 배열 그대로", () => {
    expect(filterToActivePromptIds([], [{ id: "p1", active: true }])).toEqual([]);
  });

  it("서버 프롬프트 목록 자체가 비어 있으면 전부 걸러진다(로드 전 호출 방어)", () => {
    expect(filterToActivePromptIds(["p1", "p2"], [])).toEqual([]);
  });
});
