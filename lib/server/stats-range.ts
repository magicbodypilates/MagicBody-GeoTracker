/**
 * stats-range.ts — stats 라우트가 공유하는 조회 구간 파싱 헬퍼.
 *
 * 배경:
 *   기존 stats 라우트는 `?days=N` 만 받아 "지금으로부터 N일 전 ~ 지금" 롤링 윈도우를 썼다.
 *   화면에서 임의 구간(예: 6/26~7/31)을 조회하려면 일자 지정이 필요하므로
 *   `?from=YYYY-MM-DD&to=YYYY-MM-DD` (KST 일자, 양끝 포함) 를 추가한다.
 *
 * 계약:
 *   - `from`/`to` 가 오면 그것이 우선. 둘 중 하나만 오면 400.
 *   - 둘 다 없으면 기존 `days` 동작을 **그대로** 유지 (호환).
 *   - 형식 불일치 · 역전(from>to) · 상한 초과 · 시작일이 미래는 400.
 *   - 종료일이 오늘(KST)보다 뒤면 오늘로 잘라낸다(미래 구간 조회 방지).
 *
 * 타임존:
 *   runs.created_at 은 timestamptz(UTC 저장) 이고 집계는 `AT TIME ZONE 'Asia/Seoul'` 기준이다.
 *   따라서 from 은 그 날 00:00 KST 이상, to 는 **다음 날 00:00 KST 미만**으로 변환한다.
 *   (KST 자정 = 그 날 UTC 00:00 에서 9시간을 뺀 시각.)
 *
 * 순수함수 — DB·네트워크 접근 없음.
 */

/** from/to 구간 상한(일, 양끝 포함). 이보다 넓으면 400. */
export const STATS_RANGE_MAX_DAYS = 730;
/** days 파라미터 상한 — 기존 라우트 동작 유지. */
export const STATS_DAYS_MAX = 365;

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type StatsRange = {
  /** 구간 시작 (inclusive) — created_at >= from */
  from: Date;
  /** 구간 끝 (exclusive) — created_at < to */
  to: Date;
  /** 구간 길이(일). range 모드는 양끝 포함 일수, days 모드는 요청 days 그대로 */
  days: number;
  mode: "days" | "range";
  /** range 모드에서만 채워짐 — "YYYY-MM-DD" (KST) */
  fromDateKey?: string;
  toDateKey?: string;
};

export type StatsRangeError = { error: string };

export function isStatsRangeError(v: StatsRange | StatsRangeError): v is StatsRangeError {
  return (v as StatsRangeError).error !== undefined;
}

/** 기존 라우트의 parseInt32 와 동일 규칙 — 숫자 아님/0 이하면 기본값, 상한 clamp. */
export function parseDaysParam(v: string | null, def: number, max = STATS_DAYS_MAX): number {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * "YYYY-MM-DD" 를 KST 자정에 해당하는 UTC 시각으로 변환.
 * @param offsetDays 0 이면 그 날 00:00 KST, 1 이면 다음 날 00:00 KST
 * @returns 유효하지 않은 일자면 null
 */
export function kstDateKeyToUtc(key: string, offsetDays = 0): Date | null {
  if (!DATE_KEY_RE.test(key)) return null;
  const [y, m, d] = key.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const utcMidnight = Date.UTC(y, m - 1, d);
  // 달력상 존재하지 않는 일자(2026-02-30 등) 걸러내기 — 롤오버 여부로 판정
  const back = new Date(utcMidnight);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== m - 1 ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return new Date(utcMidnight + offsetDays * DAY_MS - KST_OFFSET_MS);
}

/**
 * Date → KST 기준 "YYYY-MM-DD".
 * lib/client/date-kst 의 toKstDateKey 와 결과가 같지만, 이 모듈은 DB·Intl 무의존 순수함수로
 * 유지하기 위해 UTC+9 산술로 직접 계산한다(한국은 서머타임이 없어 고정 오프셋이 정확).
 */
export function utcToKstDateKey(d: Date): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 양끝 포함 일수 (from/to 가 같은 날이면 1) */
export function inclusiveDaySpan(fromKey: string, toKey: string): number {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS) + 1;
}

export type ParseStatsRangeOptions = {
  /** from/to 가 없을 때 쓸 days 기본값 */
  defaultDays?: number;
  /** from/to 구간 상한(일) */
  maxRangeDays?: number;
  /** days 모드 상한(일) */
  maxDays?: number;
  /** 테스트 주입용 기준 시각 */
  now?: Date;
};

/**
 * 조회 구간 파싱 — `from`/`to` 우선, 없으면 `days`.
 *
 * @returns 성공 시 StatsRange, 실패 시 { error } (라우트가 400 으로 응답)
 */
export function parseStatsRange(
  sp: URLSearchParams,
  opts: ParseStatsRangeOptions = {},
): StatsRange | StatsRangeError {
  const defaultDays = opts.defaultDays ?? 30;
  const maxRangeDays = opts.maxRangeDays ?? STATS_RANGE_MAX_DAYS;
  const maxDays = opts.maxDays ?? STATS_DAYS_MAX;
  const now = opts.now ?? new Date();

  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");
  const hasFrom = rawFrom !== null && rawFrom !== "";
  const hasTo = rawTo !== null && rawTo !== "";

  if (hasFrom !== hasTo) {
    return { error: "시작일(from)과 종료일(to)을 함께 지정해야 합니다." };
  }

  if (!hasFrom || !hasTo) {
    // 기존 days 동작 그대로 (호환)
    const days = parseDaysParam(sp.get("days"), defaultDays, maxDays);
    return {
      from: new Date(now.getTime() - days * DAY_MS),
      to: now,
      days,
      mode: "days",
    };
  }

  const fromKey = rawFrom!.trim();
  const rawToKey = rawTo!.trim();
  // 형식 검증은 잘라내기 **전에** 한다 — 잘못된 문자열이 조용히 오늘로 바뀌면 안 된다.
  if (!kstDateKeyToUtc(fromKey, 0) || !kstDateKeyToUtc(rawToKey, 1)) {
    return { error: "날짜 형식이 올바르지 않습니다. YYYY-MM-DD 로 지정해 주세요." };
  }
  if (fromKey > rawToKey) {
    return { error: "시작일이 종료일보다 늦습니다." };
  }

  // 미래 구간 방어(m3): 화면은 종료일을 오늘로 제한하지만 API 를 직접 부르면 통과했다.
  //   - 시작일이 미래면 결과가 항상 비므로 400 으로 명확히 거절한다.
  //   - 종료일만 미래면 오늘(KST)로 **잘라낸다**. 자정 직후 화면/서버 시각이 한 틱 어긋나도
  //     조회가 실패하지 않게 하려는 것이다(400 이면 그 순간 화면이 통째로 에러가 된다).
  const todayKey = utcToKstDateKey(now);
  if (fromKey > todayKey) {
    return { error: "시작일이 오늘 이후입니다. 미래 구간은 조회할 수 없습니다." };
  }
  const toKey = rawToKey > todayKey ? todayKey : rawToKey;

  const fromUtc = kstDateKeyToUtc(fromKey, 0)!;
  const toUtc = kstDateKeyToUtc(toKey, 1)!; // 종료일 포함 → 다음 날 00:00 KST 미만
  const span = inclusiveDaySpan(fromKey, toKey);
  if (span > maxRangeDays) {
    return { error: `조회 구간은 최대 ${maxRangeDays}일까지 지정할 수 있습니다.` };
  }

  return {
    from: fromUtc,
    to: toUtc,
    days: span,
    mode: "range",
    fromDateKey: fromKey,
    toDateKey: toKey,
  };
}

/**
 * 실행 종류 필터.
 *   auto   — 자동 실행만 (is_auto = true)
 *   manual — 수동 실행만 (is_auto = false)
 *   all    — 구분 없음
 */
export type RunMode = "auto" | "manual" | "all";

/**
 * `?runMode=auto|manual|all` 파싱. 값이 없거나 인식 불가면 null 을 반환해
 * 호출부가 기존 `?auto=` 파라미터로 폴백할 수 있게 한다(호환 유지).
 */
export function parseRunMode(sp: URLSearchParams): RunMode | null {
  const v = sp.get("runMode");
  if (v === "auto" || v === "manual" || v === "all") return v;
  return null;
}
