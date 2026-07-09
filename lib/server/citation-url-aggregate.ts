/**
 * 브랜드 URL 인용 집계 — 순수함수 모듈 (DB·Next 무의존).
 *
 * 목적: "인용 출처" 탭에서
 *   (1) 내 사이트(브랜드 공식 채널) URL 이 전체 기간 동안 한 번이라도 인용된 개별 페이지 URL 을
 *       전수 노출(소유 뷰) 하고,
 *   (2) 인용의 제목/설명에 브랜드명(별칭)이 들어간 제3자 페이지(보도자료·언론기사 등)를
 *       소유 도메인과 분리해 "브랜드 언급 출처(제3자)" 로 전수 노출(언급 뷰) 한다.
 *   두 뷰 모두 URL 마다 그 URL 을 인용한 질문(프롬프트)을 드릴다운한다.
 *
 * 설계(계획 v2 §4·§8):
 *   - SQL 은 runs → jsonb_array_elements(citations) 로 citation 을 행으로 펼치고 사전 필터·행 cap
 *     까지만 담당한다. 정규화·브랜드 매칭·per-run dedup·집계·페이지네이션은 이 모듈의 순수함수가
 *     담당한다 (citation-utils 매칭 규칙과의 일관성 유지 + DB 무의존 vitest 대상).
 *   - 매칭/병합 판정 key(canonicalUrlKey)와 표시용 원본 URL(displayUrl)을 분리한다
 *     (m. 모바일 서브도메인·tracking query 로 인한 과대/과소 병합 방지).
 *   - 페이지네이션은 offset 이 아닌 keyset cursor (all-time 스냅샷이 요청 간 늘어도 안전).
 *
 * 소유 뷰와 언급 뷰는 "행별 포함 판정(keep predicate)" 만 다르고, 정규화·dedup·집계·정렬·
 * keyset 페이지네이션은 완전히 동일하다 → 공유 core(aggregateUrlsCore·aggregatePromptsCore)로
 * 단일화하고, 두 뷰는 keep predicate 만 주입하는 얇은 래퍼로 둔다 (로직 중복·드리프트 제거).
 */

import { SOCIAL_PLATFORM_DOMAINS } from "@/components/dashboard/citation-utils";

/** promptText 가 null/공백일 때 표시할 라벨 (계획 M-1) */
export const EMPTY_PROMPT_LABEL = "(제목 없는 질문)";

/** provider 값이 없거나 빈 문자열일 때 표기 (계획 L-2) */
export const UNKNOWN_PROVIDER = "unknown";

/** URL당 inline 으로 내려보낼 프롬프트 top-N 기본값 (계획 M-4) */
export const DEFAULT_PROMPT_INLINE_LIMIT = 20;

/**
 * 병합 key 산출 시 제거할 tracking 파라미터 (계획 H-4).
 * 의미 있는 query(?id=·?post= 등)는 보존하고, 유입 추적용 파라미터만 제거한다.
 * 확장 가능 — 새 tracking 파라미터 발견 시 여기 추가.
 */
export const TRACKING_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "igshid",
  "ref",
  "spm",
  "mc_cid",
  "mc_eid",
  "yclid",
  "msclkid",
  "_hsenc",
  "_hsmi",
];

const TRACKING_PARAM_SET = new Set<string>(TRACKING_PARAMS);

/**
 * env 파생 정수 상수를 안전하게 확정한다 (계획 Info-2).
 *
 * `Number(process.env.X ?? default)` 는 잘못된 env 값(빈 문자열·"abc"·"-5"·"1e9" 등)에서
 * NaN·음수·비정상 큰 값을 그대로 흘려보낸다. 특히 STATEMENT_TIMEOUT_MS 는 raw SQL 로
 * 인라인되므로(계획 B-1) 정수 검증이 필수다.
 *
 * 규칙:
 *   - 정수(Number.isInteger)가 아니거나 범위(min~max)를 벗어나면 fallback 으로 대체
 *   - fallback 자체도 정수·범위 내여야 함(개발 실수 방지)
 *
 * @returns min~max 범위의 안전한 정수. 항상 정수 리터럴로 raw SQL 에 인라인해도 안전.
 */
export function safeEnvInt(
  raw: string | number | undefined | null,
  opts: { fallback: number; min: number; max: number },
): number {
  const { fallback, min, max } = opts;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  // fallback 도 방어적으로 클램프 (개발 실수로 fallback 이 범위 밖이어도 안전 정수 보장)
  const fb = Number.isInteger(fallback) ? fallback : Math.trunc(fallback);
  return Math.min(Math.max(fb, min), max);
}

/** 정규화 결과 — 병합 key 와 표시용 원본 URL 분리 */
export type NormalizedCitationUrl = {
  /** 병합·매칭 판정용 안정 key (host www./m. 제거 + path + 정렬된 의미 query). UI 안정 key·디버그 용도. */
  canonicalUrlKey: string;
  /** 실제 인용된 원본 URL (모바일 서브도메인·원본 query 보존) — 표시용 */
  displayUrl: string;
  /** 소셜 플랫폼 여부와 무관한 host (파생 표시값·fallback) */
  host: string;
};

/**
 * citation URL → { canonicalUrlKey, displayUrl } 정규화.
 *
 * 병합 key 규칙 (canonicalUrlKey):
 *   - scheme 없으면 https:// 부여
 *   - host: www./m. 제거 + 소문자 (citation-utils 의 normalizeTargetKey host 규칙과 정합)
 *   - 소셜 플랫폼(youtube 등)은 host + 첫 경로 세그먼트(채널 핸들)까지 key 에 포함 (남의 채널과 구분)
 *   - path: 트레일링 슬래시 1개 제거 (단 "/" 만이면 유지)
 *   - fragment(#...) 제거
 *   - query: tracking 파라미터만 제거하고 나머지는 key=value 정렬 후 보존
 *
 * displayUrl 은 원본을 최대한 보존하되 scheme 만 보정한다.
 *
 * @returns 파싱 실패(invalid URL) 시 null → 호출부에서 invalidCitationCount 증가.
 */
export function normalizeCitationUrl(rawUrl: string): NormalizedCitationUrl | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }

  const host = u.hostname.replace(/^www\./i, "").replace(/^m\./i, "").toLowerCase();
  if (!host) return null;

  // path 정규화 — 트레일링 슬래시 1개 제거 (루트 "/" 는 유지)
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.replace(/\/+$/, "");
    if (path === "") path = "/";
  }

  // query 정규화 — tracking 제거 + 나머지 key=value 정렬 보존
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAM_SET.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const queryKey = kept.length
    ? "?" + kept.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join("&")
    : "";

  // 소셜 플랫폼은 첫 경로 세그먼트(핸들)를 소문자로 정규화해 host key 에 편입한다
  // (citation-utils 규칙 정합 — 남의 채널과 구분). 나머지 경로 세그먼트는 그대로 이어붙인다.
  let hostKey = host;
  let keyPath = path; // canonicalUrlKey 뒤에 붙일 경로 부분
  if (SOCIAL_PLATFORM_DOMAINS.has(host)) {
    const segs = path.replace(/^\/+/, "").split("/");
    const firstSeg = (segs[0] ?? "").toLowerCase();
    if (firstSeg) {
      hostKey = `${host}/${firstSeg}`;
      // 첫 세그먼트는 hostKey 에 흡수됐으므로 나머지 경로만 남긴다
      const rest = segs.slice(1).join("/");
      keyPath = rest ? `/${rest}` : "";
    } else {
      keyPath = "";
    }
  }

  const canonicalUrlKey = `${hostKey}${keyPath === "/" ? "" : keyPath}${queryKey}`;

  return {
    canonicalUrlKey,
    displayUrl: withScheme,
    host,
  };
}

/** SQL 이 방출하는 펼쳐진 citation 한 행 (jsonb_array_elements 결과 + run 메타) */
export type CitationRow = {
  /** run 식별자 — per-run dedup 에 사용 (계획 D2) */
  runId: string;
  /** citation url (없으면 domain 으로 fallback — 계획 M-7) */
  url: string | null;
  /** citation domain (url 부재 시 canonicalUrlKey 산출에 사용) */
  domain: string | null;
  /** 이 citation 이 방출된 run 의 프롬프트 텍스트 */
  promptText: string | null;
  /** 이 citation 이 방출된 run 의 provider */
  provider: string | null;
  /** 이 citation 이 방출된 run 의 생성 시각 (ISO 문자열 또는 Date) */
  createdAt: string | Date;
  /**
   * 인용의 제목 — "브랜드 언급 출처(제3자)" 뷰의 언급 판정·대표 제목 표시에 사용.
   * 소유 URL 뷰는 무시한다 (optional — 소유 경로 호출부는 전달 불필요).
   */
  title?: string | null;
  /**
   * 인용의 설명 — 언급 판정(title 과 함께 검사)에 사용. 소유 URL 뷰는 무시.
   */
  description?: string | null;
};

/** URL 을 인용한 프롬프트 한 건 (드릴다운 항목) */
export type UrlPromptRef = {
  promptText: string;
  count: number;
  providers: string[];
  lastSeen: string;
};

/** 브랜드 공식 URL 집계 결과 한 건 (소유 뷰) */
export type BrandCitationUrl = {
  displayUrl: string;
  canonicalUrlKey: string;
  domain: string;
  totalCount: number;
  providers: string[];
  firstSeen: string;
  lastSeen: string;
  /** inline top-N 프롬프트 (계획 M-4) */
  prompts: UrlPromptRef[];
  /** 더 조회할 프롬프트가 있으면 true → prompts endpoint 로 나머지 조회 */
  hasMorePrompts: boolean;
};

/**
 * 브랜드 언급 출처(제3자) 집계 결과 한 건 (언급 뷰).
 * BrandCitationUrl 과 동일하되 대표 제목(title)을 추가로 노출한다 — 제3자 페이지(보도자료·기사)는
 * URL 보다 "제목(헤드라인)" 이 사용자 식별에 유용하기 때문.
 */
export type BrandMentionUrl = BrandCitationUrl & {
  /** 대표 제목 — firstSeen(최초 등장) 행의 citation title. 없으면 빈 문자열(UI 는 URL 로 fallback). */
  title: string;
};

/** keyset cursor 페이로드 — (totalCount, canonicalUrlKey) 복합 keyset (계획 D5) */
export type UrlCursor = { t: number; k: string };

/** aggregateBrandCitationUrls 옵션 (소유 뷰) */
export type AggregateOptions = {
  /** 브랜드 매칭 key 집합 (buildTargetKeys 결과 — host 또는 host/seg) */
  brandKeySet: Set<string>;
  /** URL당 inline 프롬프트 top-N (기본 20) */
  promptInlineLimit?: number;
  /** 페이지 크기 (URL 개수) */
  pageSize?: number;
  /** 이전 페이지에서 이어받은 keyset cursor (없으면 첫 페이지) */
  cursor?: UrlCursor | null;
};

/** aggregateBrandCitationUrls 반환 (소유 뷰) */
export type AggregateResult = {
  /** 전체 고유 브랜드 URL 수 (페이지네이션 전 총계) */
  uniqueUrlCount: number;
  /** invalid(파싱 실패)로 제외된 citation 수 */
  invalidCitationCount: number;
  /** 이번 페이지 URL 목록 */
  urls: BrandCitationUrl[];
  /** 다음 페이지 cursor (없으면 null) */
  nextCursor: UrlCursor | null;
};

/** aggregateBrandMentionUrls 옵션 (언급 뷰) */
export type MentionAggregateOptions = {
  /** 소유(내 사이트) 판정용 브랜드 매칭 key 집합 — 여기 매칭되면 언급 뷰에서 제외(중복 방지) */
  brandKeySet: Set<string>;
  /** 언급 판정용 브랜드 용어(brandName + brandAliases). title/description 에 포함되면 언급 */
  brandTerms: string[];
  promptInlineLimit?: number;
  pageSize?: number;
  cursor?: UrlCursor | null;
};

/** aggregateBrandMentionUrls 반환 (언급 뷰) */
export type MentionAggregateResult = {
  uniqueUrlCount: number;
  invalidCitationCount: number;
  urls: BrandMentionUrl[];
  nextCursor: UrlCursor | null;
};

/**
 * citation URL 이 브랜드 공식 채널(brandKeySet)에 속하는지 판정.
 * canonicalUrlKey 의 host(소셜은 host/seg)를 buildTargetKeys 규칙과 동일하게 비교.
 * (일반 도메인은 서브도메인 포함 매치, 소셜은 host/seg 완전 일치)
 *
 * 소유 뷰(포함 판정)와 언급 뷰(제외 판정) 양쪽이 같은 규칙을 써야 두 목록이 정확히 상보적이므로
 * export 해 재사용한다.
 */
export function isBrandCitationKey(
  host: string,
  canonicalUrlKey: string,
  brandKeySet: Set<string>,
): boolean {
  if (SOCIAL_PLATFORM_DOMAINS.has(host)) {
    // 소셜: canonicalUrlKey 의 host/seg 접두(경로 나머지·query 제외)를 brandKeySet 과 비교
    // canonicalUrlKey 형식: "host/seg[/rest][?query]"
    const withoutQuery = canonicalUrlKey.split("?", 1)[0];
    const parts = withoutQuery.split("/");
    const hostSeg = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    return brandKeySet.has(hostSeg);
  }
  // 일반 도메인: host 자체 또는 상위 등록 도메인(서브도메인 포함)과 매치
  if (brandKeySet.has(host)) return true;
  for (const key of brandKeySet) {
    if (key.includes("/")) continue; // 소셜 키는 스킵
    if (host.endsWith(`.${key}`)) return true;
  }
  return false;
}

/**
 * 인용의 제목/설명에 브랜드 용어(이름/별칭)가 하나라도 포함되는지 (언급 판정).
 *
 * citation-utils 의 isRelatedCitation 과 동일 규칙(대소문자 무시 substring)을 DB 행 기준으로 재현한다.
 * SQL 의 ILIKE 사전 필터(buildBrandMentionPrefilter)와 동일 의미이므로, SQL 은 후보만 좁히고
 * 최종 판정은 이 순수함수가 유지한다 (DB 무의존 테스트 + 판정 일관성).
 *
 * @returns brandTerms 비어있거나 title·description 모두 공백이면 false.
 */
export function isBrandMentionText(
  title: string | null | undefined,
  description: string | null | undefined,
  brandTerms: string[] | undefined,
): boolean {
  if (!brandTerms?.length) return false;
  const haystack = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return brandTerms.some((t) => {
    const term = t?.trim().toLowerCase();
    return !!term && haystack.includes(term);
  });
}

/** ISO 문자열로 정규화 */
function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** provider 값 정규화 (없으면 "unknown") */
function normProvider(p: string | null | undefined): string {
  const t = (p ?? "").trim();
  return t ? t : UNKNOWN_PROVIDER;
}

/** promptText 정규화 (null/공백 → 라벨) */
function normPrompt(p: string | null | undefined): string {
  const t = (p ?? "").trim();
  return t ? t : EMPTY_PROMPT_LABEL;
}

/** title 정규화 (null/공백 → 빈 문자열. UI 가 URL 로 fallback) */
function normTitle(t: string | null | undefined): string {
  return (t ?? "").trim();
}

/**
 * 행별 포함 판정 predicate — normalize 결과 + 원본 행으로 해당 citation 을 집계에 넣을지 결정.
 * (invalid 는 normalize 실패로 core 가 자동 제외하므로 여기선 유효 행만 받는다)
 */
export type CitationKeepFn = (row: CitationRow, norm: NormalizedCitationUrl) => boolean;

/** 집계 내부 레코드 — title 포함(언급 뷰용). 소유 뷰는 title 을 버린다. */
type AggregatedUrlRecord = BrandMentionUrl;

type UrlCoreOptions = {
  keep: CitationKeepFn;
  promptInlineLimit?: number;
  pageSize?: number;
  cursor?: UrlCursor | null;
};

type UrlCoreResult = {
  uniqueUrlCount: number;
  invalidCitationCount: number;
  page: AggregatedUrlRecord[];
  nextCursor: UrlCursor | null;
};

/**
 * 펼쳐진 citation 행들을 URL 단위로 집계 + keyset 페이지네이션 (소유·언급 공통 core).
 *
 * 집계 규칙 (계획 §5 하단):
 *   - keep predicate 통과 URL 만 포함
 *   - per-run dedup: 같은 run 안의 같은 canonicalUrlKey 는 totalCount 1 회만
 *   - firstSeen = min(createdAt), lastSeen = max(createdAt)
 *   - 대표 displayUrl·title = firstSeen(최초 등장) 행의 원본 (계획 M-3)
 *   - 프롬프트 dedup: 같은 run 안의 같은 (canonicalUrlKey, promptText) 는 count 1 회만
 *   - 정렬 URL = totalCount desc, canonicalUrlKey asc
 *   - 정렬 prompt = count desc, promptText asc (comparePromptPaged)
 */
function aggregateUrlsCore(rows: CitationRow[], opts: UrlCoreOptions): UrlCoreResult {
  const promptInlineLimit = opts.promptInlineLimit ?? DEFAULT_PROMPT_INLINE_LIMIT;
  const pageSize = opts.pageSize ?? 100;
  const cursor = opts.cursor ?? null;

  let invalidCitationCount = 0;

  // canonicalUrlKey → 집계 누적 구조
  type UrlAcc = {
    canonicalUrlKey: string;
    domain: string;
    // 대표 displayUrl·title 결정을 위해 (createdAtMs, displayUrl) 최소값 추적
    firstSeenMs: number;
    firstDisplayUrl: string;
    firstTitle: string;
    lastSeenMs: number;
    firstSeen: string;
    lastSeen: string;
    // per-run dedup: run 단위로 이 URL 이 등장한 run 집합
    runSet: Set<string>;
    providerSet: Set<string>;
    // 프롬프트: promptText → 누적
    prompts: Map<string, PromptAcc>;
  };
  type PromptAcc = {
    promptText: string;
    runSet: Set<string>;
    providerSet: Set<string>;
    lastSeenMs: number;
    lastSeen: string;
  };

  const urlMap = new Map<string, UrlAcc>();

  for (const row of rows) {
    const raw = row.url || row.domain || "";
    const norm = normalizeCitationUrl(raw);
    if (!norm) {
      invalidCitationCount++;
      continue;
    }
    if (!opts.keep(row, norm)) {
      continue; // 뷰별 포함 판정에서 탈락한 URL 제외
    }

    const iso = toIso(row.createdAt);
    const ms = new Date(iso).getTime();
    const safeMs = Number.isNaN(ms) ? 0 : ms;
    const provider = normProvider(row.provider);
    const prompt = normPrompt(row.promptText);
    const title = normTitle(row.title);
    const runId = row.runId;

    let acc = urlMap.get(norm.canonicalUrlKey);
    if (!acc) {
      acc = {
        canonicalUrlKey: norm.canonicalUrlKey,
        domain: norm.host,
        firstSeenMs: safeMs,
        firstDisplayUrl: norm.displayUrl,
        firstTitle: title,
        lastSeenMs: safeMs,
        firstSeen: iso,
        lastSeen: iso,
        runSet: new Set(),
        providerSet: new Set(),
        prompts: new Map(),
      };
      urlMap.set(norm.canonicalUrlKey, acc);
    }

    // 대표 displayUrl·title / firstSeen — 더 이른 등장으로 갱신
    if (safeMs < acc.firstSeenMs) {
      acc.firstSeenMs = safeMs;
      acc.firstDisplayUrl = norm.displayUrl;
      acc.firstTitle = title;
      acc.firstSeen = iso;
    } else if (safeMs === acc.firstSeenMs && !acc.firstTitle && title) {
      // 동일 시각인데 대표 title 이 비어있고 이 행에 title 이 있으면 보강 (표시 품질)
      acc.firstTitle = title;
    }
    // lastSeen — 더 늦은 등장으로 갱신
    if (safeMs > acc.lastSeenMs) {
      acc.lastSeenMs = safeMs;
      acc.lastSeen = iso;
    }

    acc.runSet.add(runId); // per-run dedup: totalCount = 고유 run 수
    acc.providerSet.add(provider);

    // 프롬프트 누적 (per-run dedup)
    let pAcc = acc.prompts.get(prompt);
    if (!pAcc) {
      pAcc = {
        promptText: prompt,
        runSet: new Set(),
        providerSet: new Set(),
        lastSeenMs: safeMs,
        lastSeen: iso,
      };
      acc.prompts.set(prompt, pAcc);
    }
    pAcc.runSet.add(runId);
    pAcc.providerSet.add(provider);
    if (safeMs > pAcc.lastSeenMs) {
      pAcc.lastSeenMs = safeMs;
      pAcc.lastSeen = iso;
    }
  }

  // UrlAcc → AggregatedUrlRecord 변환 + 정렬
  const all: AggregatedUrlRecord[] = [...urlMap.values()].map((acc) => {
    // inline 프롬프트 정렬은 prompts endpoint 페이지네이션 정렬과 동일 기준(comparePromptPaged)을
    // 써야 병합 목록 순서가 흔들리지 않는다 (계획 M-1). count desc, promptText asc.
    const promptRefs: UrlPromptRef[] = [...acc.prompts.values()]
      .map((p) => ({
        promptText: p.promptText,
        count: p.runSet.size,
        providers: sortProviders(p.providerSet),
        lastSeen: p.lastSeen,
      }))
      .sort(comparePromptPaged);

    const inline = promptRefs.slice(0, promptInlineLimit);
    return {
      displayUrl: acc.firstDisplayUrl,
      canonicalUrlKey: acc.canonicalUrlKey,
      domain: acc.domain,
      title: acc.firstTitle,
      totalCount: acc.runSet.size,
      providers: sortProviders(acc.providerSet),
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
      prompts: inline,
      hasMorePrompts: promptRefs.length > inline.length,
    };
  });

  all.sort(compareUrl);

  const uniqueUrlCount = all.length;

  // keyset 페이지네이션 — cursor 이후 항목부터 pageSize 만큼
  const startIdx = cursor ? firstIndexAfterCursor(all, cursor) : 0;
  const page = all.slice(startIdx, startIdx + pageSize);
  const hasMore = startIdx + pageSize < all.length;
  const nextCursor: UrlCursor | null =
    hasMore && page.length > 0
      ? { t: page[page.length - 1].totalCount, k: page[page.length - 1].canonicalUrlKey }
      : null;

  return { uniqueUrlCount, invalidCitationCount, page, nextCursor };
}

/** AggregatedUrlRecord → BrandCitationUrl (소유 뷰는 title 을 노출하지 않음 — 기존 응답 shape 보존) */
function toBrandCitationUrl(r: AggregatedUrlRecord): BrandCitationUrl {
  const { title: _title, ...rest } = r;
  return rest;
}

/**
 * 내 사이트(브랜드 공식) URL 전수 집계 + keyset 페이지네이션 (소유 뷰).
 * 브랜드 매칭 URL 만 포함, 비브랜드 제외.
 */
export function aggregateBrandCitationUrls(
  rows: CitationRow[],
  opts: AggregateOptions,
): AggregateResult {
  const core = aggregateUrlsCore(rows, {
    keep: (_row, norm) => isBrandCitationKey(norm.host, norm.canonicalUrlKey, opts.brandKeySet),
    promptInlineLimit: opts.promptInlineLimit,
    pageSize: opts.pageSize,
    cursor: opts.cursor,
  });
  return {
    uniqueUrlCount: core.uniqueUrlCount,
    invalidCitationCount: core.invalidCitationCount,
    urls: core.page.map(toBrandCitationUrl),
    nextCursor: core.nextCursor,
  };
}

/**
 * 브랜드 언급 출처(제3자) URL 전수 집계 + keyset 페이지네이션 (언급 뷰).
 *
 * 포함 조건 (2단):
 *   1. 인용의 title/description 에 브랜드 용어(별칭 포함)가 하나라도 포함 (isBrandMentionText)
 *   2. 그 URL 이 내 사이트(brandKeySet)에 매칭되지 **않음** (소유 뷰와 중복 방지)
 *   → 즉 "제3자 페이지가 브랜드를 언급" 한 인용만 집계.
 */
export function aggregateBrandMentionUrls(
  rows: CitationRow[],
  opts: MentionAggregateOptions,
): MentionAggregateResult {
  const core = aggregateUrlsCore(rows, {
    keep: (row, norm) =>
      isBrandMentionText(row.title, row.description, opts.brandTerms) &&
      !isBrandCitationKey(norm.host, norm.canonicalUrlKey, opts.brandKeySet),
    promptInlineLimit: opts.promptInlineLimit,
    pageSize: opts.pageSize,
    cursor: opts.cursor,
  });
  return {
    uniqueUrlCount: core.uniqueUrlCount,
    invalidCitationCount: core.invalidCitationCount,
    urls: core.page,
    nextCursor: core.nextCursor,
  };
}

/** provider 집합 → 유니크 정렬 배열 */
function sortProviders(set: Set<string>): string[] {
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** URL 정렬 비교자: totalCount desc, canonicalUrlKey asc (소유·언급 레코드 공통) */
function compareUrl(
  a: { totalCount: number; canonicalUrlKey: string },
  b: { totalCount: number; canonicalUrlKey: string },
): number {
  if (a.totalCount !== b.totalCount) return b.totalCount - a.totalCount;
  return a.canonicalUrlKey < b.canonicalUrlKey ? -1 : a.canonicalUrlKey > b.canonicalUrlKey ? 1 : 0;
}

/**
 * 프롬프트 정렬 비교자 (inline·페이지네이션 공통): count desc, promptText asc.
 *
 * 계획 M-1: inline top-N 정렬과 prompts endpoint 페이지네이션 정렬을 동일 기준으로 통일해
 * 병합 목록 순서가 흔들리지 않게 한다. prompts endpoint 의 keyset cursor 는 (count, promptText)
 * 이므로 정렬도 이 기준을 정확히 따라야 페이지 경계에서 누락/중복이 없다
 * (lastSeen 은 동일 count 안에서 결정적 tiebreak 로 부적합해 제외).
 */
export function comparePromptPaged(a: UrlPromptRef, b: UrlPromptRef): number {
  if (a.count !== b.count) return b.count - a.count;
  return a.promptText < b.promptText ? -1 : a.promptText > b.promptText ? 1 : 0;
}

/**
 * 정렬된 URL 배열에서 cursor "다음" 항목의 시작 인덱스.
 * 정렬 기준(totalCount desc, canonicalUrlKey asc)에 맞춰
 * (totalCount < t) OR (totalCount == t AND canonicalUrlKey > k) 인 첫 항목.
 */
function firstIndexAfterCursor(
  sorted: Array<{ totalCount: number; canonicalUrlKey: string }>,
  cursor: UrlCursor,
): number {
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i];
    if (u.totalCount < cursor.t) return i;
    if (u.totalCount === cursor.t && u.canonicalUrlKey > cursor.k) return i;
  }
  return sorted.length;
}

/** keyset cursor → 불투명 base64 문자열 */
export function encodeCursor(cursor: UrlCursor): string {
  const json = JSON.stringify({ t: cursor.t, k: cursor.k });
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * 불투명 base64 → keyset cursor.
 * 파싱 실패·형식 불일치 시 null (호출부에서 400 invalid_cursor).
 */
export function decodeCursor(raw: string | null | undefined): UrlCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as UrlCursor).t === "number" &&
      Number.isFinite((parsed as UrlCursor).t) &&
      typeof (parsed as UrlCursor).k === "string"
    ) {
      return { t: (parsed as UrlCursor).t, k: (parsed as UrlCursor).k };
    }
    return null;
  } catch {
    return null;
  }
}

/** 프롬프트 cursor — (count, promptText) 복합 keyset */
export type PromptCursor = { c: number; p: string };

/** aggregatePromptsForUrl 반환 */
export type PromptPageResult = {
  /** 이 URL 의 전체 고유 프롬프트 수 */
  promptCount: number;
  prompts: UrlPromptRef[];
  nextCursor: PromptCursor | null;
};

type PromptCoreOptions = {
  keep: CitationKeepFn;
  pageSize?: number;
  cursor?: PromptCursor | null;
};

/**
 * 특정 canonicalUrlKey 의 프롬프트를 전수 집계 + keyset 페이지네이션 (소유·언급 공통 core).
 * rows 는 해당 URL 로 좁혀졌다고 가정하지 않고, 이 함수 내에서 canonicalUrlKey 매칭으로 필터한다.
 */
function aggregatePromptsCore(
  rows: CitationRow[],
  targetCanonicalUrlKey: string,
  opts: PromptCoreOptions,
): PromptPageResult {
  const pageSize = opts.pageSize ?? 50;
  const cursor = opts.cursor ?? null;

  type PromptAcc = {
    promptText: string;
    runSet: Set<string>;
    providerSet: Set<string>;
    lastSeenMs: number;
    lastSeen: string;
  };
  const prompts = new Map<string, PromptAcc>();

  for (const row of rows) {
    const raw = row.url || row.domain || "";
    const norm = normalizeCitationUrl(raw);
    if (!norm) continue;
    if (norm.canonicalUrlKey !== targetCanonicalUrlKey) continue;
    if (!opts.keep(row, norm)) continue;

    const iso = toIso(row.createdAt);
    const ms = new Date(iso).getTime();
    const safeMs = Number.isNaN(ms) ? 0 : ms;
    const provider = normProvider(row.provider);
    const prompt = normPrompt(row.promptText);

    let pAcc = prompts.get(prompt);
    if (!pAcc) {
      pAcc = { promptText: prompt, runSet: new Set(), providerSet: new Set(), lastSeenMs: safeMs, lastSeen: iso };
      prompts.set(prompt, pAcc);
    }
    pAcc.runSet.add(row.runId);
    pAcc.providerSet.add(provider);
    if (safeMs > pAcc.lastSeenMs) {
      pAcc.lastSeenMs = safeMs;
      pAcc.lastSeen = iso;
    }
  }

  const all: UrlPromptRef[] = [...prompts.values()]
    .map((p) => ({
      promptText: p.promptText,
      count: p.runSet.size,
      providers: sortProviders(p.providerSet),
      lastSeen: p.lastSeen,
    }))
    .sort(comparePromptPaged);

  const promptCount = all.length;
  const startIdx = cursor ? firstPromptIndexAfterCursor(all, cursor) : 0;
  const page = all.slice(startIdx, startIdx + pageSize);
  const hasMore = startIdx + pageSize < all.length;
  const nextCursor: PromptCursor | null =
    hasMore && page.length > 0
      ? { c: page[page.length - 1].count, p: page[page.length - 1].promptText }
      : null;

  return { promptCount, prompts: page, nextCursor };
}

/** 소유(내 사이트) URL 의 프롬프트 전수 집계 (prompts endpoint 용). */
export function aggregatePromptsForUrl(
  rows: CitationRow[],
  targetCanonicalUrlKey: string,
  opts: { brandKeySet: Set<string>; pageSize?: number; cursor?: PromptCursor | null },
): PromptPageResult {
  return aggregatePromptsCore(rows, targetCanonicalUrlKey, {
    keep: (_row, norm) => isBrandCitationKey(norm.host, norm.canonicalUrlKey, opts.brandKeySet),
    pageSize: opts.pageSize,
    cursor: opts.cursor,
  });
}

/** aggregateMentionPromptsForUrl 옵션 */
export type MentionPromptsOptions = {
  brandKeySet: Set<string>;
  brandTerms: string[];
  pageSize?: number;
  cursor?: PromptCursor | null;
};

/** 브랜드 언급 출처(제3자) URL 의 프롬프트 전수 집계 (brand-mentions/prompts endpoint 용). */
export function aggregateMentionPromptsForUrl(
  rows: CitationRow[],
  targetCanonicalUrlKey: string,
  opts: MentionPromptsOptions,
): PromptPageResult {
  return aggregatePromptsCore(rows, targetCanonicalUrlKey, {
    keep: (row, norm) =>
      isBrandMentionText(row.title, row.description, opts.brandTerms) &&
      !isBrandCitationKey(norm.host, norm.canonicalUrlKey, opts.brandKeySet),
    pageSize: opts.pageSize,
    cursor: opts.cursor,
  });
}

/** 프롬프트 정렬(count desc, promptText asc) 기준 cursor 다음 인덱스.
 * count 만으로 keyset 을 안전히 하려면 tiebreak 로 promptText asc 를 함께 본다.
 * (동일 count 안에서 lastSeen 은 흔들릴 수 있으므로 결정적 tiebreak 는 promptText 사용) */
function firstPromptIndexAfterCursor(sorted: UrlPromptRef[], cursor: PromptCursor): number {
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.count < cursor.c) return i;
    if (p.count === cursor.c && p.promptText > cursor.p) return i;
  }
  return sorted.length;
}

export function encodePromptCursor(cursor: PromptCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.c, p: cursor.p }), "utf8").toString("base64url");
}

export function decodePromptCursor(raw: string | null | undefined): PromptCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as PromptCursor).c === "number" &&
      Number.isFinite((parsed as PromptCursor).c) &&
      typeof (parsed as PromptCursor).p === "string"
    ) {
      return { c: (parsed as PromptCursor).c, p: (parsed as PromptCursor).p };
    }
    return null;
  } catch {
    return null;
  }
}
