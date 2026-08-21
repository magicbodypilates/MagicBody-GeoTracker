/**
 * home-failure-policy.test.ts — 홈 화면 부분 실패 정책 회귀 방지.
 *
 * 고정하는 것 세 가지 (검수 지적 MAJOR — 폴링 실패 시 홈 전체가 사라지던 문제):
 *   1) 같은 조회 조건의 갱신 실패 → 직전 값을 유지한다("갱신 실패"만 표시).
 *   2) 조회 조건이 바뀐 요청의 실패 → 값을 비운다(이전 구간 숫자가 새 구간 값처럼 보이면 안 된다).
 *   3) summary 만 실패해도 나머지 카드가 있으면 홈 본문은 계속 그린다.
 */

import { describe, it, expect } from "vitest";
import {
  applyWindowResult,
  buildScopeKey,
  cardLabels,
  failureOutcome,
  shouldShowHomeBody,
} from "./home-failure-policy";

const BASE = { days: 30, customRange: null, autoOnly: true, brandedView: false };

describe("조회 조건 키", () => {
  it("같은 프리셋을 다시 읽으면 키가 같다 (5분 폴링)", () => {
    expect(buildScopeKey(BASE)).toBe(buildScopeKey({ ...BASE }));
  });

  it("프리셋 일수가 바뀌면 키가 달라진다", () => {
    expect(buildScopeKey({ ...BASE, days: 7 })).not.toBe(buildScopeKey(BASE));
  });

  it("직접 선택 구간이 바뀌면 키가 달라진다", () => {
    const a = buildScopeKey({ ...BASE, customRange: { from: "2026-08-01", to: "2026-08-03" } });
    const b = buildScopeKey({ ...BASE, customRange: { from: "2026-08-01", to: "2026-08-04" } });
    expect(a).not.toBe(b);
  });

  it("구간이 같아도 데이터 소스 토글이 바뀌면 다른 조회로 본다", () => {
    expect(buildScopeKey({ ...BASE, brandedView: true })).not.toBe(buildScopeKey(BASE));
    expect(buildScopeKey({ ...BASE, autoOnly: false })).not.toBe(buildScopeKey(BASE));
  });
});

describe("실패 처리", () => {
  it("① 같은 구간의 갱신 실패 — 직전 값을 유지한다", () => {
    expect(failureOutcome(true)).toEqual({ kind: "stale", clearValue: false });
  });

  it("② 구간이 바뀐 조회의 실패 — 값을 비운다", () => {
    expect(failureOutcome(false)).toEqual({ kind: "cleared", clearValue: true });
  });
});

describe("③ 본문 표시", () => {
  it("summary 만 실패해도 다른 카드에 값이 있으면 본문을 그린다", () => {
    expect(
      shouldShowHomeBody({ hasData: false, summaryFailed: true, hasAnyCardData: true }),
    ).toBe(true);
  });

  it("표본이 있으면 언제나 그린다", () => {
    expect(
      shouldShowHomeBody({ hasData: true, summaryFailed: false, hasAnyCardData: false }),
    ).toBe(true);
  });

  it("표본도 없고 실패도 아니면 안내 화면만 남긴다", () => {
    expect(
      shouldShowHomeBody({ hasData: false, summaryFailed: false, hasAnyCardData: true }),
    ).toBe(false);
  });

  it("summary 가 실패했는데 다른 카드도 비어 있으면 그릴 것이 없다", () => {
    expect(
      shouldShowHomeBody({ hasData: false, summaryFailed: true, hasAnyCardData: false }),
    ).toBe(false);
  });
});

describe("실패 안내 문구", () => {
  it("내부 영문 키가 아니라 한국어 카드 이름을 보여준다", () => {
    expect(cardLabels(["summary", "timeseries"])).toBe("요약 지표, 가시성 추이");
  });

  it("이름을 모르는 키는 그대로 둔다 (안내가 사라지지 않게)", () => {
    expect(cardLabels(["unknown_card"])).toBe("unknown_card");
  });
});

/**
 * 실제 조회 반영 경로(applyWindowResult) 로 장애 상황을 재현한다.
 * 홈 컴포넌트가 창구마다 부르는 바로 그 함수라, 규칙만이 아니라 배선까지 함께 고정된다.
 */
describe("장애 재현 — 창구 하나가 실패했을 때", () => {
  /** 창구 9개의 화면 상태를 흉내 낸 저장소 */
  function makeStore() {
    const state: Record<string, unknown> = {};
    return {
      state,
      setter: (key: string) => (v: unknown) => {
        state[key] = v;
      },
    };
  }

  const ok = (body: unknown) =>
    ({ status: "fulfilled", value: { ok: true, json: async () => body } }) as const;
  const httpFail = { status: "fulfilled", value: { ok: false, json: async () => ({}) } } as const;
  const netFail = { status: "rejected", reason: new Error("network") } as const;

  const scope = { days: 30, customRange: null, autoOnly: true, brandedView: false };

  it("① 같은 구간에서 summary 만 실패 — 직전 값이 그대로 남고 홈은 사라지지 않는다", async () => {
    const store = makeStore();
    const key = buildScopeKey(scope);

    // 1차 조회 성공
    await applyWindowResult(ok({ current: { sampleCount: 12 } }), false, store.setter("summary"));
    await applyWindowResult(ok({ days: ["2026-08-01"] }), false, store.setter("timeseries"));
    expect(store.state.summary).toEqual({ current: { sampleCount: 12 } });

    // 5분 뒤 폴링 — 같은 구간인데 summary 창구만 실패(순단·401·재기동)
    const sameScope = buildScopeKey(scope) === key;
    const kind = await applyWindowResult(netFail, sameScope, store.setter("summary"));

    expect(kind).toBe("stale");
    expect(store.state.summary).toEqual({ current: { sampleCount: 12 } }); // 지워지지 않았다
    expect(
      shouldShowHomeBody({
        hasData: true, // 직전 표본이 유지되므로 여전히 참
        summaryFailed: true,
        hasAnyCardData: true,
      }),
    ).toBe(true);
  });

  it("② 구간을 바꾼 조회에서 실패 — 값이 비워진다", async () => {
    const store = makeStore();
    await applyWindowResult(ok({ current: { sampleCount: 12 } }), false, store.setter("summary"));

    // 7일 프리셋으로 변경 → 조회 조건 키가 달라진다
    const sameScope = buildScopeKey({ ...scope, days: 7 }) === buildScopeKey(scope);
    expect(sameScope).toBe(false);

    const kind = await applyWindowResult(httpFail, sameScope, store.setter("summary"));
    expect(kind).toBe("cleared");
    expect(store.state.summary).toBeNull(); // 이전 구간 숫자를 새 구간 값처럼 남기지 않는다
  });

  it("③ summary 만 실패해도 나머지 카드는 계속 보인다", async () => {
    const store = makeStore();

    // 구간이 바뀐 첫 조회에서 summary 만 실패, 나머지는 성공
    await applyWindowResult(httpFail, false, store.setter("summary"));
    await applyWindowResult(ok({ days: ["2026-08-01"] }), false, store.setter("timeseries"));
    await applyWindowResult(ok({ top: [], bottom: [], total: 0 }), false, store.setter("ranking"));

    expect(store.state.summary).toBeNull();
    expect(store.state.timeseries).not.toBeNull();

    const hasAnyCardData = Boolean(store.state.timeseries || store.state.ranking);
    expect(
      shouldShowHomeBody({ hasData: false, summaryFailed: true, hasAnyCardData }),
    ).toBe(true);
  });
});
