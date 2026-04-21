/**
 * Phase 5B — Worker 프로세스
 *
 * 역할:
 *   - 1분마다 /api/internal/cron/tick 호출
 *   - Next.js 앱 내부에서 실제 스케줄 실행 로직이 돎
 *
 * 환경변수:
 *   CRON_TARGET_URL       — 앱 컨테이너 URL (예: http://mbd-geo-tracker:3000)
 *   INTERNAL_CRON_SECRET  — 앱과 공유하는 비밀키 (.env 에서 주입)
 *   CRON_INTERVAL_MS      — (선택) tick 간격 밀리초. 기본 60000
 *
 * 특징:
 *   - fire-and-forget: 이전 tick 이 끝나기 전 다음 tick 이 와도 중첩 실행 허용 (tick 내부에서 DB 잠금 없음. 현재는 단순화)
 *   - 네트워크 오류는 로그만 남기고 다음 tick 에서 자연스럽게 재시도
 *   - SIGTERM 수신 시 깨끗한 종료
 */

const BASE_PATH = "/geo-tracker";
const TARGET = process.env.CRON_TARGET_URL || "http://mbd-geo-tracker:3000";
const SECRET = process.env.INTERNAL_CRON_SECRET;
const INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS || 60_000);

if (!SECRET) {
  console.error("[worker] INTERNAL_CRON_SECRET 환경변수 필수");
  process.exit(1);
}

function log(...args) {
  console.log(`[worker ${new Date().toISOString()}]`, ...args);
}

let inFlight = false;
let tickCount = 0;

async function tick() {
  if (inFlight) {
    log("이전 tick 아직 진행 중 — 이번 tick 스킵");
    return;
  }
  inFlight = true;
  tickCount += 1;
  const startedAt = Date.now();
  try {
    const url = `${TARGET}${BASE_PATH}/api/internal/cron/tick`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": SECRET,
      },
      body: JSON.stringify({ trigger: "worker-cron" }),
    });
    const elapsed = Date.now() - startedAt;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(`tick #${tickCount} HTTP ${res.status} (${elapsed}ms):`, text.slice(0, 200));
      return;
    }

    const data = await res.json();
    if (data.result) {
      const r = data.result;
      if (r.checkedSchedules > 0 || r.executedRuns > 0 || r.errors.length > 0) {
        log(
          `tick #${tickCount} (${elapsed}ms) — 스케줄 ${r.checkedSchedules}개 확인, 실행 ${r.executedRuns}, 스킵 ${r.skippedDuplicates}, 오류 ${r.errors.length}`,
        );
        if (r.errors.length > 0) {
          for (const e of r.errors) log(`  오류: ${e.scheduleId} — ${e.message}`);
        }
      }
    }
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    log(`tick #${tickCount} 네트워크 오류 (${elapsed}ms):`, err?.message ?? err);
  } finally {
    inFlight = false;
  }
}

log(`기동 완료 — target=${TARGET}${BASE_PATH}/api/internal/cron/tick interval=${INTERVAL_MS}ms`);

// 첫 tick 은 기동 후 10초 뒤 (앱 기동 대기)
setTimeout(() => {
  tick();
  setInterval(tick, INTERVAL_MS);
}, 10_000);

process.on("SIGTERM", () => {
  log("SIGTERM 수신 — 종료");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SIGINT 수신 — 종료");
  process.exit(0);
});
