/**
 * ga4-report-utils.ts — GA4 runReport 응답 파싱 공유 유틸 (MED-5).
 *
 * 기존에 ga4-client.ts 안에 private 으로 있던 `rowValue`/`rowMetric`/`formatDate` 를
 * 신규 파일로 분리해 ga4-client.ts(AI Referral)와 ga4-marketing.ts(마케팅 성과)가
 * 동일 헬퍼를 공유한다. 외부 의존(googleapis) 없는 순수 함수 — 단위 테스트 가능.
 *
 * + runWithConcurrency: 다수 GA4 쿼리를 동시 호출 상한(D4·MED-6) 안에서 실행하는 헬퍼.
 *   concurrent 한도 10 실측이라 4 제한이면 여유. Promise.all 무제한 발사를 대체한다.
 */

/** GA4 runReport rows[] 의 한 행 형태 (dimensionValues / metricValues 의 부분집합) */
export type RunReportRow = {
  dimensionValues?: Array<{ value?: string | null }>;
  metricValues?: Array<{ value?: string | null }>;
};

/** idx 번째 디멘션 값(문자열). 없으면 빈 문자열. */
export function rowValue(row: RunReportRow, idx: number): string {
  return row.dimensionValues?.[idx]?.value ?? "";
}

/** idx 번째 지표 값(숫자). 파싱 불가·비유한수는 0. (음수는 보존 — 환불 등) */
export function rowMetric(row: RunReportRow, idx: number): number {
  const raw = row.metricValues?.[idx]?.value ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** YYYYMMDD → YYYY-MM-DD. 8자리가 아니면 원본 그대로(이미 포맷됐거나 다른 디멘션일 때 방어). */
export function formatDate(ymd: string): string {
  if (ymd.length !== 8) return ymd;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * 작업(Promise를 반환하는 함수) 배열을 동시 실행 상한 `limit` 안에서 실행한다.
 * 입력 순서대로 결과를 반환한다(Promise.all 과 동일한 인덱스 보존).
 *
 * GA4 Data API 의 concurrent request 한도(실측 10)를 넘지 않기 위함. 7개 쿼리를
 * Promise.all 로 한꺼번에 쏘는 대신 limit(기본 4) 만큼만 동시에 흐르게 한다.
 *
 * 각 작업의 reject 는 그대로 전파한다(폴백 정책은 호출부 책임 — 핵심 쿼리는 거짓 0
 * 방지를 위해 폴백하지 않고, 보조 쿼리는 호출부에서 `() => fn().catch(() => null)` 로 감싼다).
 *
 * @param tasks  () => Promise<T> 배열
 * @param limit  동시 실행 상한(>=1). 기본 4
 */
export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit = 4,
): Promise<T[]> {
  const max = Math.max(1, Math.floor(limit));
  const results = new Array<T>(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(max, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
