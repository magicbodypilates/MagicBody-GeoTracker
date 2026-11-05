/**
 * json-compress.test.ts — 무거운 JSON 응답 압축 도우미 (2026-11-05).
 */

import { describe, it, expect } from "vitest";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressedJson, pickEncoding, COMPRESS_MIN_BYTES } from "./json-compress";

function req(acceptEncoding?: string): Request {
  return new Request("http://localhost/x", {
    headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
  });
}

const big = { runs: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, answer: "필라테스 강사 자격증 ".repeat(20) })) };

describe("pickEncoding", () => {
  it("br 을 gzip 보다 먼저 고른다", () => {
    expect(pickEncoding("gzip, deflate, br")).toBe("br");
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
  });
  it("q=0 은 거부로 본다", () => {
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip;q=0")).toBe("identity");
  });
  it("gzip 만 / * / 없음", () => {
    expect(pickEncoding("gzip")).toBe("gzip");
    expect(pickEncoding("*")).toBe("gzip");
    expect(pickEncoding(null)).toBe("identity");
    expect(pickEncoding("")).toBe("identity");
    expect(pickEncoding("deflate")).toBe("identity");
  });
});

describe("compressedJson", () => {
  it("br 요청 → Content-Encoding: br, 풀면 원래 JSON", async () => {
    const res = await compressedJson(req("gzip, br"), big);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("content-type")).toBe("application/json");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(buf.length);
    expect(JSON.parse(brotliDecompressSync(buf).toString("utf8"))).toEqual(big);
    expect(buf.length).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) / 5);
  });

  it("gzip 요청 → Content-Encoding: gzip", async () => {
    const res = await compressedJson(req("gzip"), big);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(gunzipSync(buf).toString("utf8"))).toEqual(big);
  });

  it("압축 미지원 요청·작은 본문은 원본 그대로 (Content-Encoding 없음)", async () => {
    const plain = await compressedJson(req(), big);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.json()).toEqual(big);

    const small = { ok: true };
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(COMPRESS_MIN_BYTES);
    const s = await compressedJson(req("br"), small);
    expect(s.headers.get("content-encoding")).toBeNull();
    expect(await s.json()).toEqual(small);
  });

  it("status·추가 헤더를 넘길 수 있다", async () => {
    const res = await compressedJson(req(), { error: "x" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("C9 — 명시 거부는 와일드카드보다 우선", () => {
  it("br;q=0, gzip;q=0, *;q=1 → 압축 안 함", () => {
    expect(pickEncoding("br;q=0, gzip;q=0, *;q=1")).toBe("identity");
  });
  it("gzip;q=0, * → br / br;q=0, * → gzip", () => {
    expect(pickEncoding("gzip;q=0, *")).toBe("br");
    expect(pickEncoding("br;q=0, *")).toBe("gzip");
  });
});
