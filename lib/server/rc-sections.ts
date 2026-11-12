/**
 * 오프라인 정규과정 상세 페이지의 섹션 목록(순서·제목)을 운영 페이지 원본에서 읽는다 — 서버 전용.
 *
 * 사이트(MagicBody-Web sectionViewTracking.js)는 페이지의 section[id][data-screen-label] 마다 rc_sec_<id>·rc_nav_<id> 를 보낸다.
 * 표 순서·제목도 같은 원본에서 읽어, 섹션이 바뀌어도 코드를 고치지 않게 한다.
 *   · 순서 = 원본 안의 등장 순서 · 제목 = data-screen-label 에서 앞 번호("01 ", "06-1 ")를 뗀 글자
 *   · id 는 영소문자·숫자·하이픈 1～40자만(사이트·서버 형식과 같다)
 * 한 시간 보관한다. 가져오기에 실패하면 지난 결과를, 그것도 없으면 null 을 준다(호출부가 기록에 있는 id 로 대신 그린다).
 */
import "server-only";

export const RC_PAGE_URL = "https://www.magicbodypilates.co.kr/Regularclass/index.html";
const CACHE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SECTIONS = 200;

export type RcSection = { id: string; title: string };

const SECTION_ID_RE = /^[a-z0-9-]{1,40}$/;

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 이름표에서 앞 번호를 뗀다 — "01 히어로" → "히어로". 번호만 있으면 그대로. */
export function labelTitle(label: string): string {
  const t = label.trim().replace(/\s+/g, " ");
  const stripped = t.replace(/^\d+(?:-\d+)*\s+/, "");
  return stripped || t;
}

/** 원본 HTML 에서 이름표 붙은 섹션을 등장 순서대로 뽑는다(순수 함수). 주석 안의 섹션은 건너뛴다. */
export function parseRcSections(html: string): RcSection[] {
  const out: RcSection[] = [];
  const seen = new Set<string>();
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/<section\b([^>]*)>/gi)) {
    const attrs = m[1];
    const id = /\bid\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bid\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    const label =
      /\bdata-screen-label\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bdata-screen-label\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    if (!id || label === undefined || !SECTION_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: labelTitle(decodeEntities(label)) || id });
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

let cache: { at: number; sections: RcSection[] } | null = null;
let inflight: Promise<RcSection[] | null> | null = null;

async function fetchOnce(): Promise<RcSection[] | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RC_PAGE_URL, { signal: ac.signal, cache: "no-store", redirect: "follow" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_BYTES) return null;
    const html = await res.text();
    if (html.length > MAX_BYTES) return null;
    const sections = parseRcSections(html);
    return sections.length > 0 ? sections : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 섹션 목록 — 한 시간 보관. 실패하면 지난 결과, 그것도 없으면 null. */
export async function getRcSections(now: number = Date.now()): Promise<{ sections: RcSection[] | null; stale: boolean }> {
  if (cache && now - cache.at < CACHE_MS) return { sections: cache.sections, stale: false };
  if (!inflight) {
    inflight = fetchOnce().finally(() => {
      inflight = null;
    });
  }
  const fresh = await inflight;
  if (fresh) {
    cache = { at: Date.now(), sections: fresh };
    return { sections: fresh, stale: false };
  }
  return { sections: cache ? cache.sections : null, stale: !!cache };
}

/** 시험용 — 보관 비우기. */
export function __resetRcSectionsCache(): void {
  cache = null;
  inflight = null;
}
