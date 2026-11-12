import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { consoleLinksFor, resolveCmsConsoleUrl } from "./console-links";

const PROD = "https://cms.magicbodypilates.co.kr/BoardAdmin/Gate";
const DEV = "http://localhost:5045/BoardAdmin/Gate";

/** 로그 호출을 모으는 시험용 기록기. */
function recorder() {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
}

describe("consoleLinksFor", () => {
  it("kind=admin 이면 CMS 관리 화면 링크 1개를 돌려준다", () => {
    const links = consoleLinksFor("admin", { NODE_ENV: "production" });
    expect(links).toEqual([{ label: "CMS 관리 화면", href: PROD }]);
  });

  it("일반 세션이면 빈 배열", () => {
    expect(consoleLinksFor("user", { NODE_ENV: "production" })).toEqual([]);
    expect(consoleLinksFor("user", { NODE_ENV: "production", CMS_CONSOLE_URL: PROD })).toEqual([]);
  });

  it("비로그인이면 빈 배열", () => {
    expect(consoleLinksFor(null, { NODE_ENV: "development" })).toEqual([]);
  });
});

describe("resolveCmsConsoleUrl — 기본값", () => {
  it("개발 환경 기본값은 로컬 CMS", () => {
    expect(resolveCmsConsoleUrl({ NODE_ENV: "development" })).toBe(DEV);
  });

  it("운영 환경 기본값은 운영 CMS", () => {
    expect(resolveCmsConsoleUrl({ NODE_ENV: "production" })).toBe(PROD);
    expect(resolveCmsConsoleUrl({})).toBe(PROD);
  });

  it("빈 값·공백만 있으면 경고 없이 기본값", () => {
    const r = recorder();
    expect(resolveCmsConsoleUrl({ NODE_ENV: "production", CMS_CONSOLE_URL: "   " }, r.log)).toBe(PROD);
    expect(r.lines).toEqual([]);
  });
});

describe("resolveCmsConsoleUrl — 허용", () => {
  it("허용 호스트의 https 주소는 그대로 쓴다(앞뒤 공백 제거)", () => {
    const r = recorder();
    const url = "https://cms.magicbodypilates.co.kr/BoardAdmin/Other";
    expect(resolveCmsConsoleUrl({ NODE_ENV: "production", CMS_CONSOLE_URL: `  ${url} ` }, r.log)).toBe(url);
    expect(r.lines).toEqual([]);
  });

  it("개발 실행에서는 localhost 의 http 를 허용", () => {
    const url = "http://localhost:5046/BoardAdmin/Gate";
    expect(resolveCmsConsoleUrl({ NODE_ENV: "development", CMS_CONSOLE_URL: url }, recorder().log)).toBe(url);
  });
});

describe("resolveCmsConsoleUrl — 거부(경고 후 기본값, 값은 로그에 남기지 않음)", () => {
  const cases: Array<[string, string, string]> = [
    ["임의 호스트", "production", "https://example.test/Gate"],
    ["허용 호스트를 흉내 낸 다른 호스트", "production", "https://cms.magicbodypilates.co.kr.evil.test/Gate"],
    ["운영 실행의 http", "production", "http://cms.magicbodypilates.co.kr/BoardAdmin/Gate"],
    ["운영 실행의 http localhost", "production", "http://localhost:5045/BoardAdmin/Gate"],
    ["개발 실행이라도 운영 호스트의 http", "development", "http://cms.magicbodypilates.co.kr/BoardAdmin/Gate"],
    ["사용자 정보 포함", "production", "https://someone:hunter2@cms.magicbodypilates.co.kr/BoardAdmin/Gate"],
    ["사용자 이름만 포함", "development", "http://someone@localhost:5045/BoardAdmin/Gate"],
    ["javascript 스킴", "production", "javascript:alert(1)"],
    ["스킴 빠진 오타", "production", "cms.magicbodypilates.co.kr/BoardAdmin/Gate"],
  ];

  for (const [name, nodeEnv, value] of cases) {
    it(name, () => {
      const r = recorder();
      const expected = nodeEnv === "development" ? DEV : PROD;
      expect(resolveCmsConsoleUrl({ NODE_ENV: nodeEnv, CMS_CONSOLE_URL: value }, r.log)).toBe(expected);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toContain("무효");
      expect(r.lines[0]).not.toContain(value);
      expect(r.lines[0]).not.toContain("hunter2");
    });
  }
});

describe("서버 전용 표시와 클라이언트 공유 파일", () => {
  it("모듈이 server-only 를 import 한다", () => {
    const src = readFileSync(resolve(__dirname, "console-links.ts"), "utf8");
    expect(src).toMatch(/^import "server-only";$/m);
  });

  it("대시보드 컴포넌트·일반 진입 페이지에 관문 경로 문자열이 없다", () => {
    for (const rel of ["components/sovereign-dashboard.tsx", "app/page.tsx"]) {
      const src = readFileSync(resolve(__dirname, "..", "..", rel), "utf8");
      expect(src).not.toContain("BoardAdmin");
      expect(src).not.toContain("console-links");
    }
  });
});
