/**
 * POST /api/internal/visibility-rescore — 기간별 점수 룰 세트 재산출.
 *
 * 대상 범위·소스 버전·목표 세트는 잡 레지스트리(lib/server/visibility-rescore-jobs.ts)의
 * 코드 상수로 고정하며 요청으로 변경할 수 없다. 요청은 잡 id 만 고른다.
 *
 * 저장 점수를 재현하는 플래그 조합을 열거해 목표 세트 점수를 결정한다(LLM 재분류 없음).
 *
 * 모드
 *   meta      — DB 접근 없이 잡 정의·해시만 반환. 플레인 JS 스크립트가 날짜·해시를
 *               자기 쪽에 복제하지 않도록 하는 단일 정본 창구.
 *   report    — 검증 창별 평균만 반환(쓰기 없음). 집계 필터를 스크립트에 복제하지 않기 위해
 *               차트와 같은 조건을 여기서 조립한다.
 *   preflight — 처리 없이 창 안 분포·정합만 반환.
 *   sweep     — 배치 1개 처리. **쓰기는 apply:true 를 받았을 때만** 하고 기본은 계산만이다.
 *
 * 도달 제어·인증 (순서대로 · 도달 제어가 먼저다)
 *   1. 프록시 전용 헤더 존재 / Host·X-Forwarded-* 값이 loopback:앱포트가 아님 → 403
 *   2. INTERNAL_CRON_SECRET 미설정                                        → 503
 *   3. x-cron-secret 불일치(timingSafeEqual)                              → 403 (1번과 동일 응답)
 *   4. 입력 형식 오류                                                      → 400
 *
 * 1번은 이 엔드포인트를 **컨테이너 내부 loopback 호출 전용**으로 못 박는다.
 * 호출 경로는 컨테이너 안에서 도는 scripts/visibility-rescore.mjs 하나뿐이다.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import { buildBrandTerms, buildCollectionBrandTerms } from "@/lib/server/branded-query-filter";
import {
  matchCitationDomains,
  normalizeTargetKey,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import type { Citation } from "@/components/dashboard/types";
import { toKstDateKey } from "@/lib/client/date-kst";
import {
  RESCORE_JOBS,
  buildVerificationWindows,
  configFingerprint,
  isRescoreJobId,
  jobHash,
  downstreamJobPaths,
  ownedVideoListFingerprint,
  preflightAcceptedVersions,
  promptKey,
  reproSetForVersion,
  type RescoreJob,
  type RescoreJobId,
} from "@/lib/server/visibility-rescore-jobs";
import {
  buildBaseConditions,
  buildCursorCondition,
  cursorTimestampProjection,
  isCursorTimestamp,
  buildReportConditions,
  buildWindowConditions,
  isInformationalPrompt,
  matchesJob,
  matchesJobSelection,
  type ScopedWorkspace,
} from "@/lib/server/visibility-rescore-selector";
import {
  resolveWithDiagnostics,
  type BaseVisibilityInputs,
} from "@/lib/server/visibility-backfill";
import { deriveMentionInputs, type Sentiment } from "@/lib/server/visibility-score-sets";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";
import { extractYoutubeVideoId, isOwnedYoutubeVideo } from "@/lib/server/youtube-video-match";
import { collectThirdPartyCitationEvidence } from "@/lib/server/press-domain-match";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-zA-Z._-]{0,64}$/;

const MIN_BATCH = 1;
const MAX_BATCH = 200;
const DEFAULT_BATCH = 100;

/** Timing-safe 문자열 비교 — 길이 다른 입력은 false, 같으면 바이트 단위 상수시간 비교. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 리버스 프록시만 넣는 헤더 — **존재 자체가 프록시 흔적**이다.
 *
 * Next 서버는 이 여섯을 스스로 채우지 않으므로 존재 검사로 충분하다.
 */
const PROXY_ONLY_HEADERS = [
  "x-real-ip",
  "forwarded",
  "x-forwarded-server",
  "x-original-forwarded-for",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

/**
 * ⚠️ 아래 네 헤더는 **존재로 판정하면 안 된다.**
 *
 * Next 서버가 모든 요청에 스스로 채워 넣기 때문이다(base-server 의 `??=` 대입 —
 * x-forwarded-host ← host · x-forwarded-port ← 앱 포트 · x-forwarded-proto ← http/https ·
 * x-forwarded-for ← 소켓 peer 주소). 존재로 막으면 컨테이너 안 loopback 호출까지 전부
 * 403 이 되어 엔드포인트가 아예 동작하지 않는다.
 *
 * 그래서 **값**으로 판정한다. Next 가 채운 값은 전부 loopback·앱 포트를 가리키고,
 * 리버스 프록시를 거친 요청은 공인 IP·공개 도메인·443 이 실려 통과하지 못한다.
 * 클라이언트가 헤더를 위조해 보내도(`??=` 는 기존 값을 덮지 않는다) nginx 계열은
 * X-Forwarded-For 를 **덧붙이므로** 콤마가 생겨 걸러지고, X-Real-IP·Host 검사에도 걸린다.
 *
 * ⚠️ 이 판정은 Next 내부 동작에 기대므로 Next 를 올릴 때 재확인이 필요하다. 단위 테스트는
 * 서버 계층을 건너뛰어 헤더 자동 주입을 재현하지 못하니(아래 테스트 주석 참조),
 * 배포 후 컨테이너 안에서 preflight 를 한 번 실제로 돌려 확인한다.
 */
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function appPort(): string {
  return process.env.PORT ?? "3000";
}

function allowedHosts(): string[] {
  const port = appPort();
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/** 도달 제어 — loopback 직접 호출이 아니면 사유를 돌려준다(통과면 null). */
function reachabilityFailure(req: NextRequest): string | null {
  for (const h of PROXY_ONLY_HEADERS) {
    if (req.headers.get(h) !== null) return `proxy-header:${h}`;
  }

  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!allowedHosts().includes(host)) return "host";

  // 아래 넷은 없을 수도 있고(직접 호출), Next 가 채웠을 수도 있다. 있으면 값을 본다.
  const xff = req.headers.get("x-forwarded-for");
  if (xff !== null && !LOOPBACK_IPS.has(xff.trim().toLowerCase())) return "x-forwarded-for";

  const xfh = req.headers.get("x-forwarded-host");
  if (xfh !== null && !allowedHosts().includes(xfh.trim().toLowerCase())) {
    return "x-forwarded-host";
  }

  const xfp = req.headers.get("x-forwarded-port");
  if (xfp !== null && xfp.trim() !== appPort()) return "x-forwarded-port";

  // 컨테이너 안 앱은 평문 http 로 듣는다. https 는 TLS 종단(=프록시)이 있었다는 뜻이다.
  const xproto = req.headers.get("x-forwarded-proto");
  if (xproto !== null && xproto.trim().toLowerCase() !== "http") return "x-forwarded-proto";

  return null;
}

type GateFailure = { response: NextResponse };

/**
 * 게이트 순서 — **도달 제어 먼저, 시크릿 나중.**
 *
 * 시크릿을 먼저 보면 "맞으면 403 · 틀리면 401" 이 되어 응답 코드가 시크릿 유효성을
 * 알려 주는 오라클이 된다. 도달 제어를 앞에 두면 외부에서 온 요청은 시크릿과 무관하게
 * 항상 같은 응답을 받는다. 실패 응답도 하나로 통일하고, 구분이 필요한 운영자는 서버
 * 로그에서 사유를 본다.
 */
const DENIED = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

function checkGates(req: NextRequest): GateFailure | null {
  const reachability = reachabilityFailure(req);
  if (reachability !== null) {
    console.error(`[visibility-rescore] 도달 제어 거부 (${reachability})`);
    return { response: DENIED() };
  }

  const expectedSecret = process.env.INTERNAL_CRON_SECRET;
  if (!expectedSecret) {
    // 설정 실수와 침입 시도를 구분하기 위해 서버 로그에만 사유를 남긴다.
    // 여기까지 오려면 이미 loopback 직접 호출이므로 외부에 설정 상태가 새지 않는다.
    console.error("[visibility-rescore] INTERNAL_CRON_SECRET 미설정");
    return {
      response: NextResponse.json({ error: "not_configured" }, { status: 503 }),
    };
  }

  const provided = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(provided, expectedSecret)) {
    console.error("[visibility-rescore] 시크릿 불일치");
    return { response: DENIED() };
  }

  return null;
}

/* ============================================================
 * 입력
 * ============================================================ */

/**
 * 스윕 커서 — 시각은 **마이크로초 텍스트**다.
 *
 * JS `Date` 로 들고 있으면 `created_at` 의 마이크로초 자리가 잘려 커서가 자기 행보다
 * 작아지고, 그 행이 다음 배치에 다시 걸린다(배치당 1건 중복 · 종료 불능).
 */
type Cursor = { createdAtUs: string; id: string };

type ParsedBody = {
  jobId: RescoreJobId;
  meta: boolean;
  report: boolean;
  preflight: boolean;
  dryRun: boolean;
  batchSize: number;
  cursor: Cursor | null;
  operationId: string | null;
  codeSha: string | null;
};

function parseBody(raw: unknown): ParsedBody | { error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isRescoreJobId(body.job)) return { error: "invalid_job" };

  // 쓰기는 명시적 opt-in — `apply: true` 가 없으면 계산만 한다.
  // 잘린 body·오타가 곧바로 운영 UPDATE 가 되지 않게 하는 것이 목적이다.
  // `dryRun` 은 "계산만" 을 명시하는 용도로만 남기고 apply 와 함께 오면 거절한다
  // (둘이 서로 반대를 가리킬 수 있는 조합은 애초에 만들지 않는다).
  const hasApply = body.apply !== undefined && body.apply !== null;
  const hasDryRun = body.dryRun !== undefined && body.dryRun !== null;
  if (hasApply && hasDryRun) return { error: "conflicting_mode" };
  if (hasApply && typeof body.apply !== "boolean") return { error: "invalid_apply" };
  if (hasDryRun && body.dryRun !== true) return { error: "invalid_dry_run" };
  const dryRun = body.apply !== true;

  let cursor: Cursor | null = null;
  if (body.cursor !== undefined && body.cursor !== null) {
    const c = body.cursor as Record<string, unknown>;
    // 마이크로초 6자리를 강제한다 — 밀리초까지만 담긴 커서는 자기 행을 다시 고르므로
    // 관대하게 받아주면 안 된다(형식 정의는 selector 의 CURSOR_TS_PATTERN).
    if (!isCursorTimestamp(c.createdAtUs) || typeof c.id !== "string" || !UUID_RE.test(c.id)) {
      return { error: "invalid_cursor" };
    }
    cursor = { createdAtUs: c.createdAtUs, id: c.id };
  }

  let batchSize = DEFAULT_BATCH;
  if (body.batchSize !== undefined) {
    if (typeof body.batchSize !== "number" || !Number.isInteger(body.batchSize)) {
      return { error: "invalid_batch_size" };
    }
    if (body.batchSize < MIN_BATCH || body.batchSize > MAX_BATCH) {
      return { error: "invalid_batch_size" };
    }
    batchSize = body.batchSize;
  }

  if (body.operationId !== undefined && body.operationId !== null) {
    if (typeof body.operationId !== "string" || !UUID_RE.test(body.operationId)) {
      return { error: "invalid_operation_id" };
    }
  }
  if (body.codeSha !== undefined && body.codeSha !== null) {
    if (typeof body.codeSha !== "string" || !SHA_RE.test(body.codeSha)) {
      return { error: "invalid_code_sha" };
    }
  }

  return {
    jobId: body.job,
    meta: body.meta === true,
    report: body.report === true,
    preflight: body.preflight === true,
    dryRun,
    batchSize,
    cursor,
    operationId: (body.operationId as string | undefined) ?? null,
    codeSha: (body.codeSha as string | undefined) ?? null,
  };
}

/* ============================================================
 * 워크스페이스 범위
 * ============================================================ */

type ScopedWorkspaceFull = ScopedWorkspace & {
  websites: string[];
  /** 저장된 점수를 만든 수집 경로의 별칭 파싱 결과 — 아래 termParity 대조용. */
  collectionTerms: string[];
};

async function loadScopedWorkspaces(job: RescoreJob): Promise<ScopedWorkspaceFull[]> {
  const rows = await db
    .select({
      id: schema.workspaces.id,
      brandConfig: schema.workspaces.brandConfig,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.isProduction, job.workspaceScope === "production"));

  return rows.map((w) => ({
    id: w.id,
    brandTerms: buildBrandTerms(w.brandConfig),
    collectionTerms: buildCollectionBrandTerms(w.brandConfig),
    websites: w.brandConfig?.websites ?? [],
  }));
}

/**
 * 별칭 파싱 대조 — 재산출이 쓰는 term 목록과 **저장 점수를 만든** 수집 경로의 term 목록이
 * 같은지 본다.
 *
 * 두 함수의 구분자가 다르므로(`[,;\n]` vs `,`) 별칭에 `;`·줄바꿈이 들어가면 term 집합이
 * 갈리고, 그러면 언급 수·최초 위치·브랜드 질의 판정이 저장 당시와 어긋난 채로 역산이 돈다.
 * 대부분 재현 실패로 안전하게 떨어지지만, 우연히 다른 입력에서 저장 점수가 재현되면 조용히
 * 틀린 목표가 나온다. 그래서 **실행 전에** 하드 스톱으로 막는다.
 *
 * 비교는 대소문자를 접어서 한다 — 두 경로의 실제 사용(`includes`·`ILIKE`)이 모두
 * 대소문자를 구분하지 않으므로 대소문자 차이는 판정에 영향이 없다.
 */
type TermParity = {
  ok: boolean;
  termCount: number;
  diffSample: {
    workspaceId: string;
    onlyInCollectionPath: string[];
    onlyInRescorePath: string[];
  }[];
};

function checkTermParity(workspaces: readonly ScopedWorkspaceFull[]): TermParity {
  const fold = (terms: string[]) =>
    new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean));

  let ok = true;
  let termCount = 0;
  const diffSample: TermParity["diffSample"] = [];

  for (const w of workspaces) {
    termCount += w.brandTerms.length;
    const rescore = fold(w.brandTerms);
    const collection = fold(w.collectionTerms);
    const onlyInCollectionPath = [...collection].filter((t) => !rescore.has(t));
    const onlyInRescorePath = [...rescore].filter((t) => !collection.has(t));
    if (onlyInCollectionPath.length === 0 && onlyInRescorePath.length === 0) continue;

    ok = false;
    if (diffSample.length < 5) {
      diffSample.push({
        workspaceId: w.id,
        onlyInCollectionPath: onlyInCollectionPath.slice(0, 5),
        onlyInRescorePath: onlyInRescorePath.slice(0, 5),
      });
    }
  }

  return { ok, termCount, diffSample };
}

/** 범위 안 전 워크스페이스 설정의 합집합 지문 — 다음 재산출에서 설정 변화를 비교할 근거. */
function fingerprintOf(workspaces: readonly ScopedWorkspaceFull[]): string {
  const terms = new Set<string>();
  const sites = new Set<string>();
  for (const w of workspaces) {
    for (const t of w.brandTerms) terms.add(t);
    for (const s of w.websites) sites.add(s);
  }
  return configFingerprint([...terms], [...sites]);
}

/* ============================================================
 * 행 입력 복원
 * ============================================================ */

type TargetRow = {
  id: string;
  workspaceId: string;
  promptText: string;
  provider: string;
  answer: string | null;
  citations: unknown;
  sentiment: string;
  visibilityScore: number;
  scoreVersion: number;
  isAuto: boolean;
  createdAt: Date;
  /** 커서 전용 — created_at 의 마이크로초 해상도를 잃지 않은 텍스트. */
  createdAtUs: string;
  /**
   * 저장된 증거 컬럼(2026-09-23 제3자 인용 판정 재설계) — job.reproFromStoredEvidence 인
   * 잡(v16·v17)만 읽는다. 그 외 잡은 이 세 필드를 쓰지 않는다(citations 에서 다시 판정한다).
   */
  citedOwnedVideoIds: string[];
  citedPressDomains: string[];
  citedSocialDomains: string[];
};

/**
 * 저장 행 → 계산기 입력. sentiment 는 저장값을 그대로 쓴다(재분류하지 않는다).
 * 판정 규칙은 수집 경로(automation-runner)와 동일하다.
 */
function deriveRowInputs(row: TargetRow, ws: ScopedWorkspaceFull): BaseVisibilityInputs {
  const answerText = row.answer ?? "";
  const answerLower = answerText.toLowerCase();

  const brandTargets = ws.websites
    .map((url) => normalizeTargetKey(url))
    .filter((k): k is { host: string; seg: string } => k !== null);

  const hasBodyUrl = brandTargets.some((t) => {
    if (SOCIAL_PLATFORM_DOMAINS.has(t.host)) {
      if (!t.seg) return false;
      return answerLower.includes(t.host) && answerLower.includes(t.seg);
    }
    return answerLower.includes(t.host);
  });

  const citedBrandDomains = matchCitationDomains(
    (row.citations ?? []) as Citation[],
    ws.websites,
  );
  const hasCitationOnly = !hasBodyUrl && citedBrandDomains.length > 0;

  const isBrandedQuery = !isInformationalPrompt(row.promptText, ws.brandTerms);

  // 빈 응답은 어떤 신호도 신뢰할 수 없어 수집 경로가 0 을 저장했다. 같은 계약을 유지한다.
  const { mentions, firstPos } = answerText
    ? deriveMentionInputs(answerText, ws.brandTerms)
    : { mentions: 0, firstPos: -1 };

  return {
    mentions,
    firstPos,
    hasBodyUrl,
    hasCitationOnly,
    sentiment: row.sentiment as Sentiment,
    isBrandedQuery,
    // 옛 판정은 언론 인용을 보지 않는다 — 항상 false(계획 D0: reproBase 는 "그때 저장된
    // 점수를 실제로 만든" 입력이어야 하므로, 존재조차 안 했던 판정을 반영하지 않는다).
    hasPressCitation: false,
  };
}

/** deriveNewJudgmentRowInputs 반환 — 목표 계산용 입력 + 그 시점 판정의 증거(백필용). */
type NewJudgmentResult = {
  base: BaseVisibilityInputs;
  citedOwnedVideoIds: string[];
  citedPressDomains: string[];
  /** 블로그·소셜 추천 증거 — 제3자 인용 판정 재설계(2026-09-23). 배점 없음(백필 전용). */
  citedSocialDomains: string[];
};

/**
 * 새 판정(계획 §3-3 targetBase 전용) — 소유 유튜브 인용을 hasCitationOnly 에 접고, 언론
 * 인용 증거를 함께 계산한다. job.applyOwnedCitationJudgment 가 true 인 잡(v15)에서만 쓴다.
 *
 * deriveRowInputs 와 공통부(언급·위치·isBrandedQuery·hasBodyUrl)가 겹치지만 일부러
 * 합치지 않는다 — 재현(reproBase)과 목표(targetBase)를 절대 뒤섞지 않는다는 D0 의 원칙을
 * 코드 구조로도 지키기 위해서다. 배치당 최대 200행이라 중복 계산 비용은 무시할 수준이다.
 *
 * 유튜브 소유 판정 루프는 automation-runner.ts 의 것과 로직이 같다 — youtube-video-match.ts
 * 는 계획 부록 F 의 "손대지 않는 것" 목록이라 공용 헬퍼로 뽑지 않고 각자 짧게 반복한다.
 */
function deriveNewJudgmentRowInputs(
  row: TargetRow,
  ws: ScopedWorkspaceFull,
  ownedVideoIds: Set<string>,
): NewJudgmentResult {
  const answerText = row.answer ?? "";
  const answerLower = answerText.toLowerCase();

  const brandTargets = ws.websites
    .map((url) => normalizeTargetKey(url))
    .filter((k): k is { host: string; seg: string } => k !== null);

  const hasBodyUrl = brandTargets.some((t) => {
    if (SOCIAL_PLATFORM_DOMAINS.has(t.host)) {
      if (!t.seg) return false;
      return answerLower.includes(t.host) && answerLower.includes(t.seg);
    }
    return answerLower.includes(t.host);
  });

  const citations = (row.citations ?? []) as Citation[];
  const citedBrandDomains = matchCitationDomains(citations, ws.websites);

  const ownedVideoCitationIds = new Set<string>();
  if (ownedVideoIds.size > 0) {
    for (const c of citations) {
      const raw = c.url || c.domain || "";
      if (isOwnedYoutubeVideo(raw, ownedVideoIds)) {
        const videoId = extractYoutubeVideoId(raw);
        if (videoId) ownedVideoCitationIds.add(videoId);
      }
    }
  }
  const citedOwnedVideoIds = [...ownedVideoCitationIds];

  // 소유 유튜브 인용은 "인용됨"(참고자료) 칸에 합류한다 — 새 상수 없음(D3).
  const hasCitationOnly =
    !hasBodyUrl && (citedBrandDomains.length > 0 || citedOwnedVideoIds.length > 0);

  // 제3자 인용 증거(언론 게재 · 블로그·소셜 추천) — 2026-09-23 3차 개정: "브랜드 언급 +
  // 우리 소유 아님"인 인용을 호스트가 소셜 플랫폼인지로 나눠 둘 다 남긴다(press-domain-
  // match.ts). ownedVideoIds 는 이 함수가 applyOwnedCitationJudgment 잡에서만 호출되므로
  // 이미 위에서 실제로 조회된 값이다.
  const thirdPartyEvidence = collectThirdPartyCitationEvidence(
    citations,
    ws.websites,
    ownedVideoIds,
    ws.brandTerms,
  );

  const isBrandedQuery = !isInformationalPrompt(row.promptText, ws.brandTerms);

  const { mentions, firstPos } = answerText
    ? deriveMentionInputs(answerText, ws.brandTerms)
    : { mentions: 0, firstPos: -1 };

  return {
    base: {
      mentions,
      firstPos,
      hasBodyUrl,
      hasCitationOnly,
      sentiment: row.sentiment as Sentiment,
      isBrandedQuery,
      hasPressCitation: thirdPartyEvidence.hasPressMatch,
      hasSocialCitation: thirdPartyEvidence.hasSocialMatch,
    },
    citedOwnedVideoIds,
    citedPressDomains: thirdPartyEvidence.pressDomains,
    citedSocialDomains: thirdPartyEvidence.socialDomains,
  };
}

/**
 * 저장된 증거로만 만드는 입력(계획 §5 v16 · reproFromStoredEvidence 전용) — reproBase·
 * targetBase 둘 다 이 함수 하나로 만든다(같은 객체). job v16 은 이미 새 판정(소유 유튜브
 * 인용 folding)으로 계산된 행(소스 버전 15)을 다루므로, deriveRowInputs(옛 판정)도
 * deriveNewJudgmentRowInputs(citations·소유 목록에서 다시 판정)도 맞지 않는다 — 후자를 쓰면
 * 소유 영상 목록이 v15 채점 시점 이후 바뀐 경우 그때와 다른 판정이 나올 수 있다(위험 ⓔ).
 *
 * hasBodyUrl·citedBrandDomains(→hasCitationOnly 의 한 갈래)는 텍스트·웹사이트 설정에서
 * 다시 계산한다 — 이건 기존 모든 잡(v11~v15)이 이미 하는 것과 같은 재계산이라 새 위험이
 * 아니다("소유 영상 목록"만 주기적으로 바뀌는 값이라 저장 증거로 고정할 대상이다).
 *
 * ⛔ 2026-09-24 결함 수정 — citedOwnedVideoIds·citedPressDomains·citedSocialDomains 세
 * 증거 컬럼을 전부 "저장값 그대로 읽기"로 처리했던 최초 구현은 v16 재산출의 목적 자체를
 * 무효화했다. cited_social_domains 는 이번 판(마이그레이션 0007)에서 새로 만든 컬럼이라
 * v16 소스 행(score_version 15) 중 마이그레이션 이전에 이미 채점된 기존 행은 DEFAULT
 * '{}' 로 저장값이 통째로 비어 있고, 그 행이 채점된 시점(v15)의 판정은 소셜 플랫폼을
 * 통째로 제외하던 2차 개정(press-domain-match.ts 의 옛 evaluatePressCitation)이라 "이
 * 인용이 소셜 추천이었다"는 사실 자체가 어디에도 저장돼 있지 않다 — 저장값을 그대로
 * 읽으면 그런 행에서는 블로거·소셜 추천이 영원히 0건으로만 나와 이번 재설계(3차 개정)가
 * 되살리려던 신호가 조용히 죽는다.
 *
 * 그래서 citedSocialDomains 만 "저장값이 있으면 그대로, 비어 있으면 row.citations 에서
 * 다시 분류" 로 처리한다(아래 코드) — citedPressDomains 처럼 무조건 저장값만 읽지 않는
 * 이유다. 저장값 우선인 이유는 실제로 값이 있는 행(마이그레이션 **이후** 이 컬럼까지
 * 채워서 채점된 행)에서 재분류가 그 값과 달라질 이유가 없기 때문이지, 재분류를 우회하기
 * 위해서가 아니다 — 재분류는 비어 있을 때만 켜지는 구제 경로다.
 *
 * citedOwnedVideoIds·citedPressDomains 는 예외 없이 저장값 그대로 읽는다 —
 * citedOwnedVideoIds 는 위 문단의 근거(라이브 목록 드리프트 회피)가 그대로 성립하고,
 * citedPressDomains 는 2차 개정의 "언론=true" 판정 술어(브랜드 언급 + 우리 소유 아님 +
 * 소셜 호스트 아님)가 3차 개정의 "press" 분류 술어와 순서만 다를 뿐 완전히 같아
 * (evaluatePressCitation ↔ classifyThirdPartyCitation 대조 확인) 저장값이 이미 정확하고,
 * 애초에 이 컬럼은 마이그레이션 이전 행에도 이미 있었다(cited_social_domains 만 신설).
 *
 * 재분류는 라이브 소유 영상 목록을 새로 조회하지 않는다 — 바로 아래에서 저장값 그대로
 * 읽은 citedOwnedVideoIds 를 집합으로 바꿔 분류 함수에 그대로 넘긴다. 그 값은 "이 행
 * 자신의 인용 중 소유로 판정된 영상 번호"만 담고 있으므로(automation-runner.ts 의
 * resolveCitationJudgment 가 저장한 값 그대로), 같은 행의 인용을 재분류할 때 소유 판정은
 * v15 채점 시점과 수학적으로 동일하게 재현되면서 언론/소셜 분류만 새 규칙(3차 개정)으로
 * 갱신된다 — 라이브 목록을 조회했다면 그 사이(주 2회 동기화) 목록이 바뀐 행에서 오분류가
 * 생겼을 것이다(deriveNewJudgmentRowInputs 를 쓰지 않는 이유와 같은 위험 ⓔ).
 *
 * v16a 는 이번 판에서 targetBase 로만 쓰이지만, reproBase 쪽 선언 세트(v15a)는 값이 있는
 * 신호를 그대로 받아도 안전하다 — v15a 의 genNoMentionPress·brandPress·genNoMentionSocial·
 * brandSocial 이 전부 0(미지정)이라 신호의 참/거짓과 무관하게 기여가 0이기 때문이다.
 */
function deriveStoredEvidenceRowInputs(
  row: TargetRow,
  ws: ScopedWorkspaceFull,
): { base: BaseVisibilityInputs } {
  const answerText = row.answer ?? "";
  const answerLower = answerText.toLowerCase();

  const brandTargets = ws.websites
    .map((url) => normalizeTargetKey(url))
    .filter((k): k is { host: string; seg: string } => k !== null);

  const hasBodyUrl = brandTargets.some((t) => {
    if (SOCIAL_PLATFORM_DOMAINS.has(t.host)) {
      if (!t.seg) return false;
      return answerLower.includes(t.host) && answerLower.includes(t.seg);
    }
    return answerLower.includes(t.host);
  });

  const citations = (row.citations ?? []) as Citation[];
  const citedBrandDomains = matchCitationDomains(citations, ws.websites);

  // ⭐ 소유 영상·언론 증거는 재계산하지 않고 이 행에 이미 저장된 값을 그대로 쓴다(근거는
  // 위 함수 docblock의 2026-09-24 결함 수정 문단).
  const citedOwnedVideoIds = row.citedOwnedVideoIds ?? [];
  const citedPressDomains = row.citedPressDomains ?? [];

  // ⛔ citedSocialDomains 만 예외 — cited_social_domains 는 이번 마이그레이션에서 새로
  // 생긴 컬럼이라 마이그레이션 이전에 이미 채점된 행은 저장값이 통째로 비어 있다. 저장값이
  // 있으면(정상 채점된 행) 그대로 믿고, 비어 있을 때만 row.citations 에서 다시 분류한다
  // (근거는 위 함수 docblock의 2026-09-24 결함 수정 문단). 재분류는 라이브 소유 목록 대신
  // 방금 읽은 citedOwnedVideoIds 를 집합으로 써서 드리프트를 피한다.
  const storedSocialDomains = row.citedSocialDomains ?? [];
  const citedSocialDomains =
    storedSocialDomains.length > 0
      ? storedSocialDomains
      : collectThirdPartyCitationEvidence(
          citations,
          ws.websites,
          new Set(citedOwnedVideoIds),
          ws.brandTerms,
        ).socialDomains;

  const hasCitationOnly =
    !hasBodyUrl && (citedBrandDomains.length > 0 || citedOwnedVideoIds.length > 0);

  const isBrandedQuery = !isInformationalPrompt(row.promptText, ws.brandTerms);

  const { mentions, firstPos } = answerText
    ? deriveMentionInputs(answerText, ws.brandTerms)
    : { mentions: 0, firstPos: -1 };

  return {
    base: {
      mentions,
      firstPos,
      hasBodyUrl,
      hasCitationOnly,
      sentiment: row.sentiment as Sentiment,
      isBrandedQuery,
      hasPressCitation: citedPressDomains.length > 0,
      hasSocialCitation: citedSocialDomains.length > 0,
    },
  };
}

/* ============================================================
 * 응답 조각
 * ============================================================ */

type Anomaly = { id: string; reason: string; matchedSets: string[] };
/**
 * manifest 한 줄.
 *
 * id 는 운영 DB 안에서만 유효한 키라, 저장소 밖에서 만든 기대값과 대조하려면 행을
 * 가리키는 다른 좌표가 필요하다. `kstDate · provider · promptKey` 세 값이 그 좌표다.
 */
type Change = {
  id: string;
  kstDate: string;
  provider: string;
  promptKey: string;
  before: number;
  after: number;
  fromVersion: number;
  toVersion: number;
  /**
   * 증거 컬럼 동시 백필(계획 §5 Step 6) — job.applyOwnedCitationJudgment 가 true 인 잡에서만
   * 값이 있다(v15). 그 외 잡은 undefined — 이 행의 기존 증거 컬럼 값을 건드리지 않는다.
   */
  citedOwnedVideoIds?: string[];
  citedPressDomains?: string[];
  citedSocialDomains?: string[];
};

function metaPayload(jobId: RescoreJobId) {
  const job = RESCORE_JOBS[jobId];
  return {
    job: jobId,
    jobHash: jobHash(jobId),
    windowFromUtc: job.fromUtc,
    windowToUtc: job.toUtc,
    providers: job.providers,
    sourceVersions: job.sourceVersions,
    targetVersion: job.targetVersion,
    targetSet: job.targetSet,
    informationalOnly: job.informationalOnly,
    workspaceScope: job.workspaceScope,
  };
}

/* ============================================================
 * POST
 * ============================================================ */

export async function POST(req: NextRequest) {
  const gate = checkGates(req);
  if (gate) return gate.response;

  const parsed = parseBody(await req.json().catch(() => ({})));
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { jobId, meta, report, preflight, dryRun, batchSize, cursor, operationId, codeSha } =
    parsed;
  const job = RESCORE_JOBS[jobId];
  const startedAt = Date.now();

  // ── meta: DB 접근 없음 ──
  if (meta) {
    return NextResponse.json({ ok: true, mode: "meta", ...metaPayload(jobId) });
  }

  try {
    const workspaces = await loadScopedWorkspaces(job);
    const cfgFingerprint = fingerprintOf(workspaces);
    const baseConditions = buildBaseConditions(job, workspaces);

    /* ── report ── */
    if (report) {
      const windows = [];
      for (const w of buildVerificationWindows(jobId)) {
        const rows = await db
          .select({
            provider: schema.runs.provider,
            visibilityScore: schema.runs.visibilityScore,
            createdAt: schema.runs.createdAt,
          })
          .from(schema.runs)
          .where(and(...buildReportConditions(w, workspaces)));

        const byKey = new Map<string, { sum: number; count: number }>();
        const byProvider = new Map<string, { sum: number; count: number }>();
        let sum = 0;
        for (const r of rows) {
          const kstDate = toKstDateKey(r.createdAt);
          const key = `${kstDate}|${r.provider}`;
          const cell = byKey.get(key) ?? { sum: 0, count: 0 };
          cell.sum += r.visibilityScore;
          cell.count += 1;
          byKey.set(key, cell);

          const pv = byProvider.get(r.provider) ?? { sum: 0, count: 0 };
          pv.sum += r.visibilityScore;
          pv.count += 1;
          byProvider.set(r.provider, pv);

          sum += r.visibilityScore;
        }

        const round2 = (n: number) => Number(n.toFixed(2));
        windows.push({
          key: w.key,
          fromUtc: w.fromUtc,
          toUtc: w.toUtc,
          providers: w.providers,
          excludeProviders: w.excludeProviders,
          total: rows.length,
          overallAvg: rows.length === 0 ? null : round2(sum / rows.length),
          byProvider: [...byProvider.entries()]
            .map(([provider, v]) => ({
              provider,
              count: v.count,
              avg: round2(v.sum / v.count),
            }))
            .sort((a, b) => a.provider.localeCompare(b.provider)),
          byProviderDate: [...byKey.entries()]
            .map(([key, v]) => {
              const [kstDate, provider] = key.split("|");
              return { kstDate, provider, count: v.count, avg: round2(v.sum / v.count) };
            })
            .sort(
              (a, b) => a.kstDate.localeCompare(b.kstDate) || a.provider.localeCompare(b.provider),
            ),
        });
      }

      return NextResponse.json({
        ok: true,
        mode: "report",
        ...metaPayload(jobId),
        cfgFingerprint,
        windows,
      });
    }

    /* ── preflight ── */
    if (preflight) {
      const termParity = checkTermParity(workspaces);
      // 창 전체를 한 번만 읽고 분포·정합을 JS 에서 계산한다.
      // 날짜 버킷을 SQL 로 만들면 화면(KST)과 다른 경계가 생길 수 있어, 표시층과 같은
      // toKstDateKey 로 묶는다. 창 크기는 수천 행 수준이라 비용이 문제되지 않는다.
      const rawWindowConditions = buildWindowConditions(
        { ...job, informationalOnly: false },
        workspaces,
      );

      const rawRows = await db
        .select({
          workspaceId: schema.runs.workspaceId,
          promptText: schema.runs.promptText,
          provider: schema.runs.provider,
          scoreVersion: schema.runs.scoreVersion,
          isAuto: schema.runs.isAuto,
          createdAt: schema.runs.createdAt,
        })
        .from(schema.runs)
        .where(and(...rawWindowConditions));

      const wsById = new Map(workspaces.map((w) => [w.id, w]));
      const informationalOf = (r: { workspaceId: string; promptText: string }) => {
        const ws = wsById.get(r.workspaceId);
        if (!ws) return false;
        return isInformationalPrompt(r.promptText, ws.brandTerms);
      };

      const jsInformationalCount = rawRows.filter(informationalOf).length;
      const [sqlInfoRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(and(...buildWindowConditions({ ...job, informationalOnly: true }, workspaces)));
      const sqlInformationalCount = sqlInfoRow?.count ?? 0;

      const windowRows = job.informationalOnly ? rawRows.filter(informationalOf) : rawRows;
      const windowTotal = windowRows.length;
      const manualCount = windowRows.filter((r) => r.isAuto !== true).length;

      // 소스·목표 버전은 그대로 정상이다. 뒤 잡 체인으로 이미 앞으로 간 버전(v15 창의 16·17 등)은
      // 그 행이 그 버전에 이르는 잡 경로의 **선택 조건을 모두 만족할 때만** 정상으로 본다
      // (Codex 1차 C3 · 2차 N2 — 버전만 보면 v12 창의 8월 행에 14～17 이 있어도 통과했다).
      const acceptedVersions = preflightAcceptedVersions(jobId);
      const ownVersions = new Set<number>([...job.sourceVersions, job.targetVersion]);
      const chainPaths = downstreamJobPaths(jobId);
      const isAcceptedRow = (r: (typeof windowRows)[number]): boolean => {
        if (ownVersions.has(r.scoreVersion)) return true;
        const paths = chainPaths.get(r.scoreVersion);
        if (!paths) return false;
        return paths.some((path) => path.every((id) => matchesJobSelection(r, RESCORE_JOBS[id], workspaces)));
      };
      const outOfScopeCount = windowRows.filter((r) => r.isAuto === true && !isAcceptedRow(r)).length;

      const [targetCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(and(...baseConditions));
      const targetCount = targetCountRow?.count ?? 0;

      const dateBuckets = new Map<string, number>();
      const workspaceBuckets = new Map<string, number>();
      for (const r of windowRows) {
        const key = `${toKstDateKey(r.createdAt)}|${r.scoreVersion}|${r.isAuto ? 1 : 0}`;
        dateBuckets.set(key, (dateBuckets.get(key) ?? 0) + 1);
        workspaceBuckets.set(r.workspaceId, (workspaceBuckets.get(r.workspaceId) ?? 0) + 1);
      }
      const versionByDate = [...dateBuckets.entries()]
        .map(([key, count]) => {
          const [kstDate, version, auto] = key.split("|");
          return { kstDate, scoreVersion: Number(version), isAuto: auto === "1", count };
        })
        .sort(
          (a, b) =>
            a.kstDate.localeCompare(b.kstDate) ||
            a.scoreVersion - b.scoreVersion ||
            Number(a.isAuto) - Number(b.isAuto),
        );
      const workspaceDistribution = [...workspaceBuckets.entries()]
        .map(([workspaceId, count]) => ({ workspaceId, count }))
        .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));

      return NextResponse.json({
        ok: true,
        mode: "preflight",
        ...metaPayload(jobId),
        cfgFingerprint,
        workspaceCount: workspaces.length,
        windowTotal,
        targetCount,
        manualCount,
        manualRatio: windowTotal === 0 ? 0 : Number((manualCount / windowTotal).toFixed(4)),
        outOfScopeCount,
        acceptedVersions,
        clean: outOfScopeCount === 0,
        sqlInformationalCount,
        jsInformationalCount,
        brandedParityOk: sqlInformationalCount === jsInformationalCount,
        termParityOk: termParity.ok,
        termCount: termParity.termCount,
        termDiffSample: termParity.diffSample,
        versionByDate,
        workspaceDistribution,
      });
    }

    /* ── sweep ── */
    const batchConditions = cursor
      ? [...baseConditions, buildCursorCondition(cursor)]
      : [...baseConditions];

    const targets = (await db
      .select({
        id: schema.runs.id,
        workspaceId: schema.runs.workspaceId,
        promptText: schema.runs.promptText,
        provider: schema.runs.provider,
        answer: schema.runs.answer,
        citations: schema.runs.citations,
        sentiment: schema.runs.sentiment,
        visibilityScore: schema.runs.visibilityScore,
        scoreVersion: schema.runs.scoreVersion,
        isAuto: schema.runs.isAuto,
        createdAt: schema.runs.createdAt,
        createdAtUs: cursorTimestampProjection,
        // reproFromStoredEvidence 잡(v16·v17) 전용 — 다른 잡은 이 세 필드를 읽지 않는다.
        // 모든 잡이 같은 쿼리를 공유하므로 조건부로 넣지 않고 항상 함께 가져온다(작은 text[] 3개).
        citedOwnedVideoIds: schema.runs.citedOwnedVideoIds,
        citedPressDomains: schema.runs.citedPressDomains,
        citedSocialDomains: schema.runs.citedSocialDomains,
      })
      .from(schema.runs)
      .where(and(...batchConditions))
      .orderBy(asc(schema.runs.createdAt), asc(schema.runs.id))
      .limit(batchSize)) as TargetRow[];

    const wsById = new Map(workspaces.map((w) => [w.id, w]));

    // ── SQL/JS 이중 확인: 하나라도 어긋나면 아무것도 적용하지 않고 중단한다 ──
    const mismatches: { id: string; reason: string }[] = [];
    for (const row of targets) {
      if (matchesJob(row, job, workspaces)) continue;
      const ws = wsById.get(row.workspaceId);
      const reason =
        !ws
          ? "workspace-out-of-scope"
          : job.informationalOnly && !isInformationalPrompt(row.promptText, ws.brandTerms)
            ? "branded-jsmismatch"
            : row.isAuto !== true
              ? "manual-jsmismatch"
              : "selector-jsmismatch";
      mismatches.push({ id: row.id, reason });
    }
    if (mismatches.length > 0) {
      // 사유별 집계 — SQL 이 골랐는데 JS 가 거부한 행이 왜 갈렸는지 바로 보이게 한다.
      const mismatchCounts: Record<string, number> = {};
      for (const m of mismatches) mismatchCounts[m.reason] = (mismatchCounts[m.reason] ?? 0) + 1;
      console.error(
        `[visibility-rescore] selector 불일치 ${mismatches.length}건 — 배치 중단 (job=${jobId})`,
      );
      return NextResponse.json(
        {
          ok: false,
          error: "selector_mismatch",
          job: jobId,
          mismatchTotal: mismatches.length,
          mismatchCounts,
          mismatches: mismatches.slice(0, 20),
          nextCursor: cursor
            ? { createdAtUs: cursor.createdAtUs, id: cursor.id }
            : null,
        },
        { status: 409 },
      );
    }

    // 소유 유튜브 영상 집합 — job.applyOwnedCitationJudgment 가 true 인 잡(v15)에서만
    // 워크스페이스별로 조회한다. 그 외 잡(v11~v14)은 targetBase = reproBase 라 이 집합을
    // 아예 쓰지 않으므로 조회 자체를 건너뛴다(불필요한 DB 호출·의존 없음).
    const ownedVideoIdsByWorkspace = new Map<string, Set<string>>();
    if (job.applyOwnedCitationJudgment) {
      await Promise.all(
        workspaces.map(async (w) => {
          ownedVideoIdsByWorkspace.set(w.id, await getOwnedYoutubeVideoIds(w.id));
        }),
      );
    }

    // ── 역산 · 목표 산출 ──
    const anomalies: Anomaly[] = [];
    const pending: (Change & { workspaceId: string })[] = [];
    let lastVisited: Cursor | null = cursor;

    for (const row of targets) {
      lastVisited = { createdAtUs: row.createdAtUs, id: row.id };
      const ws = wsById.get(row.workspaceId);
      if (!ws) {
        anomalies.push({ id: row.id, reason: "no-workspace", matchedSets: [] });
        continue;
      }

      const declaredSetId = reproSetForVersion(row.scoreVersion);
      if (!declaredSetId) {
        anomalies.push({ id: row.id, reason: "unmapped-version", matchedSets: [] });
        continue;
      }

      // ⛔ D0(계획 §3-3) — reproBase 는 "그때 저장된 점수를 실제로 만든" 판정, targetBase 는
      // job 성격에 따라 셋 중 하나로 갈라진다:
      //   1. job.reproFromStoredEvidence(v16·v17) — 저장된 증거 컬럼에서 reproBase·targetBase
      //      **둘 다** 같은 함수로 만든다(deriveStoredEvidenceRowInputs). 이 잡의 소스 행은
      //      이미 새 판정으로 계산돼 있어 옛 판정(deriveRowInputs)을 쓰면 안 맞는다.
      //   2. job.applyOwnedCitationJudgment(v15) — reproBase 는 옛 판정, targetBase 만
      //      citations·소유 목록에서 새로 판정한다(deriveNewJudgmentRowInputs).
      //   3. 그 외(v11~v14) — targetBase === reproBase(같은 객체). D0 수정 이전과 동일.
      let reproBase: BaseVisibilityInputs;
      let targetBase: BaseVisibilityInputs;
      let newEvidence: {
        citedOwnedVideoIds: string[];
        citedPressDomains: string[];
        citedSocialDomains: string[];
      } | null = null;
      if (job.reproFromStoredEvidence) {
        const stored = deriveStoredEvidenceRowInputs(row, ws);
        reproBase = stored.base;
        targetBase = stored.base;
        // newEvidence 는 null 로 둔다 — v16 은 증거를 다시 계산하지 않고 이미 저장된 값을
        // 그대로 재사용하므로, UPDATE SET 절에서 증거 컬럼을 건드릴 필요가 없다(아래 §
        // 적용 로직이 newEvidence undefined 필드를 SET 에서 자동으로 뺀다).
      } else {
        reproBase = deriveRowInputs(row, ws);
        targetBase = reproBase;
        if (job.applyOwnedCitationJudgment) {
          const judged = deriveNewJudgmentRowInputs(
            row,
            ws,
            ownedVideoIdsByWorkspace.get(ws.id) ?? new Set<string>(),
          );
          targetBase = judged.base;
          newEvidence = {
            citedOwnedVideoIds: judged.citedOwnedVideoIds,
            citedPressDomains: judged.citedPressDomains,
            citedSocialDomains: judged.citedSocialDomains,
          };
        }
      }

      let resolution;
      try {
        resolution = resolveWithDiagnostics({
          reproBase,
          targetBase,
          storedScore: row.visibilityScore,
          declaredSetId,
          diagnosticSetIds: job.diagnosticSets,
          targetSetId: job.targetSet,
        });
      } catch (err) {
        console.error(
          `[visibility-rescore] run ${row.id} 처리 실패:`,
          err instanceof Error ? err.message : "unknown",
        );
        anomalies.push({ id: row.id, reason: "error", matchedSets: [] });
        continue;
      }

      if (resolution.status !== "resolved" || resolution.targetScore === null) {
        anomalies.push({
          id: row.id,
          reason: resolution.status,
          matchedSets: resolution.matchedSets,
        });
        continue;
      }

      pending.push({
        id: row.id,
        workspaceId: row.workspaceId,
        kstDate: toKstDateKey(row.createdAt),
        provider: row.provider,
        promptKey: promptKey(row.promptText),
        before: row.visibilityScore,
        after: resolution.targetScore,
        fromVersion: row.scoreVersion,
        toVersion: job.targetVersion,
        // 증거 컬럼 동시 백필(계획 §5 Step 6) — newEvidence 가 있을 때만(v15) 싣는다.
        ...(newEvidence ?? {}),
      });
    }

    // ── 적용 (배치 하나 = 트랜잭션 하나) ──
    let updated = 0;
    let conflicted = 0;
    const applied: Change[] = [];

    if (!dryRun && pending.length > 0) {
      await db.transaction(async (tx) => {
        for (const change of pending) {
          // 3중 CAS — id + 소스 버전 + 조회 당시 점수. 조회 이후 값이 바뀐 행은 건드리지 않는다.
          // sentiment 는 SET 절에 넣지 않는다(저장값 보존). 증거 컬럼은 job 이 새 판정을 쓸
          // 때만(v15) SET 절에 들어간다 — 그 외 잡은 기존 증거 컬럼 값을 그대로 둔다.
          const affected = await tx
            .update(schema.runs)
            .set({
              visibilityScore: change.after,
              scoreVersion: change.toVersion,
              ...(change.citedOwnedVideoIds !== undefined
                ? { citedOwnedVideoIds: change.citedOwnedVideoIds }
                : {}),
              ...(change.citedPressDomains !== undefined
                ? { citedPressDomains: change.citedPressDomains }
                : {}),
              ...(change.citedSocialDomains !== undefined
                ? { citedSocialDomains: change.citedSocialDomains }
                : {}),
            })
            .where(
              and(
                eq(schema.runs.id, change.id),
                eq(schema.runs.scoreVersion, change.fromVersion),
                eq(schema.runs.visibilityScore, change.before),
              ),
            )
            .returning({ id: schema.runs.id });

          if (affected.length === 0) {
            conflicted += 1;
            continue;
          }
          updated += 1;
          applied.push({
            id: change.id,
            kstDate: change.kstDate,
            provider: change.provider,
            promptKey: change.promptKey,
            before: change.before,
            after: change.after,
            fromVersion: change.fromVersion,
            toVersion: change.toVersion,
            citedOwnedVideoIds: change.citedOwnedVideoIds,
            citedPressDomains: change.citedPressDomains,
            citedSocialDomains: change.citedSocialDomains,
          });
        }
      });
    }

    const changes: Change[] = dryRun
      ? pending.map(
          ({
            id,
            kstDate,
            provider,
            promptKey: pk,
            before,
            after,
            fromVersion,
            toVersion,
            citedOwnedVideoIds,
            citedPressDomains,
            citedSocialDomains,
          }) => ({
            id,
            kstDate,
            provider,
            promptKey: pk,
            before,
            after,
            fromVersion,
            toVersion,
            citedOwnedVideoIds,
            citedPressDomains,
            citedSocialDomains,
          }),
        )
      : applied;

    // ── 잔여 집계 ──
    const aheadConditions = lastVisited
      ? [...baseConditions, buildCursorCondition(lastVisited)]
      : [...baseConditions];
    const [aheadRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(and(...aheadConditions));
    const remainingAfterCursor = aheadRow?.count ?? 0;

    const [residualRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(and(...baseConditions));
    const residualTotal = residualRow?.count ?? 0;

    const anomalyCounts: Record<string, number> = {};
    for (const a of anomalies) anomalyCounts[a.reason] = (anomalyCounts[a.reason] ?? 0) + 1;

    // 소유 유튜브 영상 목록 지문 — 계획 §4-4(D6 보강). job 이 새 판정을 쓸 때만(v15) 의미가
    // 있으므로, 이미 위에서 조회해 둔 ownedVideoIdsByWorkspace 를 재사용한다(추가 DB 호출 0).
    const ownedVideoFingerprint = job.applyOwnedCitationJudgment
      ? ownedVideoListFingerprint([...new Set([...ownedVideoIdsByWorkspace.values()].flatMap((s) => [...s]))])
      : null;

    return NextResponse.json({
      ok: true,
      mode: "sweep",
      ...metaPayload(jobId),
      operationId,
      codeSha,
      cfgFingerprint,
      ownedVideoFingerprint,
      dryRun,
      processed: targets.length,
      updated,
      conflicted,
      anomalies,
      anomalyCounts,
      changes,
      firstKstDate: targets.length > 0 ? toKstDateKey(targets[0].createdAt) : null,
      lastKstDate:
        targets.length > 0 ? toKstDateKey(targets[targets.length - 1].createdAt) : null,
      remainingAfterCursor,
      residualTotal,
      nextCursor: lastVisited
        ? { createdAtUs: lastVisited.createdAtUs, id: lastVisited.id }
        : null,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    // stack 은 서버 로그에만 남기고 응답 body 에는 넣지 않는다(다른 route 관례).
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[/api/internal/visibility-rescore] 실패:", msg, err instanceof Error ? err.stack : undefined);
    return NextResponse.json(
      {
        ok: false,
        error: "internal_error",
        job: jobId,
        // 재개 지점 — 이 배치는 트랜잭션 단위로 전량 롤백됐다.
        nextCursor: cursor ? { createdAtUs: cursor.createdAtUs, id: cursor.id } : null,
      },
      { status: 500 },
    );
  }
}
