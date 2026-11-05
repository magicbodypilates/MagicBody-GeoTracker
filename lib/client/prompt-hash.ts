/**
 * prompt-hash.ts — 질문별 AI 답변 API 에 질문을 보내는 방식 (검수 A-C3 · 2026-11-06).
 *
 * 긴 질문(수천 자)은 주소창 길이 한도에 걸리므로 문구 대신 SHA-256 16진수(64자)로 보낸다. 서버는 질문 집계가
 * 쓰는 정규화 결과에 같은 해시를 걸어 맞춘다(lib/server/citation-url-answers.ts promptMatcher). 화면이 받은
 * 질문 문구는 이미 정규화 결과다. 해시를 만들 수 없는 환경(보안 연결이 아닌 주소 등)이면 문구 그대로 보낸다.
 */

const memo = new Map<string, Promise<Record<string, string>>>();

export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 답변 API 쿼리의 질문 부분 — { promptHash } 또는 { promptText } */
export function promptQueryParam(promptText: string): Promise<Record<string, string>> {
  let p = memo.get(promptText);
  if (!p) {
    p = sha256Hex(promptText)
      .then((h): Record<string, string> => (h ? { promptHash: h } : { promptText }))
      .catch((): Record<string, string> => ({ promptText }));
    memo.set(promptText, p);
    if (memo.size > 500) memo.delete(memo.keys().next().value as string);
  }
  return p;
}
