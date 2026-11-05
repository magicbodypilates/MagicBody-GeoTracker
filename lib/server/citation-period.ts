/**
 * citation-period.ts — 「인용 출처」 탭 라우트(urls · brand-mentions · sources 와 각 prompts)가 공유하는
 * 기간·AI 모델 파라미터 파싱 (2026-11-05 — 인용 URL 기간별·모델별 검색).
 *
 * 기간 계약:
 *   - `from`/`to`(KST 일자, 양끝 포함) 가 오면 그 구간. 규칙은 홈 stats 와 같은 parseStatsRange
 *     (형식·역전·미래 시작일 400, 미래 종료일은 오늘로 자름). 구간 상한 = 전체 기간 상한(maxLookbackDays).
 *   - 둘 다 없으면 **전체 기간**(지금 - maxLookbackDays ~ 지금). 기존 호출부(파라미터 없음)와 결과가 같다.
 *   - 하나만 오면 400.
 *
 * 무거운 구간 가드(STATS_HEAVY_MAX_DAYS)는 홈 카드용이다. 인용 출처 라우트는 원래부터 전체 기간(730일)을
 * 행 상한(CITATION_ROW_CAP) + 시간 제한(statement_timeout)으로 보호해 왔으므로 그 방식을 그대로 쓴다.
 *
 * AI 모델 계약:
 *   - `provider` 없음·"all"·빈 값 = 전체. 알려진 provider(ALL_PROVIDERS) 가 아니면 400.
 *
 * 순수함수 — DB·네트워크 접근 없음.
 */

import { ALL_PROVIDERS } from "@/components/dashboard/types";
import { isStatsRangeError, parseStatsRange } from "@/lib/server/stats-range";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CitationPeriod = {
  /** created_at >= from */
  from: Date;
  /** created_at < to */
  to: Date;
  /** 전체 기간(파라미터 없음)인가 — 이 경우 「신규」 판정을 하지 않는다(전부 신규가 되므로) */
  allTime: boolean;
  /** range 모드에서만 — KST "YYYY-MM-DD" */
  fromDate?: string;
  toDate?: string;
};

export type CitationParamError = { error: string };

export function isCitationParamError<T extends object>(v: T | CitationParamError): v is CitationParamError {
  return (v as CitationParamError).error !== undefined;
}

export function parseCitationPeriod(
  sp: URLSearchParams,
  opts: { maxLookbackDays: number; now?: Date },
): CitationPeriod | CitationParamError {
  const now = opts.now ?? new Date();
  const hasFrom = !!sp.get("from");
  const hasTo = !!sp.get("to");
  if (!hasFrom && !hasTo) {
    return {
      from: new Date(now.getTime() - opts.maxLookbackDays * DAY_MS),
      to: now,
      allTime: true,
    };
  }
  const r = parseStatsRange(sp, { maxRangeDays: opts.maxLookbackDays, now });
  if (isStatsRangeError(r)) return { error: r.error };
  return {
    from: r.from,
    to: r.to,
    allTime: false,
    fromDate: r.fromDateKey,
    toDate: r.toDateKey,
  };
}

/** `?provider=` 파싱 — null = 전체 모델 */
export function parseProviderParam(sp: URLSearchParams): { provider: string | null } | CitationParamError {
  const raw = (sp.get("provider") ?? "").trim();
  if (!raw || raw === "all") return { provider: null };
  if ((ALL_PROVIDERS as string[]).includes(raw)) return { provider: raw };
  return { error: "알 수 없는 AI 모델입니다." };
}

/** `?newOnly=true` — 신규 URL 만 */
export function parseNewOnly(sp: URLSearchParams): boolean {
  return sp.get("newOnly") === "true";
}

/** 응답에 싣는 기간 정보 — 화면이 "지금 무엇을 보고 있는지" 표시하는 데 쓴다 */
export function citationPeriodMeta(p: CitationPeriod) {
  return {
    allTime: p.allTime,
    from: p.from.toISOString(),
    to: p.to.toISOString(),
    fromDate: p.fromDate ?? null,
    toDate: p.toDate ?? null,
  };
}
