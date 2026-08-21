import { describe, it, expect } from "vitest";
import { sliceRunsByKstRange, buildTrendSeries } from "./visibility-analytics-derive";

describe("sliceRunsByKstRange — CSV 구간 자르기(M2)", () => {
  const runs = [
    { createdAt: "2026-06-25T23:59:00.000Z" }, // KST 6/26 08:59 → 포함
    { createdAt: "2026-06-25T14:00:00.000Z" }, // KST 6/25 23:00 → 제외
    { createdAt: "2026-07-15T00:00:00.000Z" }, // KST 7/15 → 포함
    { createdAt: "2026-07-31T14:59:00.000Z" }, // KST 7/31 23:59 → 포함
    { createdAt: "2026-07-31T15:00:00.000Z" }, // KST 8/1 00:00 → 제외
    { createdAt: "2026-08-10T00:00:00.000Z" }, // 구간 밖 → 제외
  ];

  it("선택 구간(6/26~7/31) 밖의 행은 빠진다", () => {
    const out = sliceRunsByKstRange(runs, "2026-06-26", "2026-07-31");
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.createdAt)).toEqual([
      "2026-06-25T23:59:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-07-31T14:59:00.000Z",
    ]);
  });

  it("경계는 KST 일자 기준으로 양끝 포함 — UTC 자르기와 결과가 다르다", () => {
    // UTC 로 잘랐다면 6/25 로 읽혀 빠졌을 행이 KST 기준으로는 6/26 이라 포함된다.
    expect(sliceRunsByKstRange(runs, "2026-06-26", "2026-06-26")).toHaveLength(1);
    // KST 8/1 로 넘어간 행은 7/31 구간에 들어오지 않는다.
    expect(sliceRunsByKstRange(runs, "2026-08-01", "2026-08-01")).toEqual([
      { createdAt: "2026-07-31T15:00:00.000Z" },
    ]);
  });

  it("하루짜리 구간·빈 구간도 안전", () => {
    expect(sliceRunsByKstRange(runs, "2026-09-01", "2026-09-30")).toEqual([]);
    expect(sliceRunsByKstRange([], "2026-06-26", "2026-07-31")).toEqual([]);
  });
});

describe("buildTrendSeries — 빈 날 선 끊기(m7)", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];
  const totals = [
    { date: "2026-08-01", avgVisibility: 40, avgVisibilityRaw: 40.4 },
    { date: "2026-08-04", avgVisibility: 60, avgVisibilityRaw: 59.6 },
  ];

  it("실행이 없는 날은 null — 0 으로 채우지 않는다", () => {
    expect(buildTrendSeries(days, totals)).toEqual([
      { day: "2026-08-01", visibility: 40 },
      { day: "2026-08-02", visibility: null },
      { day: "2026-08-03", visibility: null },
      { day: "2026-08-04", visibility: 60 },
    ]);
  });

  it("축 길이는 모델별 차트와 같은 timeseries.days 를 따른다", () => {
    expect(buildTrendSeries(days, totals)).toHaveLength(days.length);
  });

  it("days 가 없으면 값이 있는 날만 오름차순", () => {
    expect(buildTrendSeries(undefined, [...totals].reverse())).toEqual([
      { day: "2026-08-01", visibility: 40 },
      { day: "2026-08-04", visibility: 60 },
    ]);
  });

  it("avgVisibilityRaw 를 반올림해 쓴다(없으면 avgVisibility)", () => {
    expect(buildTrendSeries(["d"], [{ date: "d", avgVisibility: 7 }])).toEqual([
      { day: "d", visibility: 7 },
    ]);
  });
});
