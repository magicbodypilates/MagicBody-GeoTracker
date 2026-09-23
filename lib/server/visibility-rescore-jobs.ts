/**
 * 기간별 점수 룰 세트 재산출 잡 정의. 대상 범위·소스 버전·목표 세트는 코드 상수로
 * 고정하며 요청으로 변경할 수 없다.
 *
 * 요청 body 는 잡 id 만 고른다. from/to/provider/version 을 요청으로 받는 순간
 * "이 구간은 물리적으로 대상 밖" 이라는 보장이 코드가 아니라 문서상 약속으로 격하된다.
 *
 * 순수 상수 + 순수 함수. DB 무의존.
 */

import { createHash } from "crypto";
import { SCORE_SETS, type ScoreSetId } from "@/lib/server/visibility-score-sets";

/** 운영/비운영 워크스페이스 구분 — UUID 를 코드에 두지 않고 is_production 으로 판정한다. */
export type WorkspaceScope = "production" | "non-production";

export type RescoreJobId = "v11" | "v12" | "v12t" | "v13" | "v14" | "v15" | "v16";

export type RescoreJob = {
  /** 대상 창 시작(inclusive · timestamptz 비교) */
  fromUtc: string;
  /** 대상 창 끝(exclusive). null = 상한 없음 */
  toUtc: string | null;
  /** null = 전체 provider */
  providers: readonly string[] | null;
  /** 이 score_version 을 가진 행만 처리 */
  sourceVersions: readonly number[];
  /** 교차 재현 진단에 쓰는 소스 세트 후보 */
  diagnosticSets: readonly ScoreSetId[];
  /** 처리 후 기록할 score_version */
  targetVersion: number;
  /** 목표 배점 세트 */
  targetSet: ScoreSetId;
  /** true = 브랜드 명이 포함된 질의는 대상에서 제외 */
  informationalOnly: boolean;
  /** 서버 계산 경로(자동 수집)만 대상 — 리터럴 true 고정 */
  autoOnly: true;
  workspaceScope: WorkspaceScope;
  /**
   * true 면 목표 점수 계산에 **새 판정**(소유 유튜브 인용을 hasCitationOnly 에 접는다)을
   * 적용한다 — 계획 v2 §3-3·D0. **선택 필드로 둔다** — jobHash 는 `job` 객체 전체를
   * 해시하므로, 이미 운영에 적용된 잡(v11·v13)의 정의에 필드 하나만 추가해도 그 잡의
   * jobHash 가 바뀌어 과거 manifest 가 rollback·reconcile 에서 거부된다("지문 고정 앵커"
   * 테스트가 바로 이 드리프트를 잡기 위해 있다). 그래서 v11~v14 는 손대지 않고 생략하며,
   * 생략(undefined)은 false 와 동일하게 취급한다(옛 판정) — v15 만 명시적으로 true.
   */
  applyOwnedCitationJudgment?: boolean;
  /**
   * true 면 reproBase·targetBase **둘 다** 저장 행의 증거 컬럼(citedOwnedVideoIds·
   * citedPressDomains·citedSocialDomains)에서 직접 읽어 만든다 — deriveRowInputs(옛 판정)도
   * deriveNewJudgmentRowInputs(citations·소유 목록에서 새로 판정)도 쓰지 않는다.
   *
   * 왜 필요한가 — v16 의 소스 버전(15)은 이미 "소유 유튜브 인용을 hasCitationOnly 에 접는"
   * 새 판정으로 계산된 행이다. 그 판정을 다시 재현하려면 v15 채점 시점의 소유 영상 목록이
   * 필요한데, 그 목록은 주기적으로 바뀐다(brand_youtube_videos, 주 2회 동기화) — 지금
   * 목록으로 다시 판정하면 그때와 달라질 수 있다(위험 ⓔ). 채점 시점에 이미 저장해 둔 증거
   * 컬럼을 그대로 읽으면 목록이 바뀌어도 "그때 무엇으로 판정했는가"가 보존된다.
   *
   * **선택 필드로 둔다** — v11~v15 는 이 필드 자체를 생략해(undefined) jobHash 가 흔들리지
   * 않는다(applyOwnedCitationJudgment 와 동일한 이유). v16 만 명시적으로 true.
   */
  reproFromStoredEvidence?: boolean;
};

const DIAGNOSTIC_SETS: readonly ScoreSetId[] = ["legacy8", "full10"];

export const RESCORE_JOBS: Record<RescoreJobId, RescoreJob> = {
  /**
   * 과거 실행 원장의 대조·원복에 필요하므로 정의를 남긴다. 이 잡으로 만들어진 manifest 는
   * 이 정의가 그대로 있어야 rollback·reconcile 이 지문을 맞출 수 있다.
   */
  v11: {
    fromUtc: "2026-06-25T15:00:00.000Z",
    toUtc: "2026-07-31T15:00:00.000Z",
    providers: ["google_ai"],
    sourceVersions: [8, 10],
    diagnosticSets: DIAGNOSTIC_SETS,
    targetVersion: 11,
    targetSet: "low60",
    informationalOnly: true,
    autoOnly: true,
    workspaceScope: "production",
  },
  v12: {
    fromUtc: "2026-08-11T15:00:00.000Z",
    toUtc: null,
    providers: null,
    sourceVersions: [10],
    diagnosticSets: DIAGNOSTIC_SETS,
    targetVersion: 12,
    targetSet: "v12b",
    informationalOnly: false,
    autoOnly: true,
    workspaceScope: "production",
  },
  /** 카나리 전용 — 비운영 워크스페이스에서 적용·원복 경로를 실제로 돌려보기 위한 잡. */
  v12t: {
    fromUtc: "2026-08-11T15:00:00.000Z",
    toUtc: null,
    providers: null,
    sourceVersions: [10],
    diagnosticSets: DIAGNOSTIC_SETS,
    targetVersion: 12,
    targetSet: "v12b",
    informationalOnly: false,
    autoOnly: true,
    workspaceScope: "non-production",
  },
  /**
   * v11 과 대상 창·provider·소스 버전이 완전히 동일하고 목표(버전·세트)만 다른 잡.
   * 대상 정의를 v11 에서 복사해 두 잡이 같은 구간을 가리킨다는 사실을 테스트가 고정한다.
   */
  v13: {
    fromUtc: "2026-06-25T15:00:00.000Z",
    toUtc: "2026-07-31T15:00:00.000Z",
    providers: ["google_ai"],
    sourceVersions: [8, 10],
    diagnosticSets: DIAGNOSTIC_SETS,
    targetVersion: 13,
    targetSet: "full83",
    informationalOnly: true,
    autoOnly: true,
    workspaceScope: "production",
  },
  /**
   * v12 가 이미 12 로 올려 둔 행 중 **대상 창 안의 행만** 받아 v14a 세트로 다시 계산한다.
   * 대상 창은 v12 보다 좁다(v12 는 KST 8/12~, 이 잡은 KST 8/24~). 그 사이 구간은 12 로 남는다.
   * 소스 버전 12 의 재현 세트(v12b)는 REPRO_SET_BY_VERSION 에 등록돼 있어야 한다.
   *
   * ⚠️ diagnosticSets 가 빈 목록인 이유 — 소스 버전이 12 하나뿐이고, score_version 12 를
   *    쓴 경로(수집 · v12 재산출)는 둘 다 v12b 세트다. 즉 선언 세트가 곧 유일한 후보라
   *    교차 진단이 잡아낼 "다른 룰이 만든 점수" 자체가 존재하지 않는다. 반면 legacy8·full10
   *    을 진단 세트로 넣으면 우연히 같은 합이 나오는 조합(예: 저장 64 = v12b 50+14 =
   *    full10 30+18+16)에서 cross-set-ambiguous 가 나 그 행이 조용히 skip 된다. 재현 자체가
   *    안 되는 행은 여전히 no-candidate 로 걸러지므로 안전망은 유지된다.
   *    (visibility-rescore-anomaly-space.test.ts 가 이 두 성질을 전수로 고정한다.)
   */
  v14: {
    // KST 2026-08-24 00:00 이후만 대상. 그 이전(8/12~8/23)은 기존 세트 결과를 유지한다.
    fromUtc: "2026-08-23T15:00:00.000Z",
    toUtc: null,
    providers: null,
    sourceVersions: [12],
    diagnosticSets: [],
    targetVersion: 14,
    targetSet: "v14a",
    informationalOnly: false,
    autoOnly: true,
    workspaceScope: "production",
  },
  /**
   * 계획 v2 §5 Step 6·D7·D8′. v14 가 이미 14 로 올려 둔 행 중 **2026-09-21(KST) 이후**만
   * 받아 v15a 로 다시 계산한다. 6~8월 초 레거시 구간(다른 세트)은 부록 E 로 분리해 이번
   * 잡 대상이 아니다.
   *
   * ⛔ 2026-09-23 개정 — 대상 창 하한을 v14 와 공유하지 않는다. 애초 설계는 "v14a 가 적용된
   *    구간 전체"(v14 와 완전히 같은 하한, KST 8/24)를 대상으로 삼았지만, 과거 구간에 새
   *    판정(소유 유튜브 인용)을 소급 적용하지 않기로 결정했다. 8/24~9/20 사이 행은
   *    score_version 14(v14a)로 그대로 남고, v15 잡의 대상에서 조용히 빠진다(잡 정의가
   *    시간으로 걸러내므로 별도 예외 처리가 필요 없다).
   *
   * applyOwnedCitationJudgment: true — 이 잡의 targetBase 만 소유 유튜브 인용을
   * hasCitationOnly 에 접은 새 판정으로 계산한다(reproBase 는 항상 옛 판정 그대로).
   *
   * ⚠️ diagnosticSets 가 빈 목록인 이유는 v14 와 같다 — 소스 버전이 14 하나뿐이고,
   *    score_version 14 를 쓴 경로(수집 · v14 재산출)는 둘 다 v14a 세트라 선언 세트가 곧
   *    유일한 후보다. legacy8·full10 을 진단에 넣으면 우연히 합이 같은 조합에서
   *    cross-set-ambiguous 오탐이 난다(v14 주석과 동일 근거).
   */
  v15: {
    // KST 2026-09-21 00:00 이후만 대상 — 그 이전(v14a 적용 구간 전체 포함)은 손대지 않는다.
    fromUtc: "2026-09-20T15:00:00.000Z",
    toUtc: null,
    providers: null,
    sourceVersions: [14],
    diagnosticSets: [],
    targetVersion: 15,
    targetSet: "v15a",
    informationalOnly: false,
    autoOnly: true,
    workspaceScope: "production",
    applyOwnedCitationJudgment: true,
  },
  /**
   * 2026-09-23 제3자 인용 판정 재설계 — 사장님이 언론·블로그·소셜 배점을 확정(v16a: 35/35)
   * 하면서 신설. v15 가 이미 15 로 올려 둔 행(대상 창은 v15 와 완전히 동일 — 이미 버전 15인
   * 행은 정의상 그 창 안에 있다)을 v16a 로 다시 계산한다. v15a·버전 15 는 그대로 둔다.
   *
   * reproFromStoredEvidence: true — reproBase·targetBase 둘 다 저장된 증거 컬럼에서 읽는다
   * (위 RescoreJob 타입 주석 참조). applyOwnedCitationJudgment 는 쓰지 않는다 — 이 잡은
   * deriveNewJudgmentRowInputs(소유 영상 목록을 다시 조회하는 경로) 자체를 타지 않는다.
   *
   * diagnosticSets 가 빈 목록인 이유는 v14·v15 와 같다 — 소스 버전 15 를 만든 경로는 v15
   * 잡 하나뿐이라 선언 세트(v15a)가 곧 유일한 후보다.
   */
  v16: {
    // v15 와 완전히 같은 창 — 이미 버전 15로 올라간 행은 전부 이 창 안에 있다.
    fromUtc: "2026-09-20T15:00:00.000Z",
    toUtc: null,
    providers: null,
    sourceVersions: [15],
    diagnosticSets: [],
    targetVersion: 16,
    targetSet: "v16a",
    informationalOnly: false,
    autoOnly: true,
    workspaceScope: "production",
    reproFromStoredEvidence: true,
  },
};

export const RESCORE_JOB_IDS = Object.keys(RESCORE_JOBS) as RescoreJobId[];

/**
 * 잡 id 판정.
 *
 * `in` 연산자는 프로토타입 체인까지 참으로 보기 때문에 `toString`·`constructor`·`__proto__`
 * 같은 값이 통과한다. 이 검사는 "요청은 선언된 잡만 고른다" 는 불변식을 지키는 유일한
 * 관문이므로 **선언된 키 목록과의 정확한 일치**로만 판정한다.
 */
export function isRescoreJobId(value: unknown): value is RescoreJobId {
  return typeof value === "string" && (RESCORE_JOB_IDS as readonly string[]).includes(value);
}

/**
 * 행의 선언 버전(score_version) → 그 점수를 만든 룰 세트.
 * 여기에 없는 버전은 재산출 대상이 될 수 없다(잡의 sourceVersions 가 이 범위 안이어야 한다).
 *
 * ⛔ D0-b(계획 v2 §3-2) — 14 를 여기 등록하지 않으면 `v15`(sourceVersions: [14])를 정의하는
 * 순간 jobHash 가 "재현 세트가 없는 소스 버전" 예외를 던져 잡 목록을 읽는 모든 경로(meta·
 * preflight·sweep)가 깨진다. 등록해도 예외를 피하면 전 행이 unmapped-version 이 된다.
 * 같은 이유로 15 도 등록한다 — v16(sourceVersions: [15])이 같은 D0-b 함정에 걸린다.
 */
export const REPRO_SET_BY_VERSION: Readonly<Record<number, ScoreSetId>> = {
  8: "legacy8",
  10: "full10",
  12: "v12b",
  14: "v14a",
  15: "v15a",
};

export function reproSetForVersion(version: number): ScoreSetId | null {
  return REPRO_SET_BY_VERSION[version] ?? null;
}

/**
 * 잡 정의 + 목표 세트 상수 + **그 잡이 실제로 쓰는** 재현 매핑의 지문.
 *
 * audit manifest 에 박아 두고, rollback·reconcile 이 "이 파일이 이 잡에서 나온 것인지"를
 * 확인하는 데 쓴다. 정의가 한 글자라도 바뀌면 값이 달라진다.
 *
 * ⚠️ 재현 매핑은 **잡의 sourceVersions 로 좁혀서** 넣는다. 전체 매핑을 넣으면 새 소스 버전을
 *    등록하는 것만으로 무관한 과거 잡의 지문까지 흔들려 그 잡의 manifest 가 rollback 에서
 *    거부된다. 좁힌 값은 그 잡의 계산 입력을 그대로 담으므로 지문의 목적도 유지된다.
 */
export function jobHash(jobId: RescoreJobId): string {
  const job = RESCORE_JOBS[jobId];
  const payload = {
    jobId,
    job,
    targetSet: SCORE_SETS[job.targetSet],
    reproSets: Object.fromEntries(
      [...job.sourceVersions]
        .sort((a, b) => a - b)
        .map((v) => {
          const setId = reproSetForVersion(v);
          if (setId === null) {
            // 잡 정의 오류 — 이 상태로 지문을 만들면 "재현 불가"가 감사 파일에 숨는다.
            throw new Error(`재현 세트가 없는 소스 버전: ${jobId} / ${v}`);
          }
          return [v, SCORE_SETS[setId]];
        }),
    ),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

/**
 * 설정 지문 — 계산 입력을 좌우하는 워크스페이스 설정(브랜드 별칭·자사 도메인)의 sha256 앞 12자.
 *
 * brandConfig 에는 컬럼 단위 변경 이력이 없다. 이 값을 audit 에 남겨 두면 다음 재산출에서
 * "그때와 설정이 같았는가" 를 비교할 수 있는 유일한 근거가 된다.
 */
export function configFingerprint(brandTerms: string[], websites: string[]): string {
  const payload = {
    brandTerms: [...brandTerms].sort(),
    websites: [...websites].sort(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

/**
 * 소유 유튜브 영상 목록 지문 — 개수 + 정렬된 목록의 sha256 앞 12자 (계획 v2 §4-4 D6 보강).
 *
 * 영상 번호 원문은 감사 파일에 남기지 않는다("영상 번호 자체는 안 적는다") — 이 지문만으로
 * "그때 소유 목록이 뭐였나"를 다음 재산출과 비교할 근거로 삼는다. 소유 목록은 점수를 직접
 * 좌우하는 입력인데 기록이 없으면 재현 불일치의 원인을 못 찾는다.
 */
export function ownedVideoListFingerprint(videoIds: readonly string[]): {
  count: number;
  hash: string;
} {
  const sorted = [...videoIds].sort();
  const hash = createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 12);
  return { count: sorted.length, hash };
}

/**
 * 프롬프트 식별 키 — 프롬프트 원문의 sha256 앞 12자.
 *
 * audit manifest 를 다른 곳(로컬 검증본 등)과 대조할 때 쓰는 조인 키다. 원문 대신 키를
 * 남기면 파일이 짧아지고, 같은 함수로 만든 키끼리는 정확히 맞는다.
 */
export function promptKey(promptText: string): string {
  return createHash("sha256").update(promptText).digest("hex").slice(0, 12);
}

/* ============================================================
 * 검증 창 — report 모드가 집계하는 구간들
 * ============================================================ */

export type VerificationWindowKey =
  | "target"
  | "before-target"
  | "holdout"
  | "other-providers";

export type VerificationWindow = {
  key: VerificationWindowKey;
  /** null = 하한 없음 */
  fromUtc: string | null;
  /** null = 상한 없음 */
  toUtc: string | null;
  /** null = 전체 */
  providers: readonly string[] | null;
  /** 이 provider 들은 제외 (providers 와 동시에 쓰지 않는다) */
  excludeProviders: readonly string[] | null;
};

/** report 가 대상 창 앞으로 얼마나 거슬러 올라가 기준선을 보여줄지. */
const REPORT_LOOKBACK_DAYS = 30;

function shiftIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 잡별 검증 창 목록.
 *
 *   target          — 잡이 실제로 바꾸는 구간
 *   before-target   — 대상 창 직전 구간(불변이어야 함)
 *   holdout         — 두 잡 사이에 남겨 두는 구간(불변이어야 함)
 *   other-providers — 잡이 provider 를 좁혔을 때 그 밖 provider(불변이어야 함)
 *
 * 경계 값은 전부 잡 정의에서 파생된다 — 날짜를 두 곳에 적지 않는다.
 */
export function buildVerificationWindows(jobId: RescoreJobId): VerificationWindow[] {
  const job = RESCORE_JOBS[jobId];
  const windows: VerificationWindow[] = [
    {
      key: "target",
      fromUtc: job.fromUtc,
      toUtc: job.toUtc,
      providers: job.providers,
      excludeProviders: null,
    },
    {
      key: "before-target",
      fromUtc: shiftIso(job.fromUtc, -REPORT_LOOKBACK_DAYS),
      toUtc: job.fromUtc,
      providers: job.providers,
      excludeProviders: null,
    },
    {
      key: "holdout",
      fromUtc: RESCORE_JOBS.v11.toUtc,
      toUtc: RESCORE_JOBS.v12.fromUtc,
      providers: null,
      excludeProviders: null,
    },
  ];

  if (job.providers !== null) {
    windows.push({
      key: "other-providers",
      fromUtc: job.fromUtc,
      toUtc: job.toUtc,
      providers: null,
      excludeProviders: job.providers,
    });
  }

  return windows;
}
