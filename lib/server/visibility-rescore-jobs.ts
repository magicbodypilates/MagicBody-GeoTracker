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

export type RescoreJobId = "v11" | "v12" | "v12t";

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
};

const DIAGNOSTIC_SETS: readonly ScoreSetId[] = ["legacy8", "full10"];

export const RESCORE_JOBS: Record<RescoreJobId, RescoreJob> = {
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
 */
export const REPRO_SET_BY_VERSION: Readonly<Record<number, ScoreSetId>> = {
  8: "legacy8",
  10: "full10",
};

export function reproSetForVersion(version: number): ScoreSetId | null {
  return REPRO_SET_BY_VERSION[version] ?? null;
}

/**
 * 잡 정의 + 목표 세트 상수 + 재현 매핑의 지문.
 *
 * audit manifest 에 박아 두고, rollback·reconcile 이 "이 파일이 이 잡에서 나온 것인지"를
 * 확인하는 데 쓴다. 정의가 한 글자라도 바뀌면 값이 달라진다.
 */
export function jobHash(jobId: RescoreJobId): string {
  const job = RESCORE_JOBS[jobId];
  const payload = {
    jobId,
    job,
    targetSet: SCORE_SETS[job.targetSet],
    reproSets: Object.fromEntries(
      Object.entries(REPRO_SET_BY_VERSION).map(([v, setId]) => [v, SCORE_SETS[setId]]),
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
