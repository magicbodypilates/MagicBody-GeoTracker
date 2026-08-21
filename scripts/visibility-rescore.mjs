/**
 * 기간별 점수 룰 세트 재산출 — 운영 실행 스크립트.
 *
 * 사용 (앱 컨테이너 안에서):
 *   node scripts/visibility-rescore.mjs <mode> --job <v11|v12|v12t> [옵션]
 *
 * 모드
 *   report          검증 창별 평균(변경 없음)
 *   preflight       대상 건수·버전 분포·정합 점검(변경 없음). 게이트 불통과 시 exit 1
 *   sweep           배치를 이어 처리. **--apply 를 줄 때만 저장**하고 기본은 계산만이다
 *   rollback        manifest 의 before 값으로 되돌림(3중 CAS)
 *   reconcile       manifest 의 각 행이 실제로 적용됐는지 재조회해 분류
 *   verify-manifest 실행 manifest 를 저장소 밖 기대 manifest 와 다중집합 대조(로컬 전용)
 *
 * 환경변수
 *   INTERNAL_CRON_SECRET  앱과 공유하는 내부 호출 비밀키 (verify-manifest 외 필수)
 *   POSTGRES_URL          rollback·reconcile 만 사용
 *   PORT                  앱이 듣는 포트 (기본 3000). 라우트의 Host 화이트리스트와 같은 정본
 *   RESCORE_CODE_SHA      실행 시점 코드 식별자 (선택)
 *
 * 출력 규약
 *   stdout — 기계가 읽는 줄만: `AUDIT {json}` · `SUMMARY {json}` · `REPORT {json}` 등.
 *            워크플로가 이 stdout 을 파일로 남기고 **로그에는 건수만** 남긴다.
 *   stderr — 사람이 읽는 진행 상황. 워크플로 로그(공개)에 그대로 실리므로 **집계값·평균 등
 *            측정치를 쓰지 않는다.** 값은 stdout(파일)에만 있다.
 *
 * 이 스크립트에는 점수 계산이 한 줄도 없다. 대상 판정·역산·재계산은 전부 앱 라우트가 한다.
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";

/**
 * 내부 호출 전용 — 외부 URL fallback 을 두지 않는다.
 *
 * 포트 정본은 `PORT` 하나다. 라우트의 Host 화이트리스트도 같은 값에서 파생되므로,
 * 한쪽만 바뀌어 조용히 403 이 나는 일이 생기지 않는다.
 */
const APP_PORT = process.env.PORT ?? "3000";
const TARGET_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const ENDPOINT = `${TARGET_ORIGIN}/geo-tracker/api/internal/visibility-rescore`;
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_BATCH_SIZE = 100;

/** 점수 컬럼이 가질 수 있는 값의 범위 — manifest 검증에 쓴다. */
const SCORE_MIN = 0;
const SCORE_MAX = 100;

const MODES = ["report", "preflight", "sweep", "rollback", "reconcile", "verify-manifest"];
const JOB_IDS = ["v11", "v12", "v12t"];
/** rollback·reconcile 이 읽는 manifest 는 마운트된 고정 디렉터리 안의 파일만 허용한다. */
const MANIFEST_DIR = "/app/data/audit";
const MANIFEST_BASENAME_RE = /^rescore_[A-Za-z0-9_.-]+\.jsonl$/;

const out = (line) => process.stdout.write(`${line}\n`);
const log = (...args) => process.stderr.write(`${args.join(" ")}\n`);

function usage() {
  log(`사용법:
  node scripts/visibility-rescore.mjs report    --job <${JOB_IDS.join("|")}>
  node scripts/visibility-rescore.mjs preflight --job <${JOB_IDS.join("|")}>
  node scripts/visibility-rescore.mjs sweep     --job <id> [--apply] [--batch-size N] [--cursor-created <UTC 마이크로초 6자리> --cursor-id UUID]
  node scripts/visibility-rescore.mjs rollback  --job <id> --manifest <파일명 또는 ${MANIFEST_DIR}/파일명>
  node scripts/visibility-rescore.mjs reconcile --job <id> --manifest <파일명 또는 ${MANIFEST_DIR}/파일명>
  node scripts/visibility-rescore.mjs verify-manifest --job <id> --manifest <경로> --expected <경로> [--show-sample]

옵션:
  --apply          sweep 에서 **실제로 저장**한다. 없으면 계산만 (기본이 안전한 쪽)
  --dry-run        계산만 한다는 것을 명시 (--apply 와 함께 줄 수 없다)
  --batch-size N   1~200 (기본 ${DEFAULT_BATCH_SIZE})
  --max-batches N  안전 상한 (기본 1000)
  --expected P     verify-manifest 의 기대 manifest 경로
  --show-sample    verify-manifest 에서 차이 표본을 함께 출력 (기본 꺼짐 — 값 노출 방지)
  --help           이 도움말

환경변수: INTERNAL_CRON_SECRET (verify-manifest 외 필수) · POSTGRES_URL (rollback·reconcile)
          PORT (기본 3000) · RESCORE_CODE_SHA (선택)`);
}

/* ============================================================
 * 인자
 * ============================================================ */

function parseArgs(argv) {
  const args = { mode: null, job: null, apply: false, dryRun: false, batchSize: DEFAULT_BATCH_SIZE, maxBatches: 1000, manifest: null, expected: null, showSample: false, cursor: null, help: false };
  const rest = [...argv];
  let cursorCreated = null;
  let cursorId = null;

  while (rest.length > 0) {
    const token = rest.shift();
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--apply") {
      args.apply = true;
    } else if (token === "--show-sample") {
      args.showSample = true;
    } else if (token === "--expected") {
      args.expected = rest.shift() ?? null;
    } else if (token === "--job") {
      args.job = rest.shift() ?? null;
    } else if (token === "--manifest") {
      args.manifest = rest.shift() ?? null;
    } else if (token === "--batch-size") {
      args.batchSize = Number(rest.shift());
    } else if (token === "--max-batches") {
      args.maxBatches = Number(rest.shift());
    } else if (token === "--cursor-created") {
      cursorCreated = rest.shift() ?? null;
    } else if (token === "--cursor-id") {
      cursorId = rest.shift() ?? null;
    } else if (!token.startsWith("-") && args.mode === null) {
      args.mode = token;
    } else {
      throw new Error(`알 수 없는 인자: ${token}`);
    }
  }

  if (cursorCreated || cursorId) {
    if (!cursorCreated || !cursorId) throw new Error("--cursor-created 와 --cursor-id 는 함께 준다");
    // 형식은 라우트와 동일하게 마이크로초 6자리 고정 — 밀리초까지만 담긴 커서는
    // 자기 행을 다시 고르므로 여기서 먼저 막는다.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursorCreated)) {
      throw new Error("--cursor-created 는 2026-07-31T12:46:13.011985Z 형태(마이크로초 6자리)여야 한다");
    }
    args.cursor = { createdAtUs: cursorCreated, id: cursorId };
  }
  return args;
}

function validate(args) {
  if (!MODES.includes(args.mode)) throw new Error(`모드는 ${MODES.join(" | ")} 중 하나여야 한다`);
  if (!JOB_IDS.includes(args.job)) throw new Error(`--job 은 ${JOB_IDS.join(" | ")} 중 하나여야 한다`);
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 200) {
    throw new Error("--batch-size 는 1~200 정수여야 한다");
  }
  if (!Number.isInteger(args.maxBatches) || args.maxBatches < 1) {
    throw new Error("--max-batches 는 1 이상 정수여야 한다");
  }
  if (args.mode === "rollback" || args.mode === "reconcile") {
    if (!args.manifest) throw new Error(`${args.mode} 에는 --manifest 가 필요하다`);
  }
  if (args.mode === "verify-manifest") {
    if (!args.manifest) throw new Error("verify-manifest 에는 --manifest 가 필요하다");
    if (!args.expected) throw new Error("verify-manifest 에는 --expected 가 필요하다");
  }
  // 서로 반대를 가리킬 수 있는 조합은 받지 않는다(라우트도 같은 규칙으로 400 을 낸다).
  if (args.apply && args.dryRun) throw new Error("--apply 와 --dry-run 은 함께 줄 수 없다");
  if (args.apply && args.mode !== "sweep") throw new Error("--apply 는 sweep 에서만 쓴다");
}

/** 경로 조작을 막기 위해 basename 만 받아 고정 디렉터리에 붙인다. */
function resolveManifestPath(input) {
  const base = input.split(/[\\/]/).pop() ?? "";
  if (!MANIFEST_BASENAME_RE.test(base)) {
    throw new Error(`manifest 파일명 규칙 위반: ${base}`);
  }
  return `${MANIFEST_DIR}/${base}`;
}

/* ============================================================
 * HTTP
 * ============================================================ */

function secret() {
  const value = process.env.INTERNAL_CRON_SECRET;
  if (!value) throw new Error("INTERNAL_CRON_SECRET 환경변수 필요");
  return value;
}

async function callRoute(body) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 값은 헤더로만 나가고 인자·로그·출력 어디에도 남기지 않는다.
        "x-cron-secret": secret(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`요청 실패: ${err instanceof Error ? err.message : "unknown"}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`응답 파싱 실패 (status ${res.status})`);
  }
  if (!res.ok) {
    // 오류 메시지는 stderr 를 거쳐 공개 실행 로그로 나간다. 본문 전체(행 id·집계값 포함)를
    // 붙이지 않고 상태 코드와 오류 코드만 남긴다. 전체 payload 는 객체에만 실어 둔다.
    const code = json && typeof json === "object" && typeof json.error === "string" ? json.error : "unknown";
    const err = new Error(`라우트 오류 status=${res.status} code=${code}`);
    err.payload = json;
    throw err;
  }
  return json;
}

/* ============================================================
 * 모드
 * ============================================================ */

async function runReport(args) {
  const body = await callRoute({ job: args.job, report: true });
  out(`REPORT ${JSON.stringify(body)}`);
  // 집계값은 stdout(파일)에만 남긴다 — stderr 는 공개 실행 로그로 흘러간다.
  log(`[report] job=${args.job} 창=${body.windows.length}개 설정지문=${body.cfgFingerprint}`);
  for (const w of body.windows) {
    log(`  ${w.key.padEnd(15)} n=${String(w.total).padStart(6)}`);
  }
  return 0;
}

async function runPreflight(args) {
  const body = await callRoute({ job: args.job, preflight: true });
  out(`PREFLIGHT ${JSON.stringify(body)}`);
  log(
    `[preflight] job=${args.job} clean=${body.clean} brandedParityOk=${body.brandedParityOk} ` +
      `termParityOk=${body.termParityOk} 설정지문=${body.cfgFingerprint}`,
  );

  let ok = true;
  if (!body.clean) {
    log("[preflight] 중단 — 창 안에 소스·목표 버전 밖 자동 수집 행이 있다(상세는 결과 파일)");
    ok = false;
  }
  if (!body.brandedParityOk) {
    log("[preflight] 중단 — SQL·JS 의 브랜드 질의 판정이 갈린다(상세는 결과 파일)");
    ok = false;
  }
  if (!body.termParityOk) {
    // 저장 점수를 만든 별칭 목록과 재산출이 쓰는 별칭 목록이 다르면 역산 전제가 깨진다.
    log("[preflight] 중단 — 수집 경로와 재산출 경로의 브랜드 별칭 파싱이 다르다(상세는 결과 파일)");
    ok = false;
  }
  if (body.manualRatio > 0.05) {
    log("[preflight] 주의 — 수동 수집 비율이 5% 를 넘는다. 사람 판단 필요(상세는 결과 파일)");
  }
  return ok ? 0 : 1;
}

async function runSweep(args) {
  const operationId = randomUUID();
  const codeSha = process.env.RESCORE_CODE_SHA ?? null;
  // 저장은 --apply 를 준 실행에서만 한다. 기본값이 안전한 쪽이어야 오타·잘린 인자가
  // 곧바로 운영 UPDATE 가 되지 않는다.
  const mode = args.apply ? "live" : "dry-run";

  let cursor = args.cursor;
  let batches = 0;
  let completed = false;
  const totals = { processed: 0, updated: 0, conflicted: 0, changes: 0, anomalies: {} };
  let last = null;
  const startedAt = Date.now();

  /** 성공·실패 SUMMARY 가 같은 키 집합을 갖게 한다(감사 파서가 갈리지 않도록). */
  const summary = (extra) => ({
    op: operationId,
    job: args.job,
    jobHash: last?.jobHash ?? null,
    codeSha,
    cfg: last?.cfgFingerprint ?? null,
    mode,
    batches,
    processed: totals.processed,
    updated: totals.updated,
    conflicted: totals.conflicted,
    manifestLines: totals.changes,
    anomalies: totals.anomalies,
    residualTotal: last?.residualTotal ?? null,
    elapsedMs: Date.now() - startedAt,
    ...extra,
  });

  log(`[sweep] job=${args.job} mode=${mode} op=${operationId} batch=${args.batchSize}`);

  while (batches < args.maxBatches) {
    batches += 1;
    let body;
    try {
      body = await callRoute({
        job: args.job,
        // 라우트는 apply 가 없으면 계산만 한다. dryRun 과 함께 보내면 400 이므로 하나만 보낸다.
        ...(args.apply ? { apply: true } : { dryRun: true }),
        batchSize: args.batchSize,
        cursor,
        operationId,
        codeSha,
      });
    } catch (err) {
      // 자동 재시도 없음 — 마지막 성공 커서를 남기고 중단한다(같은 커서로 사람이 재개).
      log(`[sweep] 실패: ${err instanceof Error ? err.message : "unknown"}`);
      log(
        cursor
          ? `[sweep] 재개 커서 --cursor-created ${cursor.createdAtUs} --cursor-id ${cursor.id}`
          : "[sweep] 재개 커서 없음(처음부터 재시작)",
      );
      // 상세(409 불일치 목록 등)는 파일로만 남긴다 — 로그가 아니라 여기서 본다.
      if (err && err.payload !== undefined) {
        out(`ERROR ${JSON.stringify({ op: operationId, job: args.job, mode, payload: err.payload })}`);
      }
      out(`SUMMARY ${JSON.stringify(summary({ status: "failed", lastCursor: cursor }))}`);
      return 1;
    }

    last = body;
    totals.processed += body.processed;
    totals.updated += body.updated;
    totals.conflicted += body.conflicted;
    totals.changes += body.changes.length;
    for (const [reason, count] of Object.entries(body.anomalyCounts ?? {})) {
      totals.anomalies[reason] = (totals.anomalies[reason] ?? 0) + count;
    }

    for (const change of body.changes) {
      out(
        `AUDIT ${JSON.stringify({
          op: operationId,
          job: body.job,
          jobHash: body.jobHash,
          codeSha,
          cfg: body.cfgFingerprint,
          mode,
          id: change.id,
          kstDate: change.kstDate,
          provider: change.provider,
          promptKey: change.promptKey,
          fromVersion: change.fromVersion,
          toVersion: change.toVersion,
          before: change.before,
          after: change.after,
          set: body.targetSet,
          ts: new Date().toISOString(),
        })}`,
      );
    }
    for (const anomaly of body.anomalies) {
      out(
        `ANOMALY ${JSON.stringify({
          op: operationId,
          job: body.job,
          mode,
          id: anomaly.id,
          reason: anomaly.reason,
          matchedSets: anomaly.matchedSets,
        })}`,
      );
    }

    log(
      `[sweep] batch ${batches} 처리=${body.processed} 적용=${body.updated} 충돌=${body.conflicted} ` +
        `남음=${body.remainingAfterCursor}`,
    );

    if (body.remainingAfterCursor === 0) {
      cursor = body.nextCursor;
      completed = true;
      break;
    }
    if (body.processed === 0) {
      log("[sweep] 중단 — 남은 대상이 있다고 보고했으나 배치가 비었다(커서 정체)");
      out(`SUMMARY ${JSON.stringify(summary({ status: "cursor-stalled", lastCursor: cursor }))}`);
      return 1;
    }
    // ── 정체 감지 ──
    // 종료 판정을 remainingAfterCursor === 0 하나에만 걸면, 커서가 전진하지 않는 순간
    // 같은 행을 상한(maxBatches)까지 반복 처리한다. dry-run 은 행을 바꾸지 않아 잔여가
    // 스스로 줄지 않으므로 커서 전진이 유일한 진행 신호다. 배치가 비지 않았더라도
    // (processed > 0) 커서가 직전과 같으면 진행이 멈춘 것이므로 즉시 중단한다.
    const advanced =
      body.nextCursor !== null &&
      (cursor === null ||
        body.nextCursor.createdAtUs !== cursor.createdAtUs ||
        body.nextCursor.id !== cursor.id);
    if (!advanced) {
      log(
        `[sweep] 중단 — 커서가 전진하지 않았다(정체). 처리=${body.processed} ` +
          `커서=${cursor ? `${cursor.createdAtUs}/${cursor.id}` : "없음"}`,
      );
      out(`SUMMARY ${JSON.stringify(summary({ status: "cursor-stalled", lastCursor: cursor }))}`);
      return 1;
    }
    cursor = body.nextCursor;
  }

  const residualTotal = last?.residualTotal ?? null;
  const anomalySum = Object.values(totals.anomalies).reduce((a, b) => a + b, 0);
  // 상한 도달 판정은 "루프가 break 없이 빠져나왔는가" 로만 한다. 정확히 maxBatches 번째
  // 배치에서 정상 종료한 실행을 거짓 실패로 만들지 않기 위해서다.
  const status = completed ? "completed" : "batch-limit";
  out(`SUMMARY ${JSON.stringify(summary({ status, lastCursor: cursor }))}`);
  log(
    `[sweep] 종료 status=${status} 처리=${totals.processed} 적용=${totals.updated} ` +
      `충돌=${totals.conflicted} anomaly=${anomalySum} 잔여=${residualTotal}`,
  );

  if (!completed) {
    log("[sweep] 경고 — 배치 상한에 도달했다. 남은 대상이 있을 수 있으니 잔여를 확인할 것");
    return 1;
  }
  if (args.apply && residualTotal !== null && residualTotal !== anomalySum + totals.conflicted) {
    log(
      `[sweep] 경고 — 잔여(${residualTotal})가 anomaly+충돌(${anomalySum + totals.conflicted})과 다르다. 재스윕으로 확인할 것`,
    );
  }
  return 0;
}

/* ============================================================
 * manifest 기반 모드 (DB 직접)
 * ============================================================ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isScore = (v) => Number.isInteger(v) && v >= SCORE_MIN && v <= SCORE_MAX;

/**
 * manifest 한 줄의 값 검증.
 *
 * 이 값들은 그대로 UPDATE 파라미터가 된다. 값 자체는 바인딩되므로 주입 위험은 없지만,
 * audit 디렉터리에 쓸 수 있는 사람이 `after`·`toVersion` 을 현재 DB 값에 맞춰 3중 CAS 를
 * 통과시키고 `before` 에 임의 점수를 넣으면 원장에 실린 행의 점수를 마음대로 덮어쓸 수 있다.
 * 방어 비용이 거의 0 이므로 잡 정의가 허용하는 범위 밖 값은 파일 전체를 거부한다.
 */
function validateManifestEntry(e, lineNo, expected) {
  const bad = (why) => {
    throw new Error(`manifest ${lineNo}행: ${why}`);
  };
  if (!e || typeof e !== "object") bad("객체가 아니다");
  if (typeof e.id !== "string" || !UUID_RE.test(e.id)) bad("id 가 UUID 가 아니다");
  if (typeof e.op !== "string" || !UUID_RE.test(e.op)) bad("op 가 UUID 가 아니다");
  if (typeof e.job !== "string") bad("job 이 문자열이 아니다");
  if (typeof e.jobHash !== "string") bad("jobHash 이 문자열이 아니다");
  if (!isScore(e.before)) bad(`before ${SCORE_MIN}~${SCORE_MAX} 정수가 아니다`);
  if (!isScore(e.after)) bad(`after ${SCORE_MIN}~${SCORE_MAX} 정수가 아니다`);
  if (!expected.sourceVersions.includes(e.fromVersion)) bad("fromVersion 이 이 잡의 소스 버전 집합 밖이다");
  if (e.toVersion !== expected.targetVersion) bad("toVersion 이 이 잡의 목표 버전이 아니다");
}

function readManifest(path, expected) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("AUDIT ")) continue;
    let entry;
    try {
      entry = JSON.parse(line.slice("AUDIT ".length));
    } catch (err) {
      throw new Error(
        `manifest ${i + 1}행 JSON 파싱 실패: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
    validateManifestEntry(entry, i + 1, expected);
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error(`manifest 에 AUDIT 줄이 없다: ${path}`);

  const jobs = new Set(entries.map((e) => e.job));
  const hashes = new Set(entries.map((e) => e.jobHash));
  if (jobs.size !== 1 || !jobs.has(expected.job)) {
    throw new Error(`manifest 의 잡(${[...jobs].join(",")})이 대상 잡(${expected.job})과 다르다`);
  }
  if (hashes.size !== 1 || !hashes.has(expected.jobHash)) {
    throw new Error("manifest 의 잡 정의 해시가 현재 잡 정의와 다르다 — 다른 실행의 파일이다");
  }
  const ops = new Set(entries.map((e) => e.op));
  if (ops.size !== 1) {
    throw new Error(`manifest 에 실행 식별자가 ${ops.size}개 섞여 있다 — 파일을 분리할 것`);
  }
  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) {
    throw new Error("manifest 에 같은 행 id 가 두 번 이상 있다 — 되돌림이 중복 적용될 수 있다");
  }
  return entries;
}

/** meta 응답(잡 정의 정본)에서 manifest 검증 기준을 만든다. */
function manifestExpectation(jobId, meta) {
  return {
    job: jobId,
    jobHash: meta.jobHash,
    sourceVersions: meta.sourceVersions,
    targetVersion: meta.targetVersion,
  };
}

async function openDb() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("POSTGRES_URL 환경변수 필요");
  const { default: postgres } = await import("postgres");
  return postgres(url, { max: 1 });
}

async function runRollback(args) {
  const meta = await callRoute({ job: args.job, meta: true });
  const path = resolveManifestPath(args.manifest);
  const entries = readManifest(path, manifestExpectation(args.job, meta));

  const sql = await openDb();
  let restored = 0;
  let skipped = 0;
  const startedAt = Date.now();
  try {
    for (const e of entries) {
      // 3중 CAS — 우리가 만든 결과 그대로일 때만 되돌린다.
      const affected = await sql`
        UPDATE runs
           SET visibility_score = ${e.before}, score_version = ${e.fromVersion}
         WHERE id = ${e.id}
           AND score_version = ${e.toVersion}
           AND visibility_score = ${e.after}
        RETURNING id
      `;
      if (affected.length === 1) {
        restored += 1;
        out(
          `ROLLBACK ${JSON.stringify({
            op: e.op,
            job: e.job,
            id: e.id,
            from: { score: e.after, version: e.toVersion },
            to: { score: e.before, version: e.fromVersion },
            ts: new Date().toISOString(),
          })}`,
        );
      } else {
        skipped += 1;
        out(`ROLLBACK_SKIP ${JSON.stringify({ op: e.op, job: e.job, id: e.id })}`);
      }
    }
  } finally {
    await sql.end();
  }

  out(
    `SUMMARY ${JSON.stringify({
      op: entries[0].op,
      job: args.job,
      jobHash: meta.jobHash,
      mode: "rollback",
      manifest: path,
      total: entries.length,
      restored,
      skipped,
      elapsedMs: Date.now() - startedAt,
    })}`,
  );
  log(`[rollback] 총 ${entries.length} 복구 ${restored} 미해당 ${skipped}`);

  // 아무것도 되돌리지 못한 롤백은 성공이 아니다 — 잘못된 manifest·이미 바뀐 값 등
  // 사람이 바로 알아야 할 상황이므로 실패로 끝낸다.
  if (entries.length > 0 && restored === 0) {
    log("[rollback] 실패 — 되돌린 행이 하나도 없다. manifest 와 현재 값이 맞는지 확인할 것");
    return 1;
  }
  if (skipped > 0) {
    log("[rollback] 경고 — 일부 행이 3중 CAS 에 걸려 되돌아가지 않았다. reconcile 로 확인할 것");
  }
  return 0;
}

async function runReconcile(args) {
  const meta = await callRoute({ job: args.job, meta: true });
  const path = resolveManifestPath(args.manifest);
  const entries = readManifest(path, manifestExpectation(args.job, meta));
  const byId = new Map(entries.map((e) => [e.id, e]));

  const sql = await openDb();
  let rows;
  try {
    rows = await sql`
      SELECT id, visibility_score, score_version
        FROM runs
       WHERE id = ANY(${sql.array([...byId.keys()], "uuid")})
    `;
  } finally {
    await sql.end();
  }

  const counts = { applied: 0, notApplied: 0, thirdParty: 0, missing: 0 };
  const found = new Set();
  for (const row of rows) {
    found.add(row.id);
    const e = byId.get(row.id);
    const score = Number(row.visibility_score);
    const version = Number(row.score_version);
    let state;
    if (score === e.after && version === e.toVersion) state = "applied";
    else if (score === e.before && version === e.fromVersion) state = "not-applied";
    else state = "third-party-change";

    if (state === "applied") counts.applied += 1;
    else if (state === "not-applied") counts.notApplied += 1;
    else {
      counts.thirdParty += 1;
      out(
        `RECONCILE ${JSON.stringify({
          op: e.op,
          job: e.job,
          id: e.id,
          state,
          expectedAfter: { score: e.after, version: e.toVersion },
          expectedBefore: { score: e.before, version: e.fromVersion },
          actual: { score, version },
        })}`,
      );
    }
  }
  for (const id of byId.keys()) {
    if (!found.has(id)) {
      counts.missing += 1;
      out(`RECONCILE ${JSON.stringify({ job: args.job, id, state: "missing" })}`);
    }
  }

  out(
    `SUMMARY ${JSON.stringify({
      op: entries[0].op,
      job: args.job,
      jobHash: meta.jobHash,
      mode: "reconcile",
      manifest: path,
      total: entries.length,
      ...counts,
    })}`,
  );
  log(
    `[reconcile] 총 ${entries.length} 적용 ${counts.applied} 미적용 ${counts.notApplied} ` +
      `제3자변경 ${counts.thirdParty} 없음 ${counts.missing}`,
  );
  return counts.thirdParty === 0 && counts.missing === 0 ? 0 : 1;
}

/* ============================================================
 * manifest 대조 (DB·HTTP 접근 없음 · 로컬 실행용)
 * ============================================================ */

/**
 * 대조 좌표 — `(kstDate, provider, promptKey, fromVersion, before, after)` 6-튜플.
 *
 * 운영 행 `id` 는 저장소 밖에서 만든 기대값에 없으므로 조인 키가 될 수 없다. 그렇다고
 * `(kstDate, provider, promptKey)` 만으로는 **유일하지 않다** — 같은 프롬프트가 하루 두 번
 * 수집돼 한 좌표에 여러 행이 모인다(실측: v11 2,790행 / 746키). 그래서 키 조인이 아니라
 * **다중집합(multiset) 비교**로 못 박는다: 6-튜플을 정렬해 줄 단위로 완전히 같은지 본다.
 */
const COMPARE_KEY = (e) =>
  [e.kstDate, e.provider, e.promptKey, e.fromVersion, e.before, e.after].join("|");

/** 정렬한 6-튜플 목록의 sha256 — 파일 한 개를 한 값으로 요약한다. */
async function digestOf(keys) {
  const { createHash } = await import("crypto");
  return createHash("sha256").update([...keys].sort().join("\n")).digest("hex");
}

/** JSONL(기대 manifest) 또는 AUDIT 줄(실행 manifest) 어느 쪽이든 6-튜플 목록으로 읽는다. */
function readCompareKeys(path) {
  const keys = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const payload = line.startsWith("AUDIT ")
      ? line.slice("AUDIT ".length)
      : line.startsWith("{")
        ? line
        : null;
    if (payload === null) continue; // SUMMARY·ANOMALY 등 다른 줄은 대조 대상이 아니다
    let entry;
    try {
      entry = JSON.parse(payload);
    } catch (err) {
      throw new Error(
        `${path} ${i + 1}행 JSON 파싱 실패: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
    if (entry.kstDate === undefined || entry.promptKey === undefined) continue;
    keys.push(COMPARE_KEY(entry));
  }
  if (keys.length === 0) throw new Error(`대조할 줄이 없다: ${path}`);
  return keys;
}

/** 다중집합 차집합 — 같은 값이 여러 번 있으면 개수까지 본다. */
function multisetDiff(a, b) {
  const counts = new Map();
  for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
  const onlyInB = [];
  for (const k of b) {
    const n = counts.get(k) ?? 0;
    if (n === 0) onlyInB.push(k);
    else counts.set(k, n - 1);
  }
  const onlyInA = [];
  for (const [k, n] of counts) for (let i = 0; i < n; i += 1) onlyInA.push(k);
  return { onlyInA, onlyInB };
}

/**
 * 실행 manifest ↔ 기대 manifest 다중집합 대조.
 *
 * 로컬에서 돌린다(DB·HTTP 불필요). 기대 manifest 는 저장소 밖에 있고 실 응답 텍스트가
 * 아니라 좌표·점수만 담는다. 차이 표본은 기본적으로 출력하지 않는다 — 공개 실행 로그에
 * 값이 실리지 않게 하기 위해서이며, 필요하면 로컬에서 `--show-sample` 로 본다.
 */
async function runVerifyManifest(args) {
  const actualKeys = readCompareKeys(args.manifest);
  const expectedKeys = readCompareKeys(args.expected);
  const { onlyInA: expectedOnly, onlyInB: actualOnly } = multisetDiff(expectedKeys, actualKeys);
  const intersection = expectedKeys.length - expectedOnly.length;
  const exactMatch = expectedOnly.length === 0 && actualOnly.length === 0;

  out(
    `VERIFY ${JSON.stringify({
      job: args.job,
      mode: "verify-manifest",
      expectedLines: expectedKeys.length,
      actualLines: actualKeys.length,
      intersection,
      expectedOnly: expectedOnly.length,
      actualOnly: actualOnly.length,
      exactMatch,
      expectedSha256: await digestOf(expectedKeys),
      actualSha256: await digestOf(actualKeys),
      ...(args.showSample
        ? {
            expectedOnlySample: expectedOnly.slice(0, 5),
            actualOnlySample: actualOnly.slice(0, 5),
          }
        : {}),
    })}`,
  );
  log(
    `[verify-manifest] job=${args.job} 기대=${expectedKeys.length} 실행=${actualKeys.length} ` +
      `교집합=${intersection} 기대만=${expectedOnly.length} 실행만=${actualOnly.length}`,
  );

  // 기대에만 있는 줄이 있으면 게이트 불통과다(우리가 예상한 변경이 안 나왔다는 뜻).
  // 실행에만 있는 줄은 기대값 snapshot 이후 생성된 행일 수 있으므로 목록으로 남기고
  // 사람이 표본 손검산으로 판단한다.
  if (expectedOnly.length > 0) {
    log("[verify-manifest] 중단 — 기대 manifest 에만 있는 줄이 있다(상세는 결과 파일)");
    return 1;
  }
  if (actualOnly.length > 0) {
    log("[verify-manifest] 주의 — 실행 manifest 에만 있는 줄이 있다. 표본 손검산 필요");
  }
  return 0;
}

/* ============================================================
 * 진입점
 * ============================================================ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help || args.mode === null) {
      usage();
      return args.help ? 0 : 1;
    }
    validate(args);
  } catch (err) {
    log(`[error] ${err instanceof Error ? err.message : "unknown"}`);
    usage();
    return 1;
  }

  switch (args.mode) {
    case "report":
      return runReport(args);
    case "preflight":
      return runPreflight(args);
    case "sweep":
      return runSweep(args);
    case "rollback":
      return runRollback(args);
    case "reconcile":
      return runReconcile(args);
    case "verify-manifest":
      return runVerifyManifest(args);
    default:
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`[error] ${err instanceof Error ? err.message : "unknown"}`);
    process.exit(1);
  });
