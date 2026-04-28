/**
 * /api/sentiment — 클라이언트 수동 실행 응답에 대한 sentiment + ranking 분류.
 *
 * POST { answerText, brandName, brandAliases? }
 *   → { sentiment, isTopRanked, isStronglyRecommended } | { error }
 *
 * 자동 실행은 server worker(automation-runner)가 직접 classifySentiment 호출.
 * 수동 실행은 client 가 이 endpoint 통해 동일 분류기 사용 → 점수 일관성.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { classifySentiment } from "@/lib/server/llm-sentiment";

export const dynamic = "force-dynamic";

const Schema = z.object({
  answerText: z.string().min(1),
  brandName: z.string().min(1),
  brandAliases: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = Schema.parse(body);
    const result = await classifySentiment(parsed);
    if (!result) {
      return NextResponse.json({ sentiment: null, isTopRanked: false, isStronglyRecommended: false });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}
