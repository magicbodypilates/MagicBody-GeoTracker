/**
 * POST /api/internal/cron/tick
 *
 * Worker 컨테이너가 1분마다 호출. 공유 시크릿으로 인증.
 * 실제 스케줄 실행 로직은 lib/server/automation-runner.ts 의 runTick() 에 위임.
 *
 * 요청: POST, 헤더 X-Cron-Secret 필수
 * 응답: { ok, result: TickResult }
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runTick } from "@/lib/server/automation-runner";

export const dynamic = "force-dynamic";
// 자동화 한 tick 은 여러 스크레이핑을 직렬 실행하므로 최대 15분 허용
export const maxDuration = 900;

/** Timing-safe 문자열 비교 — 길이 다른 입력은 false, 같으면 바이트 단위 상수시간 비교 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

  try {
    const result = await runTick();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/internal/cron/tick] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
