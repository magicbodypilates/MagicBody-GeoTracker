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

/**
 * 유튜브 영상 URL superset 사전 필터 SQL 을 조립 (계획 v2 §5 결정 E).
 *
 * 배경: "내 사이트 인용" 소유 뷰는 우리 채널 영상(watch·youtu.be·래핑형)을 인용한 것도 포함해야 한다.
 *   그런데 브랜드가 유튜브 채널을 등록하지 않았거나(brandHostPrefilter 가 youtube.com 을 포함하지 않음)
 *   등록했더라도 브랜드 host 필터와 별도 cap 으로 실행하지 않으면(H2), 영상 인용이 행 cap 뒤로
 *   밀려 잘릴 수 있다. 그래서 유튜브 영상 후보를 **브랜드 필터와 별도 cap 쿼리**로 뽑아 앱단에서
 *   union·dedup 한다(라우트 참조).
 *
 * 이 필터는 고정 리터럴 superset(사용자 입력·DB 값 미포함 → injection 없음). host substring 매칭이라
 *   남의 영상까지 과대 포함하지만, 최종 소유 판정(video-ID ∈ 소유 집합)은 JS 순수함수
 *   (extractYoutubeVideoId + ownedSet)가 유지한다 → 기존 2단 전략(SQL superset + JS 정확판정) 그대로.
 *
 *   - watch·shorts·embed·live·/v/·attribution_link (youtube.com 경로 변형)
 *   - youtube-nocookie.com (임베드) · youtu.be (단축)
 *   - m.·music. 서브도메인은 `youtube.com/...`·`youtu.be/` 문자열에 포함되어 함께 통과(L3)
 *   - google 래핑은 google host + youtube/youtu.be 를 함께 담은 경우만(과대 포함 최소화)
 *
 * @returns superset 사전 필터 SQL (항상 유효 — 파라미터·DB 값 없음).
 */
export function buildYoutubeVideoPrefilter(): SQL {
  return sql`(
    ${sql.raw("cite->>'url'")} ILIKE '%youtube.com/watch%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtube.com/shorts/%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtube.com/embed/%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtube.com/live/%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtube.com/v/%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtube.com/attribution_link%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtube-nocookie.com/%' ESCAPE '\\'
    OR ${sql.raw("cite->>'url'")} ILIKE '%youtu.be/%' ESCAPE '\\'
    OR (${sql.raw("cite->>'url'")} ILIKE '%google.%' ESCAPE '\\' AND (${sql.raw("cite->>'url'")} ILIKE '%youtu.be%' ESCAPE '\\' OR ${sql.raw("cite->>'url'")} ILIKE '%youtube%' ESCAPE '\\'))
  )`;
}

/* ── 빠른 사전 필터 (2026-11-06 — 90일·전체 기간 속도) ─────────────────────────────────────────────
 * 운영 실측(90일 인용 11.9만 줄): 위 빌더처럼 `cite->>'url' ILIKE ...` 를 패턴마다 따로 쓰면 인용 한 줄에서
 * jsonb 값 꺼내기·대소문자 비교를 패턴 수만큼(브랜드 9곳 × url·domain = 18번) 반복해 3～4초가 걸렸다.
 * 아래 빌더는 값을 **한 번** 꺼내 소문자로 만든 뒤 패턴 배열과 한 번에 비교한다(`LIKE ANY`) — PostgreSQL 은
 * `식 LIKE ANY(배열)` 의 왼쪽 식을 한 번만 계산한다. 같은 90일이 1.4초 안팎으로 줄었다.
 *
 * 브랜드 사이트 사전 필터는 호스트 대신 **판정 키 그대로**(buildTargetKeys — 일반 사이트는 호스트, 소셜은
 * 호스트/채널)로 거른다. 최종 판정(isBrandCitationKey)이 받아들이는 인용은 주소 문자열에 그 키가 반드시
 * 들어 있으므로 상위 집합이 유지되고, 공용 플랫폼(blog.naver.com·youtube.com 등)의 남의 글은 미리 빠진다
 * (90일 27,696 → 3,530줄 · 전체 76,095 → 8,497줄). 채널 이름이 퍼센트 인코딩/한글 원문 어느 쪽으로 적혀도
 * 잡히게 두 형태를 모두 넣는다. 최종 판정 로직은 그대로다.
 */

function likePatternArray(values: string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${`%${escapeIlike(v)}%`}`),
    sql`, `,
  )}]::text[]`;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * 브랜드 사이트 사전 필터 — 판정 키(buildTargetKeys 결과)로 거른다. 최종 판정(isBrandCitationKey)의 **상위 집합**.
 *
 * 2026-11-06 검수 S1 — 「호스트/채널」 키를 주소에 통째로(부분 문자열) 비교하면, 정규화 후에는 같은 주소인데
 * 원문 모양이 달라 빠지는 경우가 있었다(`//BrandBlog01` 이중 슬래시 · `:443` 포트 · `/x/../brandblog01` ·
 * `%40`(@) 인코딩 핸들 · 인코딩 섞인 한글 핸들). 그래서 소셜 키는 두 조각으로 나눠 본다.
 *   ① 일반 사이트 키(호스트)  : 주소·도메인에 그 호스트가 들어 있음 (서브도메인·포트·대소문자 무관)
 *   ② 소셜 키(호스트/채널)    : 주소에 그 호스트가 있고, 다음 중 하나
 *        - 채널 이름(앞의 @ 를 뗀 것)이 원문·디코드·인코드 어느 형태로든 들어 있음
 *          → 이중 슬래시·포트·`..`·대소문자 차이는 채널 이름 조각만 보므로 통과한다
 *        - 주소에 `%` 가 있음 → 인코딩이 섞여 위 비교를 보장할 수 없는 주소는 호스트 단위 후보로 남긴다
 * 주소는 한 번만 꺼내 소문자로 만든 뒤(하위 SELECT) 모든 비교에 재사용한다. 최종 판정 로직은 그대로다.
 * @returns 키가 없으면 항상-거짓(빈 결과)
 */
export type BrandKeyPrefilterPlan = { hosts: string[]; social: Array<{ host: string; handles: string[] }> };

/** 사전 필터 계획 — SQL 빌더와 JS 거울(brandKeyPrefilterAccepts)이 같은 계획을 쓴다 */
export function planBrandKeyPrefilter(targetKeys: string[]): BrandKeyPrefilterPlan {
  const hosts = new Set<string>();
  const social = new Map<string, Set<string>>(); // 소셜 호스트 → 채널 이름 조각들
  for (const k of targetKeys) {
    const lower = k.trim().toLowerCase();
    if (!lower) continue;
    const slash = lower.indexOf("/");
    if (slash < 0) {
      hosts.add(lower);
      continue;
    }
    const host = lower.slice(0, slash);
    const handle = lower.slice(slash + 1).replace(/^@/, "").replace(/^%40/, "");
    if (!host || !handle) continue;
    let set = social.get(host);
    if (!set) {
      set = new Set();
      social.set(host, set);
    }
    const decoded = safeDecode(handle).toLowerCase();
    set.add(handle);
    set.add(decoded);
    set.add(encodeURIComponent(decoded).toLowerCase());
  }
  return {
    hosts: [...hosts],
    social: [...social].map(([host, hs]) => ({ host, handles: [...hs] })),
  };
}

/**
 * 계획 → LIKE 패턴 두 묶음.
 *   주소용  : 일반 사이트 호스트 `%host%` · 소셜 `%host%채널%`(호스트 뒤 어딘가에 채널 이름 조각) · 소셜 `%host%\%%`
 *             (호스트 뒤에 `%` — 인코딩이 섞여 조각 비교를 보장 못 하는 주소는 호스트 단위 후보로 남긴다)
 *   도메인용: 주소용과 같은 묶음(최종 판정은 주소가 비었을 때 도메인 칸을 주소처럼 읽으므로 같은 규칙으로 본다)
 * 최종 판정이 받아들이는 소셜 주소는 호스트가 경로보다 앞에 오므로 「호스트 뒤 채널」 형태로 빠짐없이 잡힌다.
 * 2026-11-06 실측: 처음엔 하위 SELECT 로 주소를 한 번만 꺼내 비교했는데 줄마다 하위 계획이 돌아 첫 요청이
 * 2.9 → 8.0초로 느려졌다. 패턴 배열 두 개(`LIKE ANY` — 왼쪽 식은 한 번만 계산)로 같은 상위 집합을 표현한다.
 */
export function brandKeyPrefilterPatterns(plan: BrandKeyPrefilterPlan): { url: string[]; domain: string[] } {
  const hostPats = plan.hosts.map((h) => `%${escapeIlike(h)}%`);
  const url = [...hostPats];
  for (const { host, handles } of plan.social) {
    const h = escapeIlike(host);
    for (const handle of handles) url.push(`%${h}%${escapeIlike(handle)}%`);
    url.push(`%${h}%\\%%`);
  }
  const all = [...new Set(url)];
  return { url: all, domain: all };
}

/** SQL LIKE 를 JS 로 — 백슬래시 이스케이프 포함 (테스트·거울용) */
export function likeMatches(value: string, pattern: string): boolean {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") re += esc(pattern[++i] ?? "");
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += esc(c);
  }
  return new RegExp(`^${re}$`, "s").test(value);
}

/** 계획을 JS 로 그대로 적용 — SQL 과 같은 패턴으로 판정한다(테스트에서 상위 집합 확인용) */
export function brandKeyPrefilterAccepts(
  plan: BrandKeyPrefilterPlan,
  url: string | null | undefined,
  domain: string | null | undefined,
): boolean {
  const pats = brandKeyPrefilterPatterns(plan);
  const lu = (url ?? "").toLowerCase();
  const ld = (domain ?? "").toLowerCase();
  return pats.url.some((p) => likeMatches(lu, p)) || pats.domain.some((p) => likeMatches(ld, p));
}

export function buildBrandKeyPrefilter(targetKeys: string[]): SQL {
  const plan = planBrandKeyPrefilter(targetKeys);
  if (plan.hosts.length === 0 && plan.social.length === 0) return sql`FALSE`;
  const pats = brandKeyPrefilterPatterns(plan);
  const arr = (vs: string[]) => sql`ARRAY[${sql.join(vs.map((v) => sql`${v}`), sql`, `)}]::text[]`;
  const urlCond = sql`lower(${sql.raw("cite->>'url'")}) LIKE ANY(${arr(pats.url)})`;
  if (pats.domain.length === 0) return sql`(${urlCond})`;
  return sql`(${urlCond} OR lower(${sql.raw("cite->>'domain'")}) LIKE ANY(${arr(pats.domain)}))`;
}

/** 브랜드 언급 사전 필터 — buildBrandMentionPrefilter 와 같은 의미, 제목·설명을 한 번씩만 꺼내 비교 */
export function buildBrandMentionPrefilterFast(terms: string[]): SQL {
  const cleaned = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  if (cleaned.length === 0) return sql`FALSE`;
  const arr = likePatternArray(cleaned);
  return sql`(lower(${sql.raw("cite->>'title'")}) LIKE ANY(${arr}) OR lower(${sql.raw("cite->>'description'")}) LIKE ANY(${arr}))`;
}

/** 유튜브 영상 사전 필터 — buildYoutubeVideoPrefilter 와 같은 경로 목록, 주소를 한 번만 꺼내 비교 */
export function buildYoutubeVideoPrefilterFast(): SQL {
  return sql`(
    lower(${sql.raw("cite->>'url'")}) LIKE ANY(ARRAY['%youtube.com/watch%', '%youtube.com/shorts/%', '%youtube.com/embed/%', '%youtube.com/live/%', '%youtube.com/v/%', '%youtube.com/attribution_link%', '%youtube-nocookie.com/%', '%youtu.be/%']::text[])
    OR (lower(${sql.raw("cite->>'url'")}) LIKE '%google.%' AND lower(${sql.raw("cite->>'url'")}) LIKE ANY(ARRAY['%youtu.be%', '%youtube%']::text[]))
  )`;
}
