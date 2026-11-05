/**
 * json-compress.ts — 무거운 JSON 응답(응답 목록·인용 집계)을 라우트에서 직접 압축해 돌려준다
 * (2026-11-05 — 불러오기 속도 개선).
 *
 * 왜 라우트에서 압축하나:
 *   Next 서버의 내장 압축(next.config `compress`, 기본 켜짐)은 gzip 만 한다. 응답 목록 한 페이지(약 3.1MB)는
 *   gzip 786KB · brotli(품질 4) 573KB 로 brotli 가 27% 더 작다. 그래서 이 도우미가 요청의
 *   `Accept-Encoding` 을 보고 brotli → gzip → 압축 안 함 순으로 고른다.
 *
 * 이중 압축이 생기지 않는 이유:
 *   Next 내장 압축 미들웨어(compression)는 응답에 이미 `Content-Encoding` 이 있으면 손대지 않는다
 *   ("already encoded"). 그래서 이 도우미가 압축한 응답은 한 번만 압축된다. 작은 응답(1KB 미만)은
 *   압축하지 않고 넘겨 기존 동작(내장 압축 판단)에 맡긴다.
 *
 * 응답에 항상 `Vary: Accept-Encoding` 을 붙여 중간 캐시가 압축본·원본을 섞지 않게 한다.
 */

import { brotliCompress, constants as zc, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type ContentEncoding = "br" | "gzip" | "identity";

/** 이보다 작은 본문은 압축하지 않는다(압축 이득 < 비용) */
export const COMPRESS_MIN_BYTES = 1024;
/** brotli 품질 — 4 는 속도·크기 균형점(3.1MB 기준 수십 ms) */
export const BROTLI_QUALITY = 4;

/**
 * Accept-Encoding 해석 — q=0 은 거부로 본다. br 을 gzip 보다 우선한다.
 * `*` 는 따로 적지 않은 형식을 허용한다는 뜻이라 gzip(없으면 br)으로 고르되, 명시로 거부(q=0)한 형식은 고르지 않는다.
 */
export function pickEncoding(acceptEncoding: string | null | undefined): ContentEncoding {
  if (!acceptEncoding) return "identity";
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    accepted.set(name, Number.isFinite(q) ? q : 0);
  }
  const ok = (n: string) => (accepted.get(n) ?? 0) > 0;
  if (ok("br")) return "br";
  if (ok("gzip") || ok("x-gzip")) return "gzip";
  // `*` 는 "따로 적지 않은 형식" 만 허용한다 — gzip;q=0 처럼 명시로 거부한 형식은 고르지 않는다
  if (ok("*")) {
    if (!accepted.has("gzip") && !accepted.has("x-gzip")) return "gzip";
    if (!accepted.has("br")) return "br";
  }
  return "identity";
}

export async function compressBody(buf: Buffer, enc: ContentEncoding): Promise<Buffer> {
  if (enc === "br") {
    return brotliAsync(buf, {
      params: {
        [zc.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
        [zc.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
  }
  if (enc === "gzip") return gzipAsync(buf);
  return buf;
}

/**
 * JSON 본문을 Accept-Encoding 에 맞춰 압축한 Response 로 돌려준다.
 * 압축이 실패하면(이론상 없음) 원본 그대로 보낸다 — 조회 자체가 실패하지 않게.
 */
export async function compressedJson(
  req: Request,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.append("Vary", "Accept-Encoding");

  let enc: ContentEncoding = raw.length >= COMPRESS_MIN_BYTES ? pickEncoding(req.headers.get("accept-encoding")) : "identity";
  let out: Buffer = raw;
  if (enc !== "identity") {
    try {
      out = await compressBody(raw, enc);
    } catch (err) {
      console.warn("[json-compress] 압축 실패 — 원본으로 보냄:", err instanceof Error ? err.message : err);
      enc = "identity";
      out = raw;
    }
  }
  if (enc !== "identity") headers.set("Content-Encoding", enc);
  headers.set("Content-Length", String(out.length));
  return new Response(new Uint8Array(out), { status: init.status ?? 200, headers });
}
