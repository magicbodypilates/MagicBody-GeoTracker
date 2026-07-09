/**
 * citation-brand-host-filter.ts — 브랜드 관련 citation 사전 필터(superset) SQL 조립 헬퍼.
 *
 * 두 종류의 사전 필터를 제공한다 (공통 ILIKE 이스케이프·injection 방어 규칙 공유):
 *   1. buildBrandHostPrefilter  — 인용 URL/도메인이 내 사이트(브랜드 공식 호스트)를 포함할 후보
 *      (소유 URL 뷰: /stats/citations/urls).
 *   2. buildBrandMentionPrefilter — 인용 제목/설명에 브랜드명(별칭)이 언급된 후보
 *      (제3자 언급 뷰: /stats/citations/brand-mentions).
 * 두 필터 모두 superset(후보만 좁힘) — 최종 정확 판정은 순수함수(citation-url-aggregate)가 유지한다.
 *
 * 배경(실데이터 스모크 결함):
 *   신규 "인용 URL" 라우트는 runs → jsonb_array_elements(citations) 로 citation 을 행으로 펼친 뒤
 *   행 cap(CITATION_ROW_CAP, 기본 5만)으로 스캔량을 방어한다. 그런데 이 cap 은 브랜드·경쟁사·제3자
 *   citation 을 가리지 않고 전부에 걸리므로, 정작 내 사이트(브랜드) citation 이 cap 뒤로 밀려 잘릴 수
 *   있었다. 사용자 요구는 "내 사이트가 한 번이라도 인용된 주소 전수"이므로 이 truncation 은 요구 위반.
 *
 * 해결(superset 사전 필터):
 *   펼쳐지는 citation 을 SQL WHERE 단계에서 "브랜드 공식 도메인을 포함할 가능성이 있는 것"으로 미리
 *   좁힌다. 브랜드 citation 은 양이 훨씬 작아 cap 에 걸리지 않고 전수가 보장된다.
 *
 * 정확성 불변(2단 전략):
 *   - SQL 필터는 **superset**(후보만 좁힘) — 공용 소셜 호스트(youtube.com·blog.naver.com 등)는 남의
 *     채널도 함께 통과한다. host 단위 substring 매칭이므로 과대 포함이 있을 수 있다.
 *   - 최종 정확 판정(host + 소셜 핸들)은 기존 순수함수(citation-url-aggregate 의 브랜드 매칭)가 그대로
 *     수행한다. 즉 SQL 은 후보만 좁히고, 브랜드 여부 판정은 JS 가 유지 → 결과 정확성 불변, cap
 *     truncation 만 제거.
 *
 * 안전:
 *   - 호스트는 DB(brandConfig.websites) 유래지만 SQL injection 방어를 위해 항상 드리즐 파라미터 바인딩.
 *   - ILIKE 특수문자(\ % _)는 이스케이프하고 ESCAPE '\' 를 명시해 와일드카드 오작동을 막는다.
 *   - 브랜드 호스트가 하나도 없으면(브랜드 URL 미등록) 항상-거짓 조건(FALSE)을 반환해 SQL 이 0 행을
 *     방출하게 한다(빈 결과·cap 위험 없음). 절대 항상-참으로 새지 않는다.
 */

import { sql, type SQL } from "drizzle-orm";
import { normalizeTargetKey } from "@/components/dashboard/citation-utils";

/**
 * brandConfig.websites → 정규화된 호스트 목록(www./m. 제거·소문자·중복 제거).
 *
 * citation-utils 의 normalizeTargetKey 와 동일한 host 정규화 규칙을 재사용해 매칭 일관성을 유지한다.
 * 소셜 플랫폼(youtube.com 등)도 host 만 뽑는다 — 핸들 정확 판정은 JS 순수함수가 나중에 수행하고,
 * 여기서는 superset 후보만 좁히면 되기 때문이다.
 *
 * @returns 파싱 가능한 호스트만. 비거나 파싱 실패한 항목은 제외. 빈 배열이면 브랜드 URL 미등록.
 */
export function extractBrandHosts(websites: string[] | undefined | null): string[] {
  if (!websites?.length) return [];
  const hosts = new Set<string>();
  for (const url of websites) {
    const k = normalizeTargetKey(url);
    if (k?.host) hosts.add(k.host);
  }
  return [...hosts];
}

/**
 * ILIKE 패턴에서 와일드카드로 해석되는 특수문자를 이스케이프.
 * 백슬래시를 먼저 이스케이프해야 이중 이스케이프를 막는다. ESCAPE '\' 절과 함께 써야 한다.
 */
function escapeIlike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * 브랜드 호스트 superset 사전 필터 SQL 을 조립.
 *
 * 각 호스트 h 에 대해 `(cite->>'url' ILIKE '%h%' ESCAPE '\' OR cite->>'domain' ILIKE '%h%' ESCAPE '\')`
 * 를 만들고, 모든 호스트를 OR 로 묶는다. 호스트 값은 드리즐 파라미터로 바인딩되고(injection 방어),
 * ILIKE 특수문자는 이스케이프된다.
 *
 * @param hosts extractBrandHosts 결과(이미 정규화된 호스트)
 * @returns 사전 필터 SQL. 호스트가 없으면 항상-거짓(`FALSE`) — SQL 이 0 행을 방출(빈 결과).
 */
export function buildBrandHostPrefilter(hosts: string[]): SQL {
  if (hosts.length === 0) {
    // 브랜드 URL 미등록 → 어떤 citation 도 통과시키지 않는다(빈 결과). 항상-참으로 새지 않게 방어.
    return sql`FALSE`;
  }

  const perHost: SQL[] = hosts.map((h) => {
    // 이스케이프된 패턴 문자열 전체를 파라미터로 바인딩한다(injection 방어). ESCAPE '\' 로 이스케이프 활성화.
    // cite 는 jsonb_array_elements 로 이미 펼쳐진 개별 citation 이므로 cite->>'url'/'domain' 을 대상으로 한다.
    const pattern = `%${escapeIlike(h)}%`;
    return sql`(${sql.raw("cite->>'url'")} ILIKE ${pattern} ESCAPE '\\' OR ${sql.raw("cite->>'domain'")} ILIKE ${pattern} ESCAPE '\\')`;
  });

  // 모든 호스트 조건을 OR 로 결합
  return sql`(${sql.join(perHost, sql` OR `)})`;
}

/**
 * 브랜드 언급(제3자) superset 사전 필터 SQL 을 조립.
 *
 * 각 브랜드 용어 t 에 대해
 *   `(cite->>'title' ILIKE '%t%' ESCAPE '\' OR cite->>'description' ILIKE '%t%' ESCAPE '\')`
 * 를 만들고, 모든 용어를 OR 로 묶는다. 용어 값은 드리즐 파라미터로 바인딩되고(injection 방어),
 * ILIKE 특수문자는 이스케이프된다. 최종 언급 정확 판정(isBrandMentionText)은 JS 순수함수가 유지한다.
 *
 * @param terms brandName + brandAliases (getBrandTermsForWorkspace 결과). 공백 용어는 무시.
 * @returns 사전 필터 SQL. 유효 용어가 없으면 항상-거짓(`FALSE`) — SQL 이 0 행을 방출(빈 결과).
 */
export function buildBrandMentionPrefilter(terms: string[]): SQL {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) {
    // 브랜드 용어 미등록 → 어떤 citation 도 통과시키지 않는다(빈 결과). 항상-참으로 새지 않게 방어.
    return sql`FALSE`;
  }

  const perTerm: SQL[] = cleaned.map((t) => {
    // 이스케이프된 패턴 문자열 전체를 파라미터로 바인딩(injection 방어). ESCAPE '\' 로 이스케이프 활성화.
    const pattern = `%${escapeIlike(t)}%`;
    return sql`(${sql.raw("cite->>'title'")} ILIKE ${pattern} ESCAPE '\\' OR ${sql.raw("cite->>'description'")} ILIKE ${pattern} ESCAPE '\\')`;
  });

  // 모든 용어 조건을 OR 로 결합
  return sql`(${sql.join(perTerm, sql` OR `)})`;
}
