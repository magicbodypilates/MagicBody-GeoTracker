/**
 * KST(Asia/Seoul) 표시용 날짜 헬퍼 — 표시층 전용.
 *
 * 배경:
 *   - runs.createdAt 은 UTC(timestamptz) 로 저장된다. 저장 포맷은 절대 건드리지 않는다.
 *   - 화면에서 `createdAt.slice(0,10)` 으로 일자를 자르면 UTC 일자가 나와,
 *     KST 새벽(UTC 15:00~23:59) 데이터가 전날로 밀려 표시된다.
 *   - 예) 2026-06-17T15:30:00Z(UTC) = 2026-06-18 00:30(KST) →
 *     slice(0,10) 은 "2026-06-17" 이지만 사용자가 기대하는 일자는 "2026-06-18".
 *
 * 이 헬퍼로 표시·그룹·축 생성 지점을 단일 KST 변환으로 통일한다.
 * 서버측 group(`AT TIME ZONE 'Asia/Seoul'`)과 결과가 일치한다.
 */

// 재사용 — Intl.DateTimeFormat 인스턴스 생성 비용 절감
const KST_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * ISO 문자열(또는 Date) 을 KST 기준 "YYYY-MM-DD" 일자 키로 변환.
 * en-CA 로케일은 항상 "YYYY-MM-DD" 형식을 보장한다.
 *
 * @param iso  createdAt 같은 ISO 8601 문자열 또는 Date
 * @returns    "YYYY-MM-DD" (KST). 파싱 불가 시 빈 문자열.
 */
export function toKstDateKey(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return KST_DATE_FORMAT.format(d);
}

/**
 * KST 기준 "오늘로부터 N일 전 ~ 오늘" 일자 키 배열(오래된→최신) 생성.
 * 차트 X축 등 연속 일자 축을 만들 때 사용한다 (실행 없는 날도 0으로 채우기 위함).
 *
 * @param days  포함할 일수 (오늘 포함). 예) 14 → 13일 전 ~ 오늘 = 14개
 * @returns     ["YYYY-MM-DD", ...] 길이 days, KST 기준
 */
export function kstRecentDateKeys(days: number): string[] {
  const keys: string[] = [];
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i--) {
    keys.push(toKstDateKey(new Date(now - i * DAY_MS)));
  }
  return keys;
}

/**
 * 시작·종료 일자(둘 다 포함) 사이의 연속 "YYYY-MM-DD" 일자 키 배열(오래된→최신) 생성.
 *
 * `kstRecentDateKeys`(오늘 기준 N일)와 달리, 임의의 조회 구간(예: 30일 전 ~ 어제)을
 * 빠짐없이 채울 때 쓴다. GA4 date 디멘션은 속성 타임존(Asia/Seoul) 기준 YYYYMMDD를
 * 주므로, 그 일자와 startDate/endDate(YYYY-MM-DD)는 같은 타임존 기준이라 추가 변환 없이
 * 문자열 일자 열거만으로 연속 축을 만들 수 있다(데이터 없는 날 0 채우기용).
 *
 * 일자 산술은 UTC 자정 기준으로 +1일씩 진행해 DST·로컬 타임존 영향을 받지 않는다.
 * (한국은 DST가 없지만, 실행 환경 로컬 타임존에 흔들리지 않도록 UTC로 계산.)
 *
 * @param start  시작 일자 "YYYY-MM-DD" (포함)
 * @param end    종료 일자 "YYYY-MM-DD" (포함)
 * @returns      ["YYYY-MM-DD", ...] 오래된→최신. start>end 또는 형식 오류면 빈 배열.
 */
export function enumerateDateRange(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return [];
  }
  const startMs = Date.parse(start + "T00:00:00Z");
  const endMs = Date.parse(end + "T00:00:00Z");
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
    return [];
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const keys: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    keys.push(new Date(ms).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * GA4 상대 날짜 토큰을 KST 기준 절대 일자("YYYY-MM-DD")로 정규화.
 *
 * 배경(MED-2):
 *   - GA4 Data API 는 "28daysAgo"·"today"·"yesterday" 같은 상대 토큰을 그대로 이해하지만,
 *     0 채움용 `enumerateDateRange` 는 "YYYY-MM-DD" 만 처리해 상대 토큰을 빈 배열로 떨군다.
 *   - 그 결과 route 기본값(startDate="28daysAgo"/endDate="today")이 오면 0 채움이 무력화돼
 *     "데이터 있는 날만" 끊기는 추이로 되돌아간다(계약 불일치).
 *   - GA4 집계 일자는 속성 타임존(Asia/Seoul) 기준이므로, 상대 토큰도 KST 기준으로 환산해야
 *     enumerate 일자와 GA4 date 디멘션 일자가 일치한다.
 *
 * 처리 토큰(대소문자·공백 무시):
 *   - "today"            → KST 오늘
 *   - "yesterday"        → KST 어제
 *   - "Ndaysago"         → KST 오늘로부터 N일 전 (N>=0)
 *   - 이미 "YYYY-MM-DD"  → 그대로 반환
 *
 * @param token  GA4 날짜 토큰 또는 절대 일자
 * @param now    기준 시각(테스트 주입용). 기본 현재 시각.
 * @returns      "YYYY-MM-DD" (KST). 인식 불가 토큰은 빈 문자열.
 */
export function resolveGa4DateToken(
  token: string,
  now: Date = new Date(),
): string {
  const t = token.trim().toLowerCase();

  // 이미 절대 일자
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  if (t === "today") return toKstDateKey(now);
  if (t === "yesterday") {
    return toKstDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  }

  // "Ndaysago" (N>=0)
  const m = /^(\d+)daysago$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return toKstDateKey(new Date(now.getTime() - n * 24 * 60 * 60 * 1000));
  }

  // 인식 불가 — 빈 문자열(호출부에서 enumerate 빈 배열로 안전 처리)
  return "";
}

/**
 * "오늘로부터 N일 전" 의 KST 자정에 해당하는 UTC 시각(ISO) 을 반환.
 * runs 조회 윈도우의 `from` 경계로 사용한다.
 *
 * 예) days=30, 지금이 2026-06-18(KST) 이면 → 2026-05-19 00:00(KST) = 2026-05-18T15:00:00Z
 *     이 시각 이후의 run 을 모두 포함하면 "최근 30일치(오늘 포함)" 가 빠짐없이 담긴다.
 *
 * @param days  윈도우 일수 (오늘 포함)
 * @returns     UTC ISO 문자열
 */
export function kstWindowStartUtcIso(days: number): string {
  // KST 자정을 구하려면: 현재 시각을 KST 일자로 환산 → 그 일자의 00:00(KST) → UTC.
  // KST 자정(00:00 KST) = 전날 15:00 UTC. 이를 UTC 기준으로 안전하게 계산한다.
  const todayKstKey = toKstDateKey(new Date()); // "YYYY-MM-DD" (KST 오늘)
  const [y, m, d] = todayKstKey.split("-").map(Number);
  // KST 오늘 자정의 UTC 시각 = Date.UTC(y, m-1, d, 0,0,0) - 9h
  const todayKstMidnightUtcMs =
    Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const startMs = todayKstMidnightUtcMs - (days - 1) * 24 * 60 * 60 * 1000;
  return new Date(startMs).toISOString();
}
