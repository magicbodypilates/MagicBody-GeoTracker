/**
 * GET /api/workspaces/[id]/stats/citations/brand-mentions/answers
 *
 * 「브랜드 언급 출처」 → 「이 URL 을 인용한 질문」 한 줄을 펼쳤을 때 — 그 질문에 AI 가 답한 응답 중
 * 이 제3자 페이지를 인용한 응답 목록(최신순 · 쪽 넘김). 쿼리·규칙은 lib/server/citation-url-answers-handler.ts 머리말.
 */

import type { NextRequest } from "next/server";
import { handleCitationUrlAnswers } from "@/lib/server/citation-url-answers-handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleCitationUrlAnswers(req, ctx, "mention");
}
