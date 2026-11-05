/**
 * citation-period.test.ts — 인용 출처 라우트 공통 기간·AI 모델 파라미터 (2026-11-05).
 */

import { describe, it, expect } from "vitest";
import {
  isCitationParamError,
  parseCitationPeriod,
  parseNewOnly,
  parseProviderParam,
} from "./citation-period";

const NOW = new Date("2026-11-05T12:00:00.000Z"); // KST 2026-11-05 21:00
const sp = (q: string) => new URLSearchParams(q);

describe("parseCitationPeriod", () => {
  it("파라미터 없음 → 전체 기간(지금 - 상한 ~ 지금) · allTime", () => {
    const p = parseCitationPeriod(sp(""), { maxLookbackDays: 730, now: NOW });
    expect(isCitationParamError(p)).toBe(false);
    if (isCitationParamError(p)) return;
    expect(p.allTime).toBe(true);
    expect(p.to.getTime()).toBe(NOW.getTime());
    expect(NOW.getTime() - p.from.getTime()).toBe(730 * 86400000);
  });

  it("from/to → KST 자정 경계 (종료일 포함 = 다음 날 00:00 KST 미만)", () => {
    const p = parseCitationPeriod(sp("from=2026-10-07&to=2026-11-05"), { maxLookbackDays: 730, now: NOW });
    if (isCitationParamError(p)) throw new Error(p.error);
    expect(p.allTime).toBe(false);
    expect(p.from.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-11-05T15:00:00.000Z");
    expect(p.fromDate).toBe("2026-10-07");
  });

  it("하나만 오거나 형식이 틀리거나 상한을 넘으면 오류", () => {
    expect(isCitationParamError(parseCitationPeriod(sp("from=2026-10-07"), { maxLookbackDays: 730, now: NOW }))).toBe(true);
    expect(isCitationParamError(parseCitationPeriod(sp("from=x&to=y"), { maxLookbackDays: 730, now: NOW }))).toBe(true);
    expect(isCitationParamError(parseCitationPeriod(sp("from=2020-01-01&to=2026-11-05"), { maxLookbackDays: 730, now: NOW }))).toBe(true);
  });
});

describe("parseProviderParam · parseNewOnly", () => {
  it("없음·all → 전체(null), 알려진 모델 → 그대로, 모르는 값 → 오류", () => {
    expect(parseProviderParam(sp(""))).toEqual({ provider: null });
    expect(parseProviderParam(sp("provider=all"))).toEqual({ provider: null });
    expect(parseProviderParam(sp("provider=google_ai"))).toEqual({ provider: "google_ai" });
    expect(isCitationParamError(parseProviderParam(sp("provider=foo';drop")))).toBe(true);
  });
  it("newOnly=true 만 참", () => {
    expect(parseNewOnly(sp("newOnly=true"))).toBe(true);
    expect(parseNewOnly(sp("newOnly=1"))).toBe(false);
    expect(parseNewOnly(sp(""))).toBe(false);
  });
});
