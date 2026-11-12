import { describe, it, expect } from "vitest";
import {
  normalizePageViewStats,
  normalizePageClickStats,
  normalizeDeviceRows,
  normalizeDeviceVisits,
  safeDeviceCount,
} from "./page-analytics-normalize";

describe("기기 칸 개수", () => {
  it("없음·음수·숫자 아님 → null, 숫자 문자열은 받는다", () => {
    expect(safeDeviceCount(undefined)).toBeNull();
    expect(safeDeviceCount(null)).toBeNull();
    expect(safeDeviceCount(-1)).toBeNull();
    expect(safeDeviceCount("abc")).toBeNull();
    expect(safeDeviceCount("")).toBeNull();
    expect(safeDeviceCount(true)).toBeNull();
    expect(safeDeviceCount(Number.NaN)).toBeNull();
    expect(safeDeviceCount("12")).toBe(12);
    expect(safeDeviceCount(0)).toBe(0);
    expect(safeDeviceCount(7)).toBe(7);
  });
});

describe("normalizeDeviceRows", () => {
  it("배열이 아니면 null(서버가 칸을 안 줌)", () => {
    expect(normalizeDeviceRows(undefined)).toBeNull();
    expect(normalizeDeviceRows(null)).toBeNull();
    expect(normalizeDeviceRows({})).toBeNull();
  });
  it("모르는 코드는 버리고 m·t·d·x·- 순서로", () => {
    const out = normalizeDeviceRows([
      { device: "-", visitCount: 3, viewCount: 4 },
      { device: "d", visitCount: 10, viewCount: 20 },
      { device: "zz", visitCount: 1, viewCount: 1 },
      { device: "M", visitCount: 30, viewCount: 50 },
    ]);
    expect(out).toEqual([
      { device: "m", visitCount: 30, viewCount: 50 },
      { device: "d", visitCount: 10, viewCount: 20 },
      { device: "-", visitCount: 3, viewCount: 4 },
    ]);
  });
  it("잘못된 개수는 null 로 남긴다", () => {
    expect(normalizeDeviceRows([{ device: "m", visitCount: -5, viewCount: "x" }])).toEqual([
      { device: "m", visitCount: null, viewCount: null },
    ]);
  });
});

describe("normalizeDeviceVisits", () => {
  it("객체가 아니면 null", () => {
    expect(normalizeDeviceVisits(undefined)).toBeNull();
    expect(normalizeDeviceVisits([])).toBeNull();
  });
  it("다섯 칸", () => {
    expect(normalizeDeviceVisits({ m: 5, t: "1", d: 2, x: -1 })).toEqual({ m: 5, t: 1, d: 2, x: null, none: null });
  });
});

describe("페이지 통계 정규화 — 기기 칸", () => {
  it("예전 응답(기기 칸 없음) → devices·deviceVisits 가 null", () => {
    const out = normalizePageViewStats({ dataSource: "detail", pages: [{ routeName: "home", viewCount: 1, visitCount: 1 }] });
    expect(out.devices).toBeNull();
    expect(out.pages[0].deviceVisits).toBeNull();
  });
  it("새 응답 → 값이 그대로", () => {
    const out = normalizePageViewStats({
      dataSource: "rollup",
      devices: [{ device: "m", visitCount: 8, viewCount: 9 }],
      pages: [{ routeName: "home", viewCount: 9, visitCount: 8, deviceVisits: { m: 8, t: 0, d: 0, x: 0, none: 0 } }],
    });
    expect(out.devices).toEqual([{ device: "m", visitCount: 8, viewCount: 9 }]);
    expect(out.pages[0].deviceVisits).toEqual({ m: 8, t: 0, d: 0, x: 0, none: 0 });
  });
});

describe("클릭 통계 정규화 — 기기 칸", () => {
  const items = [{ clickTarget: "rc_sec_a", clickKind: "marker", clickCount: 3, clickVisitCount: 2 }];
  it("상세 구간 + 서버가 줌 → 항목 기기 쓸 수 있음", () => {
    const out = normalizePageClickStats({
      dataSource: "detail",
      items,
      devices: [{ device: "m", visitCount: 4, viewCount: 6 }],
      itemDevices: [
        { clickTarget: "rc_sec_a", clickKind: "marker", device: "m", clickedVisitCount: 2, clickCount: 3 },
        { clickTarget: "", clickKind: "marker", device: "m", clickedVisitCount: 1, clickCount: 1 },
        { clickTarget: "rc_sec_a", clickKind: "marker", device: "q", clickedVisitCount: 1, clickCount: 1 },
      ],
      itemDevicesAvailable: true,
    });
    expect(out.itemDevicesAvailable).toBe(true);
    expect(out.itemDevices).toEqual([
      { clickTarget: "rc_sec_a", clickKind: "marker", device: "m", clickedVisitCount: 2, clickCount: 3 },
    ]);
    expect(out.devices).toEqual([{ device: "m", visitCount: 4, viewCount: 6 }]);
  });
  it("요약 구간이면 항목 기기를 버린다(서버가 실수로 줘도)", () => {
    const out = normalizePageClickStats({
      dataSource: "rollup",
      items,
      itemDevices: [{ clickTarget: "rc_sec_a", clickKind: "marker", device: "m", clickedVisitCount: 2, clickCount: 3 }],
      itemDevicesAvailable: true,
    });
    expect(out.itemDevices).toBeNull();
    expect(out.itemDevicesAvailable).toBe(false);
  });
  it("예전 응답 → 기기 칸 모두 비어 있음", () => {
    const out = normalizePageClickStats({ dataSource: "detail", items });
    expect(out.devices).toBeNull();
    expect(out.itemDevices).toBeNull();
    expect(out.itemDevicesAvailable).toBe(false);
  });
});
