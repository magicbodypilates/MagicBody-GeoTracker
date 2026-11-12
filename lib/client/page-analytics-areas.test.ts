import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildAreaTableLines,
  DETAIL_AREA_ROUTES,
  DETAIL_AREAS,
  DETAIL_AREA_TARGETS,
  isDetailAreaRoute,
} from "./page-analytics-areas";

const row = (clickTarget: string, clickVisitCount: number, clickRate: number | null, clickKind = "marker") => ({
  clickTarget,
  clickKind,
  clickVisitCount,
  clickCount: clickVisitCount,
  clickRate,
});

const ALWAYS = ["top", "intro", "guide"];

describe("isDetailAreaRoute", () => {
  it("상품 하나의 상세 화면만 표를 그린다(골프 포함)", () => {
    expect(isDetailAreaRoute("regularClassOffline")).toBe(true);
    expect(isDetailAreaRoute("regularClassOnline")).toBe(true);
    expect(isDetailAreaRoute("golfPilatesOnline")).toBe(true);
    expect(isDetailAreaRoute("productPrenatalPilatesOnline")).toBe(true);
    expect(DETAIL_AREA_ROUTES.size).toBe(22);
  });
  it("강의 상세 묶음 줄·미리보기·다른 화면은 그리지 않는다", () => {
    expect(isDetailAreaRoute("classView")).toBe(false);
    expect(isDetailAreaRoute("classViewStage2Preview")).toBe(false);
    expect(isDetailAreaRoute("guide")).toBe(false);
    expect(isDetailAreaRoute("productUnknown")).toBe(false);
  });
});

describe("표 대상 화면 목록 ↔ 서버 이름표·사이트 라우터", () => {
  const repos = path.resolve(__dirname, "..", "..", "..");
  const apiFile = path.join(repos, "MagicBody-API", "AidNaom-API", "Services", "PageRouteRegistry.cs");
  const routerFile = path.join(repos, "MagicBody-Web", "src", "router", "index.js");
  const productsFile = path.join(repos, "MagicBody-Web", "src", "router", "product-routes.json");
  const present = fs.existsSync(apiFile) && fs.existsSync(routerFile) && fs.existsSync(productsFile);

  it.skipIf(!present)("서버 상품 화면 19개가 모두 들어 있다", () => {
    const cs = fs.readFileSync(apiFile, "utf8");
    const block = cs.slice(cs.indexOf("ProductRoutes ="), cs.indexOf("};", cs.indexOf("ProductRoutes =")));
    const names = [...block.matchAll(/\("(product[A-Za-z]+)"/g)].map((m) => m[1]);
    expect(names.length).toBe(19);
    for (const n of names) expect(DETAIL_AREA_ROUTES.has(n)).toBe(true);
  });

  it.skipIf(!present)("사이트에서 classView.vue 를 쓰는 화면은 모두 들어 있다(「강의 상세」 묶음 제외)", () => {
    const src = fs.readFileSync(routerFile, "utf8");
    const lines = src.split("\n");
    const used = new Set<string>();
    lines.forEach((l, i) => {
      const m = /name:\s*"([^"]+)"/.exec(l);
      if (!m) return;
      const near = lines.slice(Math.max(0, i - 3), i + 8).join("\n");
      if (/component:\s*(ClassViewComponent|\(\) => import\("\.\.\/views\/class\/classView\.vue"\))/.test(near)) used.add(m[1]);
    });
    const products = JSON.parse(fs.readFileSync(productsFile, "utf8")) as { name: string }[];
    for (const p of products) used.add(p.name);
    const bundled = new Set(["classView", "classViewStage2Preview", "classViewEventPreview"]);
    const missing = [...used].filter((n) => !bundled.has(n) && !DETAIL_AREA_ROUTES.has(n));
    expect(missing).toEqual([]);
    expect(used.has("golfPilatesOnline")).toBe(true);
  });
});

describe("DETAIL_AREA_TARGETS", () => {
  it("영역 순서와 표식 이름", () => {
    expect(DETAIL_AREAS.map((a) => a.key)).toEqual([
      "top", "curriculum", "intro", "reviews", "ebook", "freelecture", "schedule", "location", "guide",
    ]);
    expect(DETAIL_AREAS.filter((a) => a.always).map((a) => a.key)).toEqual(ALWAYS);
    expect(DETAIL_AREA_TARGETS.has("cv_area_top")).toBe(true);
    expect(DETAIL_AREA_TARGETS.has("cv_tab_guide")).toBe(true);
    expect(DETAIL_AREA_TARGETS.has("rc_sec_faq")).toBe(false);
  });
});

describe("buildAreaTableLines", () => {
  it("항상 있는 영역은 0이어도 나오고, 있고 없는 영역은 기록이 있을 때만 나온다", () => {
    const lines = buildAreaTableLines([row("cv_area_reviews", 7, 0.35), row("cv_tab_schedule", 2, 0.1)], 20);
    expect(lines.map((l) => l.key)).toEqual(["top", "intro", "reviews", "schedule", "guide"]);
    expect(lines.find((l) => l.key === "reviews")).toMatchObject({ viewed: 7, ofPage: 0.35, nav: 0 });
    expect(lines.find((l) => l.key === "schedule")).toMatchObject({ viewed: 0, ofPage: 0, nav: 2 });
    expect(lines.find((l) => l.key === "intro")).toMatchObject({ viewed: 0, ofPage: 0, nav: 0 });
  });
  it("상단 상품 정보의 탭 칸은 null(「—」)", () => {
    const lines = buildAreaTableLines([row("cv_area_top", 5, 0.5)], 10);
    expect(lines[0]).toMatchObject({ key: "top", viewed: 5, nav: null });
  });
  it("기기를 바꿔도 줄 구성은 전체 기준으로 정한다", () => {
    const all = [row("cv_area_ebook", 3, 0.3)];
    const mobile: ReturnType<typeof row>[] = []; // 모바일에는 전자책 기록이 없다
    const lines = buildAreaTableLines(mobile, 10, null, all);
    const ebook = lines.find((l) => l.key === "ebook");
    expect(ebook).toMatchObject({ viewed: 0, ofPage: 0, nav: 0 });
  });
  it("방문이 0 이면 비율은 잴 수 없다(null)", () => {
    const lines = buildAreaTableLines([], 0);
    expect(lines.map((l) => l.key)).toEqual(ALWAYS);
    expect(lines.every((l) => l.ofPage === null && l.viewed === 0)).toBe(true);
  });
  it("marker 가 아닌 줄은 쓰지 않는다", () => {
    const lines = buildAreaTableLines([row("cv_area_curriculum", 5, 0.5, "external_link")], 10);
    expect(lines.map((l) => l.key)).toEqual(ALWAYS);
  });
  it("섹션을 주면 교육소개 바로 아래에 들여 붙인다", () => {
    const list = [
      { id: "concerns", title: "고민" },
      { id: "faq", title: "자주 묻는 질문" },
    ];
    const lines = buildAreaTableLines([row("cv_area_intro", 9, 0.9), row("cv_area_reviews", 4, 0.4)], 10, {
      rows: [row("rc_sec_faq", 3, 0.3), row("rc_nav_faq", 1, 0.1)],
      list,
      viewPrefix: "rc_sec_",
      navPrefix: "rc_nav_",
    });
    const keys = lines.map((l) => l.key);
    const i = keys.indexOf("intro");
    expect(keys.slice(i, i + 4)).toEqual(["intro", "sec:concerns", "sec:faq", "reviews"]);
    expect(lines[i + 2]).toMatchObject({ nested: true, viewed: 3, ofPage: 0.3, nav: 1, title: "자주 묻는 질문" });
    expect(lines[i + 1]).toMatchObject({ nested: true, viewed: 0, ofPage: 0, nav: 0 });
  });
});
