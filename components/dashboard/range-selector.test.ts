/**
 * range-selector.test.ts — "직접 선택" 입력 검증 규칙 고정.
 * 화면이 잘못된 입력으로 조회를 보내지 않는지(=서버 400 을 사전 차단) 확인한다.
 */

import { describe, it, expect } from "vitest";
import { validateCustomRange, CUSTOM_RANGE_MAX_DAYS } from "./range-selector";

const TODAY = "2026-08-21";

describe("validateCustomRange", () => {
  it("정상 구간은 통과", () => {
    expect(validateCustomRange("2026-08-01", "2026-08-11", TODAY)).toBeNull();
    expect(validateCustomRange(TODAY, TODAY, TODAY)).toBeNull();
  });

  it("비어 있거나 형식이 틀리면 안내", () => {
    expect(validateCustomRange("", "2026-08-11", TODAY)).toContain("선택");
    expect(validateCustomRange("2026-8-1", "2026-08-11", TODAY)).toContain("선택");
  });

  it("역전은 안내", () => {
    expect(validateCustomRange("2026-08-11", "2026-08-01", TODAY)).toContain("늦습니다");
  });

  it("미래 종료일은 안내", () => {
    expect(validateCustomRange("2026-08-01", "2026-08-22", TODAY)).toContain("오늘 이후");
  });

  it(`${CUSTOM_RANGE_MAX_DAYS}일 초과는 안내, 정확히 상한이면 통과`, () => {
    expect(validateCustomRange("2024-01-01", "2025-12-30", TODAY)).toBeNull(); // 730일
    expect(validateCustomRange("2024-01-01", "2025-12-31", TODAY)).toContain("최대");
  });
});
