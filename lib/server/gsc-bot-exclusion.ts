/**
 * gsc-bot-exclusion.ts — GSC 검색어에서 geo-tracker 자동 조사 질문(봇 트래픽)을 제외하고
 * 실사용자 검색어만 남기는 순수함수 모음.
 *
 * 배경(운영 DB·라이브 검증 확인):
 *   GeoTracker 의 SRO 파이프라인은 자동 조사 프롬프트(약 27종)를 Google AI Mode
 *   (google.com/search?udm=50) 에 직접 검색한다. 이 과정에서 매직바디가 노출되며
 *   GSC 에 "질문형 검색어"로 잡힌다 — 실사용자 검색이 아니다. 이런 봇 질문이
 *   actionable(기회/빠른개선/뜨는검색어)·topQueries 를 오염시킨다.
 *
 *   → 봇 프롬프트 문자열과 정확히 일치하는 GSC 검색어를 제외해 실사용자 검색만 남긴다.
 *
 * 외부 의존(googleapis·drizzle·next) 없는 순수 계산만 모아 단위 테스트 가능하게 분리.
 * DB 에서 봇 프롬프트 집합을 가져오는 책임은 gsc-bot-prompts.ts(부수효과)가 담당한다.
 */

/**
 * 검색어/프롬프트 정규화 — 봇 질문 제외 매칭의 기준.
 *   - 앞뒤 공백 제거(trim)
 *   - 연속 공백을 단일 공백으로 정리(전각/탭/개행 포함)
 *   - 소문자화(영문 대소문자 무시)
 *
 * 한국어는 대소문자 개념이 없어 toLowerCase 영향이 없고, 영문 혼용 프롬프트의
 * 대소문자 차이만 흡수한다. GSC 검색어와 프롬프트 원문을 같은 규칙으로 정규화한 뒤
 * 정확 일치(===) 비교한다.
 */
export function normalizeQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 봇 프롬프트 문자열 배열 → 정규화된 Set.
 * 빈 문자열·공백만 있는 항목은 제외(빈 검색어를 통째로 거르는 사고 방지).
 */
export function buildBotPromptSet(prompts: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const p of prompts) {
    if (typeof p !== "string") continue;
    const norm = normalizeQuery(p);
    if (norm.length > 0) set.add(norm);
  }
  return set;
}

/** 검색어 row(첫 키가 query) 형태의 최소 인터페이스 */
export interface QueryKeyedRow {
  query: string;
}

/**
 * GSC 검색어 결과에서 봇 프롬프트와 정확 일치하는 행을 제외한다.
 *   - 매칭: normalizeQuery(query) 가 botPromptSet 에 존재하면 제외
 *   - botPromptSet 이 비어 있으면(예: 로컬 DB off) 원본을 그대로 반환(기존 동작 유지)
 *
 * @returns kept(남은 실사용자 검색어) + excludedCount(제외된 봇 질문 수)
 */
export function excludeBotQueries<T extends QueryKeyedRow>(
  rows: T[],
  botPromptSet: Set<string>,
): { kept: T[]; excludedCount: number } {
  if (botPromptSet.size === 0) {
    return { kept: rows, excludedCount: 0 };
  }
  const kept: T[] = [];
  let excludedCount = 0;
  for (const row of rows) {
    if (botPromptSet.has(normalizeQuery(row.query ?? ""))) {
      excludedCount += 1;
    } else {
      kept.push(row);
    }
  }
  return { kept, excludedCount };
}

/**
 * 브랜드 명 + 별칭 문자열 → 정규화 브랜드 토큰 배열.
 *   - brandName: 단일 문자열
 *   - brandAliases: 쉼표/세미콜론/개행 구분 문자열
 * branded-query-filter.buildBrandTerms 와 같은 의미지만 BrandConfig(DB 타입) 의존 없이
 * 순수 문자열만 받아 테스트 가능하게 둔다.
 */
export function buildBrandTermsFromStrings(
  brandName: string | null | undefined,
  brandAliases: string | null | undefined,
): string[] {
  const set = new Set<string>();
  const add = (raw: string) => {
    const norm = normalizeQuery(raw);
    if (norm.length > 0) set.add(norm);
  };
  if (brandName) add(brandName);
  if (brandAliases) {
    for (const raw of brandAliases.split(/[,;\n]/)) add(raw);
  }
  return [...set];
}

/**
 * 검색어가 브랜드 검색인지 판정 — 정규화된 검색어에 브랜드 토큰이 부분 포함되면 true.
 * 브랜드 토큰이 비어 있으면 항상 false(브랜드 미설정 시 전부 일반 검색 취급).
 */
export function isBrandQuery(query: string, brandTerms: string[]): boolean {
  if (brandTerms.length === 0) return false;
  const norm = normalizeQuery(query);
  if (norm.length === 0) return false;
  return brandTerms.some((term) => norm.includes(term));
}

export interface BrandSearchQueryStat {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface BrandSearchDailyPoint {
  date: string;
  clicks: number;
  impressions: number;
}

export interface BrandSearchSummary {
  /** 브랜드 토큰이 1개 이상 설정됐는지 — UI 가 "브랜드 미설정" 안내를 띄울지 판단 */
  configured: boolean;
  totals: { clicks: number; impressions: number };
  totalsPrev: { clicks: number; impressions: number };
  /** 브랜드 검색어 목록(클릭 내림차순) */
  queries: BrandSearchQueryStat[];
  /** 일자별 브랜드 검색 추이(클릭·노출) — 날짜 오름차순 */
  daily: BrandSearchDailyPoint[];
}

interface QueryStatInput {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface DateQueryInput {
  date: string;
  query: string;
  clicks: number;
  impressions: number;
}

/**
 * 브랜드 검색 추이 요약을 계산한다(실사용자 중심 재배치의 상단 카드).
 *   - queries/queriesPrev: 현재·직전 기간의 (이미 봇 제외된) 검색어 단위 집계
 *   - dateQueries: 현재 기간의 date×query 행(봇 제외 후) — 브랜드 검색만 일자 합산
 *
 * 브랜드 토큰이 없으면 configured=false + 빈 결과(과장 없이 "미설정" 표기 유도).
 */
export function computeBrandSearch(input: {
  queries: QueryStatInput[];
  queriesPrev: QueryStatInput[];
  dateQueries: DateQueryInput[];
  brandTerms: string[];
  queryLimit?: number;
}): BrandSearchSummary {
  const { queries, queriesPrev, dateQueries, brandTerms, queryLimit = 20 } = input;
  const configured = brandTerms.length > 0;

  if (!configured) {
    return {
      configured: false,
      totals: { clicks: 0, impressions: 0 },
      totalsPrev: { clicks: 0, impressions: 0 },
      queries: [],
      daily: [],
    };
  }

  const brandQueries = queries.filter((r) => isBrandQuery(r.query, brandTerms));
  const brandQueriesPrev = queriesPrev.filter((r) => isBrandQuery(r.query, brandTerms));

  const sum = (rows: QueryStatInput[]) =>
    rows.reduce(
      (acc, r) => ({
        clicks: acc.clicks + r.clicks,
        impressions: acc.impressions + r.impressions,
      }),
      { clicks: 0, impressions: 0 },
    );

  // 일자별 브랜드 검색 합산
  const dailyMap = new Map<string, { clicks: number; impressions: number }>();
  for (const row of dateQueries) {
    if (!isBrandQuery(row.query, brandTerms)) continue;
    const cur = dailyMap.get(row.date) ?? { clicks: 0, impressions: 0 };
    cur.clicks += row.clicks;
    cur.impressions += row.impressions;
    dailyMap.set(row.date, cur);
  }
  const daily: BrandSearchDailyPoint[] = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, clicks: v.clicks, impressions: v.impressions }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    configured: true,
    totals: sum(brandQueries),
    totalsPrev: sum(brandQueriesPrev),
    queries: [...brandQueries]
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, queryLimit),
    daily,
  };
}
