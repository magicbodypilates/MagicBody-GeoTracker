import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createGa4Loader,
  deviceVisitParts,
  ga4PanelState,
  ga4ViewFor,
  ga4RangeKey,
  mobileShare,
  ourDeviceSlices,
  pageVisitsForDevice,
  parseGa4Response,
  rowsForDevice,
  type DeviceRow,
  type Ga4Response,
  type Ga4View,
} from "./page-analytics-device";
import { DeviceCardView, GA4_STATE_TEXT } from "@/components/dashboard/tabs/page-analytics-device";
import { normalizePageViewStats } from "@/lib/server/page-analytics-normalize";

const devices: DeviceRow[] = [
  { device: "m", visitCount: 72, viewCount: 100 },
  { device: "t", visitCount: 3, viewCount: 4 },
  { device: "d", visitCount: 25, viewCount: 40 },
  { device: "-", visitCount: 50, viewCount: 60 },
];

describe("우리 통계 비율", () => {
  it("분모는 기기 정보가 있는 방문 — 정보 없음은 따로", () => {
    const r = ourDeviceSlices(devices);
    expect(r.complete).toBe(true);
    expect(r.knownVisits).toBe(100);
    expect(r.noneVisits).toBe(50);
    expect(r.slices.map((s) => [s.key, s.share])).toEqual([
      ["m", 0.72],
      ["t", 0.03],
      ["d", 0.25],
    ]);
  });
  it("기간 전체가 정보 없음이면 비율 없음", () => {
    const r = ourDeviceSlices([{ device: "-", visitCount: 9, viewCount: 9 }]);
    expect(r.knownVisits).toBe(0);
    expect(r.slices).toEqual([]);
  });
  it("화면 줄 모바일 비율과 펼침 한 줄", () => {
    expect(mobileShare({ m: 72, t: 3, d: 25, x: 0, none: 10 })).toBeCloseTo(0.72);
    expect(mobileShare({ m: 0, t: 0, d: 0, x: 0, none: 10 })).toBeNull();
    expect(mobileShare(null)).toBeNull();
    expect(deviceVisitParts(devices).map((p) => p.label)).toEqual(["모바일", "PC", "태블릿"]);
  });
});

describe("알 수 없는 개수(null)는 0 으로 바꾸지 않는다 (D5)", () => {
  it("모바일 칸을 모르면 모바일 비율은 —(0% 가 아니다)", () => {
    expect(mobileShare({ m: null, t: 0, d: 100, x: 0, none: 0 })).toBeNull();
    expect(mobileShare({ m: 5, t: null, d: 100, x: 0, none: 0 })).toBeNull();
  });
  it("한 기기라도 모르면 모든 비율이 null, 그 칸 개수도 null", () => {
    const r = ourDeviceSlices([
      { device: "m", visitCount: null, viewCount: 3 },
      { device: "d", visitCount: 40, viewCount: 50 },
    ]);
    expect(r.complete).toBe(false);
    expect(r.slices.find((s) => s.key === "m")).toMatchObject({ count: null, share: null });
    expect(r.slices.find((s) => s.key === "d")).toMatchObject({ count: 40, share: null });
    expect(deviceVisitParts([{ device: "m", visitCount: null, viewCount: 3 }, { device: "d", visitCount: 40, viewCount: 50 }])).toEqual([]);
  });
  it("정보 없음 개수를 모르면 null", () => {
    expect(ourDeviceSlices([{ device: "-", visitCount: null, viewCount: 1 }]).noneVisits).toBeNull();
  });
  it("기기 방문을 모르면 화면 분모도 null, 기기별 줄도 만들지 않는다", () => {
    const d: DeviceRow[] = [{ device: "m", visitCount: null, viewCount: 1 }];
    expect(pageVisitsForDevice(d, "m")).toBeNull();
    expect(pageVisitsForDevice(d, "d")).toBe(0);
    const rows = [{ clickTarget: "a", clickKind: "marker", clickVisitCount: 1, clickCount: 1, clickRate: 0.1 }];
    expect(rowsForDevice(rows, [], "m", null)).toBeNull();
    expect(
      rowsForDevice(rows, [{ clickTarget: "a", clickKind: "marker", device: "m", clickedVisitCount: null, clickCount: 1 }], "m", 10),
    ).toBeNull();
  });
  it("화면 — 모르는 칸은 —, 막대 대신 안내", () => {
    const html = renderToStaticMarkup(
      createElement(DeviceCardView, {
        devices: [
          { device: "m", visitCount: null, viewCount: 3 },
          { device: "d", visitCount: 40, viewCount: 50 },
        ],
        dataSource: "detail",
        ga: { status: "not_connected" },
        gaLoading: false,
      }),
    );
    expect(html).toContain("기기별 숫자 일부를 확인할 수 없어 비율은 표시하지 않습니다");
    expect(html).not.toContain("0.0%");
    expect(html).toContain("—");
  });
  it("구글 응답 개수가 잘못되면 불러오기 실패로(0 으로 바꾸지 않는다)", () => {
    expect(parseGa4Response({ status: "ok", rows: [{ category: "mobile", sessions: "abc", screenPageViews: 1 }] })).toEqual({
      status: "unavailable",
    });
  });
});

describe("섹션·소개영상 기기 전환", () => {
  const rows = [
    { clickTarget: "rc_sec_a", clickKind: "marker", clickVisitCount: 10, clickCount: 12, clickRate: 0.1 },
    { clickTarget: "rc_sec_b", clickKind: "marker", clickVisitCount: 5, clickCount: 5, clickRate: 0.05 },
  ];
  const itemDevices = [
    { clickTarget: "rc_sec_a", clickKind: "marker", device: "m" as const, clickedVisitCount: 6, clickCount: 7 },
    { clickTarget: "rc_sec_a", clickKind: "marker", device: "d" as const, clickedVisitCount: 4, clickCount: 5 },
  ];
  it("모바일 — 그 기기 방문 ÷ 그 기기로 화면을 본 방문", () => {
    const pv = pageVisitsForDevice(devices, "m")!;
    const out = rowsForDevice(rows, itemDevices, "m", pv)!;
    expect(pv).toBe(72);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ clickTarget: "rc_sec_a", clickVisitCount: 6, clickCount: 7 });
    expect(out[0].clickRate).toBeCloseTo(6 / 72);
  });
  it("분모 0 이면 비율 null", () => {
    expect(rowsForDevice(rows, itemDevices, "d", 0)![0].clickRate).toBeNull();
  });
  it("기기 칸이 없으면 화면 방문 수도 null", () => {
    expect(pageVisitsForDevice(null, "m")).toBeNull();
  });
});

describe("구글 칸 상태", () => {
  const ok: Ga4Response = {
    status: "ok",
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    rows: [
      { category: "mobile", label: "모바일", sessions: 60, screenPageViews: 90 },
      { category: "desktop", label: "PC", sessions: 40, screenPageViews: 50 },
    ],
  };
  it("상태 — 우리 앱 쪽 실패가 먼저", () => {
    expect(ga4PanelState(null, true)).toBe("loading");
    expect(ga4PanelState(ok, false)).toBe("ok");
    expect(ga4PanelState({ ...ok, rows: [] }, false)).toBe("empty");
    expect(ga4PanelState({ status: "not_connected" }, false)).toBe("not_connected");
    expect(ga4PanelState({ status: "unavailable" }, false)).toBe("unavailable");
    expect(ga4PanelState(null, false)).toBe("unavailable");
    expect(ga4PanelState(null, false, "app_login")).toBe("app_login");
    expect(ga4PanelState(null, false, "app_forbidden")).toBe("app_forbidden");
    expect(ga4PanelState(null, false, "rate_limited")).toBe("rate_limited");
  });
  it("모르는 응답 모양은 불러오기 실패로", () => {
    expect(parseGa4Response({ status: "weird" })).toEqual({ status: "unavailable" });
    expect(parseGa4Response(null)).toEqual({ status: "unavailable" });
    expect(parseGa4Response({ status: "ok", rows: [{ category: "mobile", label: "모바일", sessions: "5", screenPageViews: 1 }] })).toMatchObject({
      status: "ok",
      rows: [{ category: "mobile", sessions: 5 }],
    });
  });

  const render = (ga: Ga4Response | null, gaLoading = false, d: DeviceRow[] = devices, gaFailure: "app_login" | "app_forbidden" | "rate_limited" | null = null) =>
    renderToStaticMarkup(createElement(DeviceCardView, { devices: d, dataSource: "detail", ga, gaLoading, gaFailure }));

  it("화면 — 정상", () => {
    const html = render(ok);
    expect(html).toContain("구글 애널리틱스 · 세션 기준");
    expect(html).toContain("60.0%");
    expect(html).toContain("72.0%");
  });
  it("화면 — 빈 결과", () => {
    expect(render({ ...ok, rows: [] })).toContain(GA4_STATE_TEXT.empty);
  });
  it("화면 — 미연결이어도 우리 통계는 그린다", () => {
    const html = render({ status: "not_connected" });
    expect(html).toContain(GA4_STATE_TEXT.not_connected);
    expect(html).toContain("72.0%");
  });
  it("화면 — 불러오기 실패", () => {
    expect(render({ status: "unavailable" })).toContain(GA4_STATE_TEXT.unavailable);
  });
  it("화면 — 로그인 만료·권한 없음·요청 제한은 원인을 따로 보인다 (D3)", () => {
    expect(render(null, false, devices, "app_login")).toContain(GA4_STATE_TEXT.app_login);
    expect(render(null, false, devices, "app_forbidden")).toContain(GA4_STATE_TEXT.app_forbidden);
    expect(render(null, false, devices, "rate_limited")).toContain(GA4_STATE_TEXT.rate_limited);
    expect(render(null, false, devices, "rate_limited")).not.toContain(GA4_STATE_TEXT.unavailable);
  });
  it("화면 — 기기 정보 없는 방문 수를 늘 적는다", () => {
    expect(render(ok)).toContain("50건");
  });
  it("화면 — 기간 전체가 정보 없음이면 그 문구만", () => {
    const html = render(ok, false, [{ device: "-", visitCount: 9, viewCount: 9 }]);
    expect(html).toContain("이 기간 방문은 기기 정보가 없습니다");
  });
});

describe("지금 기간 것만 그린다 (D4)", () => {
  const okA: Ga4Response = { status: "ok", startDate: "2026-10-01", endDate: "2026-10-31", rows: [{ category: "mobile", label: "모바일", sessions: 1, screenPageViews: 1 }] };
  const viewA: Ga4View = { key: ga4RangeKey("2026-10-01", "2026-10-31"), loading: false, res: okA, failure: null };
  it("저장된 결과가 이전 기간 것이면 「불러오는 중」", () => {
    expect(ga4ViewFor(viewA, "2026-11-01", "2026-11-10")).toEqual({ res: null, loading: true, failure: null });
  });
  it("같은 기간이면 그린다", () => {
    expect(ga4ViewFor(viewA, "2026-10-01", "2026-10-31")).toEqual({ res: okA, loading: false, failure: null });
  });
  it("응답 날짜가 기간과 다르면 그리지 않는다", () => {
    const wrong: Ga4View = { ...viewA, res: { ...okA, startDate: "2026-09-01" } };
    expect(ga4ViewFor(wrong, "2026-10-01", "2026-10-31").res).toEqual({ status: "unavailable" });
  });
  it("아직 아무것도 없으면 「불러오는 중」", () => {
    expect(ga4ViewFor(null, "2026-10-01", "2026-10-31").loading).toBe(true);
  });
});

/** 응답을 손으로 풀어 주는 가짜 fetch — 취소 신호를 받으면 AbortError 로 끝난다. */
function fakeFetch() {
  const calls: { url: string; signal: AbortSignal; resolve: (r: { status: number; body?: unknown }) => void }[] = [];
  const fetchImpl = vi.fn(
    (url: string, init: { credentials: "include"; signal: AbortSignal }) =>
      new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        calls.push({
          url,
          signal: init.signal,
          resolve: ({ status, body }) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
        });
      }),
  );
  return { fetchImpl, calls };
}

const okBody = (from: string, to: string) => ({
  status: "ok",
  startDate: from,
  endDate: to,
  rows: [{ category: "mobile", label: "모바일", sessions: 3, screenPageViews: 4 }],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("DeviceCard 불러오기 — 취소·번호표·로딩 (T1)", () => {
  it("시작하면 그 기간의 「불러오는 중」을 먼저 알리고, 끝나면 결과를 알린다", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const seen: Ga4View[] = [];
    const loader = createGa4Loader({ fetchImpl, basePath: "/geo", onChange: (v) => seen.push(v) });
    const p = loader.load("2026-11-01", "2026-11-10");
    expect(seen).toEqual([{ key: "2026-11-01|2026-11-10", loading: true, res: null, failure: null }]);
    expect(calls[0].url).toBe("/geo/api/admin/page-analytics/ga4-device?fromKst=2026-11-01&toKst=2026-11-10");
    calls[0].resolve({ status: 200, body: okBody("2026-11-01", "2026-11-10") });
    await p;
    expect(seen.at(-1)).toMatchObject({ key: "2026-11-01|2026-11-10", loading: false, failure: null, res: { status: "ok" } });
  });

  it("기간 A 응답이 B 뒤에 늦게 와도 B 가 남는다 — A 요청은 취소된다", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const seen: Ga4View[] = [];
    const loader = createGa4Loader({ fetchImpl, basePath: "", onChange: (v) => seen.push(v) });
    const pa = loader.load("2026-10-01", "2026-10-31");
    const pb = loader.load("2026-11-01", "2026-11-10");
    expect(calls[0].signal.aborted).toBe(true);
    calls[1].resolve({ status: 200, body: okBody("2026-11-01", "2026-11-10") });
    calls[0].resolve({ status: 200, body: okBody("2026-10-01", "2026-10-31") });
    await Promise.all([pa, pb]);
    await tick();
    const done = seen.filter((v) => !v.loading);
    expect(done).toHaveLength(1);
    expect(done[0].key).toBe("2026-11-01|2026-11-10");
  });

  it("취소를 무시하는 fetch 라도 번호표가 옛 응답을 버린다", async () => {
    const seen: Ga4View[] = [];
    const resolvers: ((v: unknown) => void)[] = [];
    const stubborn = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
          resolvers.push((body) => resolve({ ok: true, status: 200, json: async () => body }));
        }),
    );
    const loader = createGa4Loader({ fetchImpl: stubborn, basePath: "", onChange: (v) => seen.push(v) });
    const pa = loader.load("2026-10-01", "2026-10-31");
    const pb = loader.load("2026-11-01", "2026-11-10");
    resolvers[1](okBody("2026-11-01", "2026-11-10"));
    await pb;
    resolvers[0](okBody("2026-10-01", "2026-10-31"));
    await pa;
    expect(seen.filter((v) => !v.loading).map((v) => v.key)).toEqual(["2026-11-01|2026-11-10"]);
  });

  it.each([
    [401, "app_login"],
    [403, "app_forbidden"],
    [429, "rate_limited"],
  ] as const)("%s → 우리 앱 쪽 실패(%s)로 구분", async (status, failure) => {
    const { fetchImpl, calls } = fakeFetch();
    const seen: Ga4View[] = [];
    const loader = createGa4Loader({ fetchImpl, basePath: "", onChange: (v) => seen.push(v) });
    const p = loader.load("2026-11-01", "2026-11-10");
    calls[0].resolve({ status, body: { error: "x" } });
    await p;
    expect(seen.at(-1)).toMatchObject({ loading: false, failure, res: null });
  });

  it("500·네트워크 오류 → 구글 칸 「불러오지 못함」", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const seen: Ga4View[] = [];
    const loader = createGa4Loader({ fetchImpl, basePath: "", onChange: (v) => seen.push(v) });
    const p = loader.load("2026-11-01", "2026-11-10");
    calls[0].resolve({ status: 500 });
    await p;
    expect(seen.at(-1)).toMatchObject({ loading: false, failure: null, res: { status: "unavailable" } });

    const broken = createGa4Loader({
      fetchImpl: async () => {
        throw new TypeError("network");
      },
      basePath: "",
      onChange: (v) => seen.push(v),
    });
    await broken.load("2026-11-01", "2026-11-10");
    expect(seen.at(-1)).toMatchObject({ loading: false, res: { status: "unavailable" } });
  });

  it("화면을 떠나면(dispose) 진행 중 요청을 취소하고 더는 알리지 않는다", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const seen: Ga4View[] = [];
    const loader = createGa4Loader({ fetchImpl, basePath: "", onChange: (v) => seen.push(v) });
    const p = loader.load("2026-11-01", "2026-11-10");
    loader.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    await p;
    await loader.load("2026-12-01", "2026-12-02");
    expect(seen).toHaveLength(1);
    expect(seen[0].loading).toBe(true);
  });

  it("불러오기 결과를 카드에 넣으면 지금 기간 것만 그린다", async () => {
    const { fetchImpl, calls } = fakeFetch();
    let view: Ga4View | null = null;
    const loader = createGa4Loader({ fetchImpl, basePath: "", onChange: (v) => (view = v) });
    const p = loader.load("2026-10-01", "2026-10-31");
    calls[0].resolve({ status: 200, body: okBody("2026-10-01", "2026-10-31") });
    await p;
    const draw = (from: string, to: string) => {
      const g = ga4ViewFor(view, from, to);
      return renderToStaticMarkup(
        createElement(DeviceCardView, { devices, dataSource: "detail", ga: g.res, gaLoading: g.loading, gaFailure: g.failure }),
      );
    };
    expect(draw("2026-10-01", "2026-10-31")).toContain("세션 수");
    const afterSwitch = draw("2026-11-01", "2026-11-10");
    expect(afterSwitch).toContain(GA4_STATE_TEXT.loading);
    expect(afterSwitch).not.toContain("세션 수");
  });
});

describe("페이지 통계에 기기 칸이 없으면 카드를 숨긴다", () => {
  it("예전 응답 → devices null (탭은 stats.devices 가 있을 때만 카드를 그린다)", () => {
    expect(normalizePageViewStats({ dataSource: "detail" }).devices).toBeNull();
  });
});
