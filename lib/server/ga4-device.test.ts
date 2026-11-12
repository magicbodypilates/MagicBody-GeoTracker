import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./gsc-client", () => ({
  getAuthedClient: async () => {
    throw new Error("시험에서는 실제 구글에 붙지 않는다");
  },
}));

import {
  classifyGa4Error,
  normalizeGa4DeviceRows,
  fetchDeviceCategoryReport,
  resetGa4DeviceCacheForTest,
  Ga4DeadlineError,
} from "./ga4-device";

const row = (category: string, sessions: string, views: string) => ({
  dimensionValues: [{ value: category }],
  metricValues: [{ value: sessions }, { value: views }],
});

describe("classifyGa4Error", () => {
  it("invalid_grant — 응답 본문 형태 → not_connected", () => {
    const err = { response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } };
    expect(classifyGa4Error(err)).toMatchObject({ status: "not_connected", kind: "invalid_grant" });
  });
  it("invalid_grant — 메시지 형태 → not_connected", () => {
    expect(classifyGa4Error(new Error("invalid_grant"))).toMatchObject({ status: "not_connected", kind: "invalid_grant" });
  });
  it("토큰 없음(연결 전) → not_connected", () => {
    expect(classifyGa4Error(new Error("GSC 인증이 필요합니다. /api/gsc/auth 에서 최초 1회 승인을 진행하세요."))).toMatchObject({
      status: "not_connected",
      kind: "no_token",
    });
  });
  it("429 → unavailable(quota)", () => {
    expect(classifyGa4Error({ response: { status: 429 }, message: "Too Many Requests" })).toMatchObject({
      status: "unavailable",
      kind: "quota",
      httpStatus: 429,
    });
  });
  it("RESOURCE_EXHAUSTED 본문 → unavailable(quota)", () => {
    expect(
      classifyGa4Error({ code: 403, response: { status: 403, data: { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } } } }),
    ).toMatchObject({ status: "unavailable", kind: "quota" });
  });
  it("403(구글 권한) → unavailable(permission)", () => {
    expect(classifyGa4Error({ response: { status: 403, data: { error: { status: "PERMISSION_DENIED" } } } })).toMatchObject({
      status: "unavailable",
      kind: "permission",
    });
  });
  it("5xx → unavailable(upstream)", () => {
    expect(classifyGa4Error({ response: { status: 503 } })).toMatchObject({ status: "unavailable", kind: "upstream", httpStatus: 503 });
  });
  it("시간 초과 → unavailable(timeout)", () => {
    expect(classifyGa4Error(new Ga4DeadlineError())).toMatchObject({ status: "unavailable", kind: "timeout" });
    expect(classifyGa4Error({ code: "ETIMEDOUT", message: "socket hang up" })).toMatchObject({ kind: "timeout" });
  });
  it("모르는 오류 → unavailable(other)", () => {
    expect(classifyGa4Error("???")).toMatchObject({ status: "unavailable", kind: "other", httpStatus: null });
  });
});

describe("normalizeGa4DeviceRows", () => {
  it("다섯 분류의 이름과 순서", () => {
    const out = normalizeGa4DeviceRows([
      row("(not set)", "1", "1"),
      row("desktop", "30", "60"),
      row("smart tv", "2", "2"),
      row("tablet", "5", "9"),
      row("mobile", "70", "140"),
    ]);
    expect(out.map((r) => r.label)).toEqual(["모바일", "태블릿", "PC", "기타(TV)", "알 수 없음"]);
    expect(out[0]).toEqual({ category: "mobile", label: "모바일", sessions: 70, screenPageViews: 140 });
  });
  it("처음 보는 분류는 원래 이름으로", () => {
    const out = normalizeGa4DeviceRows([row("Wearable", "3", "4")]);
    expect(out).toEqual([{ category: "wearable", label: "기타(Wearable)", sessions: 3, screenPageViews: 4 }]);
  });
  it("빈 결과·null", () => {
    expect(normalizeGa4DeviceRows([])).toEqual([]);
    expect(normalizeGa4DeviceRows(null)).toEqual([]);
  });
  it("합계 0 과 숫자 문자열·잘못된 값", () => {
    const out = normalizeGa4DeviceRows([row("mobile", "0", "0"), row("desktop", "12", "abc")]);
    expect(out.find((r) => r.category === "mobile")).toMatchObject({ sessions: 0, screenPageViews: 0 });
    expect(out.find((r) => r.category === "desktop")).toMatchObject({ sessions: 12, screenPageViews: 0 });
  });
  it("같은 분류는 합친다", () => {
    const out = normalizeGa4DeviceRows([row("mobile", "1", "2"), row("Mobile", "3", "4")]);
    expect(out).toEqual([{ category: "mobile", label: "모바일", sessions: 4, screenPageViews: 6 }]);
  });
});

describe("fetchDeviceCategoryReport", () => {
  const params = { propertyId: "123", startDate: "2026-11-01", endDate: "2026-11-10" };
  beforeEach(() => resetGa4DeviceCacheForTest());

  it("성공 → ok, 같은 열쇠는 보관에서 꺼낸다", async () => {
    const runReport = vi.fn(async () => [row("mobile", "7", "9")]);
    const a = await fetchDeviceCategoryReport(params, { runReport, log: () => {} });
    const b = await fetchDeviceCategoryReport(params, { runReport, log: () => {} });
    expect(a).toMatchObject({ status: "ok", startDate: "2026-11-01", endDate: "2026-11-10", timeZone: "Asia/Seoul" });
    expect(b).toEqual(a);
    expect(runReport).toHaveBeenCalledTimes(1);
  });

  it("보관은 10분 — 지나면 다시 부른다", async () => {
    let t = 1_000_000;
    const runReport = vi.fn(async () => [row("mobile", "1", "1")]);
    await fetchDeviceCategoryReport(params, { runReport, now: () => t, log: () => {} });
    t += 10 * 60_000 + 1;
    await fetchDeviceCategoryReport(params, { runReport, now: () => t, log: () => {} });
    expect(runReport).toHaveBeenCalledTimes(2);
  });

  it("실패는 보관하지 않는다 — 다시 연결되면 바로 반영", async () => {
    const fail = vi.fn(async () => {
      throw { response: { status: 400, data: { error: "invalid_grant" } } };
    });
    const ok = vi.fn(async () => [row("desktop", "5", "5")]);
    expect(await fetchDeviceCategoryReport(params, { runReport: fail, log: () => {} })).toEqual({ status: "not_connected" });
    expect(await fetchDeviceCategoryReport(params, { runReport: ok, log: () => {} })).toMatchObject({ status: "ok" });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("같은 열쇠 동시 요청은 구글 호출 1회", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const runReport = vi.fn(async () => {
      await gate;
      return [row("mobile", "2", "2")];
    });
    const p1 = fetchDeviceCategoryReport(params, { runReport, log: () => {} });
    const p2 = fetchDeviceCategoryReport(params, { runReport, log: () => {} });
    release(null);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(runReport).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it("기한을 넘기면 unavailable 이고 취소 신호가 간다", async () => {
    let aborted = false;
    const runReport = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
    );
    const res = await fetchDeviceCategoryReport(params, { runReport, deadlineMs: 20, log: () => {} });
    expect(res).toEqual({ status: "unavailable" });
    expect(aborted).toBe(true);
  });

  it("서버 기록에는 분류 이름·상태만 — 구글 오류 원문은 없다", async () => {
    const lines: string[] = [];
    const secretText = "SECRET-GOOGLE-ERROR-BODY property 987654";
    const runReport = vi.fn(async () => {
      throw { response: { status: 500, data: { error: { message: secretText } } }, message: secretText };
    });
    const res = await fetchDeviceCategoryReport(params, { runReport, log: (l) => lines.push(l) });
    expect(res).toEqual({ status: "unavailable" });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(lines.join("\n")).toContain("kind=upstream");
  });
});
