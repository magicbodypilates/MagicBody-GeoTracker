/**
 * POST /api/internal/cron/tick
 *
 * Worker 컨테이너가 1분마다 호출. 공유 시크릿으로 인증.
 * 실제 스케줄 실행 로직은 lib/server/automation-runner.ts 의 runTick() 에 위임.
 *
 * 요청: POST, 헤더 X-Cron-Secret 필수
 * 응답: { ok, mode: "background", message }
 *
 * 처리 모델 (fire-and-forget):
 *   - runTick() 은 13개 프롬프트 × 4개 provider = 52건을 직렬로 Bright Data 에
 *     호출해 완료까지 10~20분까지 걸림.
 *   - 워커의 fetch 는 undici 기본 headersTimeout = 300000ms(5분)에 끊어져
 *     tick 이 중첩되고 새 tick 이 `where next_run_at <= now` 로 또 동일 스케줄을
 *     잡아와 중복 처리가 벌어짐.
 *   - 이 라우트는 즉시 200 을 반환하고 runTick 은 서버 process 에서 백그라운드로
 *     계속 실행. 동시에 글로벌 플래그로 runTick 중첩을 차단해 한 번에 단 한
 *     인스턴스만 돌게 만든다.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runTick } from "@/lib/server/automation-runner";

export const dynamic = "force-dynamic";

/** Timing-safe 문자열 비교 — 길이 다른 입력은 false, 같으면 바이트 단위 상수시간 비교 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

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
      if (
        result.checkedSchedules > 0 ||
        result.executedRuns > 0 ||
        result.errors.length > 0
      ) {
        console.log(
          `[cron/tick] 완료 (${Math.round(elapsedMs / 1000)}s) — 스케줄 ${result.checkedSchedules}개 확인, 실행 ${result.executedRuns}, 스킵 ${result.skippedDuplicates}, 오류 ${result.errors.length}`,
        );
        if (result.errors.length > 0) {
          for (const e of result.errors) {
            console.error(`[cron/tick]   오류 scheduleId=${e.scheduleId} — ${e.message}`);
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

  const wasRunning = runState.running;
  runInBackground();

  return NextResponse.json({
    ok: true,
    mode: "background",
    skipped: wasRunning,
    elapsedSeconds: wasRunning && runState.startedAt
      ? Math.round((Date.now() - runState.startedAt) / 1000)
      : null,
  });
}
