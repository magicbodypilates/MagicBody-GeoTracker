/**
 * overview-related.ts — "연관 출처(제3자 언급)" 판정 순수함수.
 *
 * 가시성 분석 탭이 클라이언트에서 계산하던 규칙을 서버로 옮기면서, 판정 로직은
 * 화면과 **완전히 동일한 순수함수**로 유지한다(수치 동일성 보장).
 *
 * 규칙 (components/dashboard/tabs/visibility-analytics-tab.tsx 원본):
 *   run 하나가 "연관 출처 있음" 으로 세어지려면, 그 run 의 citations 중
 *     (1) 그 run 의 cited_brand_domains 키와 URL 이 매칭되지 **않고**  (= 공식 출처가 아니고)
 *     (2) 제목 또는 설명에 브랜드 용어가 포함된
 *   citation 이 하나라도 있어야 한다.
 *
 * SQL 은 후보만 좁히고(제목·설명 ILIKE superset 사전 필터), 최종 판정은 이 함수가 한다.
 * DB 무의존 — 단위 테스트 가능.
 */

import { isUrlMatchingCitedKeys } from "@/components/dashboard/citation-utils";
import { isBrandMentionText } from "@/lib/server/citation-url-aggregate";

/** SQL 이 펼친 citation 후보 한 행 */
export type RelatedCitationRow = {
  runId: string;
  url: string | null;
  title: string | null;
  description: string | null;
  /** 그 run 의 cited_brand_domains (공식 출처 매칭 키) */
  citedBrandDomains: string[] | null;
};

/**
 * 후보 행들에서 "연관 출처 있음" 인 run 의 개수를 센다.
 *
 * @param rows       SQL 사전 필터를 통과한 citation 후보 행들 (같은 run 이 여러 행일 수 있음)
 * @param brandTerms 브랜드 이름·별칭 목록. 비어 있으면 항상 0.
 */
export function countRelatedRuns(
  rows: RelatedCitationRow[],
  brandTerms: string[],
): number {
  if (!brandTerms.length || rows.length === 0) return 0;
  const hit = new Set<string>();
  for (const row of rows) {
    if (hit.has(row.runId)) continue;
    if (isUrlMatchingCitedKeys(row.url ?? "", row.citedBrandDomains ?? [])) continue;
    if (!isBrandMentionText(row.title, row.description, brandTerms)) continue;
    hit.add(row.runId);
  }
  return hit.size;
}
