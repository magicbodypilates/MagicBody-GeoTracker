/**
 * POST /api/internal/cron/tick
 *
 * Worker 컨테이너가 1분마다 호출. 공유 시크릿으로 인증.
 *
 * 요청: POST, 헤더 X-Cron-Secret 필수
 * 응답: { ok, mode: "background", engine, skipped, elapsedSeconds }
 *
 * 엔진은 GEO_COLLECTOR_ENGINE 으로 고른다 (lib/server/collector-config.ts · 계획 geotracker-collect-speed-260924).
 *
 *   legacy (기본값 — 지금 코드 그대로, 되돌리기용)
 *     runTick() 이 때가 된 스케줄의 질문 × AI 를 메모리 반복문으로 끝까지 처리한다. 한 번에 수 시간
 *     걸릴 수 있어 즉시 200 을 돌려주고 서버 프로세스에서 백그라운드로 돌린다(워커의 fetch 는 5분에
 *     끊긴다). 전역 플래그로 runTick 중첩을 막는다 — 돌고 있으면 그 틱은 건너뛴다.
 *
 *   queue (새 엔진 — collector-engine.ts)
 *     수집 대기열이 DB 에 있고, 틱마다 짧은 두 줄기를 각자의 플래그로 겹치지 않게 시작한다.
 *       거두기 runHarvestPass : 하루 집계(날짜 바뀐 뒤 1회) → 진행 확인 → 내려받기·저장 → 회차 마감 (보통 몇 초～1분)
 *       보내기 runDispatchPass: 재시작 감지 → 끊긴 "보내는 중" 복구 → 회차 만들기 → 멈춘 회차 정리 → 제출 (최대 약 1분 30초)
 *     한 줄기가 1분을 넘기면 다음 틱에서 그 줄기만 한 번 건너뛸 뿐 손실은 없다(상태가 DB 에 있다).
 *     제출은 이 프로세스의 보내기 줄기 하나만 한다 — 앱 컨테이너는 1개(mbd-geo-tracker)다.
 *     컨테이너를 늘리게 되면 보내기 줄기 앞에 DB 잠금(pg_try_advisory_lock) 한 줄을 더해야 한다.
 *
 * 엔진 선택을 여기서 하는 이유 — automation-runner ↔ collector-engine 순환 import 를 피하고, legacy
 * 모드에서는 새 엔진 모듈을 아예 불러오지 않기 위해서다(동적 import).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runTick, type ProviderFailure } from "@/lib/server/automation-runner";
import { getCollectorEngine, PASS_STUCK_WARN_MS } from "@/lib/server/collector-config";

export const dynamic = "force-dynamic";

/** Timing-safe 문자열 비교 — 길이 다른 입력은 false, 같으면 바이트 단위 상수시간 비교 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------
 * legacy — 지금 동작 그대로
 * ------------------------------------------------------------------ */

/**
 * 동일 Node.js 프로세스 내에서 runTick 중첩 실행 방지.
 * Next.js 앱은 단일 컨테이너(mbd-geo-tracker)에서만 돌므로 module 전역 변수로 충분.
 * 멀티 인스턴스로 확장될 경우 DB advisory lock 또는 schedules 테이블에 executing
 * 플래그를 추가해야 함.
 */
const runState: { running: boolean; startedAt: number | null } = {
  running: false,
  startedAt: null,
};

function runInBackground(): void {
  if (runState.running) {
    const elapsedMs = runState.startedAt ? Date.now() - runState.startedAt : 0;
    console.log(
      `[cron/tick] 이전 tick 이 아직 실행 중 (${Math.round(elapsedMs / 1000)}s 경과) — 이번 요청은 스킵`,
    );
    return;
  }
  runState.running = true;
  runState.startedAt = Date.now();
  // Node.js 런타임은 response 반환 후에도 이 Promise 체인을 계속 수행한다.
  void runTick()
    .then((result) => {
      const elapsedMs = runState.startedAt ? Date.now() - runState.startedAt : 0;
      const failureCount = result.providerFailures.length;
      if (
        result.checkedSchedules > 0 ||
        result.executedRuns > 0 ||
        result.errors.length > 0 ||
        failureCount > 0
      ) {
        const failSummary =
          failureCount > 0
            ? ` · provider실패 ${failureCount}(${Object.entries(result.providerFailureCounts)
                .map(([p, n]) => `${p}:${n}`)
                .join(", ")})`
            : "";
        console.log(
          `[cron/tick] 완료 (${Math.round(elapsedMs / 1000)}s) — 스케줄 ${result.checkedSchedules}개 확인, 실행 ${result.executedRuns}, 스킵 ${result.skippedDuplicates}, 오류 ${result.errors.length}${failSummary}`,
        );
        if (result.errors.length > 0) {
          for (const e of result.errors) {
            console.error(`[cron/tick]   오류 scheduleId=${e.scheduleId} — ${e.message}`);
          }
        }
        // provider 단위 실패 상세 — 특정 provider(예: chatgpt)만 비는 패턴 추적용(관측성)
        if (failureCount > 0) {
          for (const f of result.providerFailures) {
            console.error(
              `[cron/tick]   provider실패 provider=${f.provider} prompt="${f.prompt.slice(0, 40)}..." — ${f.reason}`,
            );
          }
        }
      }
    })
    .catch((err) => {
      console.error(
        "[cron/tick] runTick 실패:",
        err instanceof Error ? err.stack ?? err.message : err,
      );
    })
    .finally(() => {
      runState.running = false;
      runState.startedAt = null;
    });
}

/* ------------------------------------------------------------------
 * queue — 보내기·거두기 두 줄기
 * ------------------------------------------------------------------ */

type PassName = "harvest" | "dispatch";

/** 줄기마다 따로 둔 중첩 방지 플래그 — 한 줄기가 길어져도 다른 줄기는 돈다. */
const passState: Record<PassName, { running: boolean; startedAt: number | null; warnedAt: number | null }> = {
  harvest: { running: false, startedAt: null, warnedAt: null },
  dispatch: { running: false, startedAt: null, warnedAt: null },
};

type PassLogInput = {
  stats: Record<string, unknown>;
  providerFailures: ProviderFailure[];
  errors: { scheduleId: string; message: string }[];
};

function hasActivity(res: PassLogInput): boolean {
  if (res.errors.length > 0 || res.providerFailures.length > 0) return true;
  return Object.entries(res.stats).some(
    ([k, v]) => k !== "durationMs" && ((typeof v === "number" && v > 0) || (v !== null && typeof v === "object")),
  );
}

function num(stats: Record<string, unknown>, key: string): number {
  const v = stats[key];
  return typeof v === "number" ? v : 0;
}

/** 통계가 0 이 아닐 때만 줄기마다 1줄 + 실패 상세(지금 형식 — 운영 집계 명령이 그대로 먹는다). */
function logPass(name: PassName, res: PassLogInput): void {
  if (!hasActivity(res)) return;
  const s = res.stats;
  const secs = Math.round(num(s, "durationMs") / 1000);
  let line: string;
  if (name === "dispatch") {
    line =
      `[collector:dispatch] ${secs}s — 복구 ${num(s, "recovered")} · 새 회차 ${num(s, "roundsCreated")}(겹침 ${num(s, "roundsSkippedOverlap")})` +
      ` · 제출 ${num(s, "submitted")} · 바로저장 ${num(s, "savedInline")} · 중복 ${num(s, "duplicates")}` +
      ` · 재대기 ${num(s, "requeued")} · 실패 ${num(s, "failed")}` +
      (num(s, "retried") > 0 ? ` · 재시도 ${num(s, "retried")}` : "") +
      (num(s, "cancelled") > 0 ? ` · 취소 ${num(s, "cancelled")}` : "");
  } else {
    const rollup = s.dailyRollup as { date: string; rows: number } | null;
    line =
      `[collector:harvest] ${secs}s — 확인 ${num(s, "polled")} · 저장 ${num(s, "saved")} · 중복 ${num(s, "duplicates")}` +
      ` · 재시도 ${num(s, "retried")} · 실패 ${num(s, "failed")} · 시간초과 ${num(s, "timeouts")} · 마감 ${num(s, "roundsCompleted")}` +
      (rollup ? ` · 하루집계 ${rollup.date}(${rollup.rows}행)` : "");
  }
  console.log(line);
  for (const e of res.errors) {
    console.error(`[cron/tick]   오류 scheduleId=${e.scheduleId} — ${e.message}`);
  }
  for (const f of res.providerFailures) {
    console.error(
      `[cron/tick]   provider실패 provider=${f.provider} prompt="${f.prompt.slice(0, 40)}..." — ${f.reason}`,
    );
  }
}

/** 그 줄기 플래그가 켜져 있으면 건너뛰고(오래 켜져 있으면 경고 1줄), 아니면 켜고 백그라운드로 돌린다. */
function startPass(name: PassName): { started: boolean; elapsedMs: number | null } {
  const st = passState[name];
  const nowMs = Date.now();
  if (st.running) {
    const elapsedMs = st.startedAt ? nowMs - st.startedAt : 0;
    if (elapsedMs > PASS_STUCK_WARN_MS && (st.warnedAt === null || nowMs - st.warnedAt > PASS_STUCK_WARN_MS)) {
      st.warnedAt = nowMs;
      console.warn(
        `[collector:${name}] 이전 줄기가 ${Math.round(elapsedMs / 1000)}s 째 끝나지 않았다 — 이번 틱은 건너뜀`,
      );
    }
    return { started: false, elapsedMs };
  }
  st.running = true;
  st.startedAt = nowMs;
  st.warnedAt = null;
  void (async () => {
    try {
      const engine = await import("@/lib/server/collector-engine");
      const res = name === "harvest" ? await engine.runHarvestPass() : await engine.runDispatchPass();
      logPass(name, res);
    } catch (err) {
      console.error(`[collector:${name}] 줄기 실패:`, err instanceof Error ? err.stack ?? err.message : err);
    } finally {
      st.running = false;
      st.startedAt = null;
    }
  })();
  return { started: true, elapsedMs: null };
}

export async function POST(req: NextRequest) {
  const providedSecret = req.headers.get("x-cron-secret") ?? "";
  const expectedSecret = process.env.INTERNAL_CRON_SECRET;

  if (!expectedSecret) {
    return NextResponse.json(
      { error: "cron_not_configured", hint: "INTERNAL_CRON_SECRET 환경변수 필요" },
      { status: 500 },
    );
  }
  if (!safeEqual(providedSecret, expectedSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const engine = getCollectorEngine();

  if (engine === "queue") {
    const harvest = startPass("harvest");
    const dispatch = startPass("dispatch");
    const skipped = !harvest.started && !dispatch.started;
    const elapsed = Math.max(harvest.elapsedMs ?? 0, dispatch.elapsedMs ?? 0);
    return NextResponse.json({
      ok: true,
      mode: "background",
      engine,
      skipped,
      elapsedSeconds: skipped ? Math.round(elapsed / 1000) : null,
      passes: {
        harvest: harvest.started ? "started" : "skipped",
        dispatch: dispatch.started ? "started" : "skipped",
      },
    });
  }

  const wasRunning = runState.running;
  runInBackground();

  return NextResponse.json({
    ok: true,
    mode: "background",
    engine,
    skipped: wasRunning,
    elapsedSeconds: wasRunning && runState.startedAt
      ? Math.round((Date.now() - runState.startedAt) / 1000)
      : null,
  });
}
