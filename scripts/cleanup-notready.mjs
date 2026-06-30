/**
 * 일회성 데이터 정리 — Bright Data "not ready" placeholder 가 답변으로 잘못 저장된 runs 삭제.
 *
 * 배경:
 *   외부 수집 서비스 Bright Data 가 dataset 미준비 상태에서 돌려준 안내 문구
 *   ("Dataset is not ready yet, try again in 30s") 가 normalizeAnswer 의 deep-extract 로
 *   답변(answer)에 들어가 정상 run 처럼 저장된 사례를 정리한다.
 *   (근본 원인 코드는 brightdata-scraper.ts 에서 수정됨 — 본 스크립트는 기저장 데이터 정리용.)
 *
 * 사용 (운영 앱 컨테이너 안):
 *   node scripts/cleanup-notready.mjs            # dry-run: 건수·샘플만 출력, 삭제 X
 *   CLEANUP_CONFIRM=yes node scripts/cleanup-notready.mjs   # 실제 삭제
 *
 * 환경변수:
 *   POSTGRES_URL  — 예: postgres://geotracker:pass@host:5432/geotracker (앱 컨테이너에 주입됨)
 *   CLEANUP_CONFIRM — "yes" 일 때만 DELETE 실행. 그 외엔 dry-run.
 *
 * 안전장치:
 *   - WHERE 조건이 정확한 placeholder 문구를 포함하는 행으로만 한정 (정상 답변 오삭제 방지).
 *   - dry-run 기본값. 삭제 전 매칭 건수·provider·기간·샘플을 먼저 출력.
 */

import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("[cleanup] POSTGRES_URL 환경변수가 없음");
  process.exit(1);
}

const confirm = process.env.CLEANUP_CONFIRM === "yes";

// 정확한 placeholder 문구만 타겟 — Bright Data 가 dataset 미준비 시 돌려주는 안내.
// 저장 시 trim 되므로 핵심 부분 문자열로 매칭한다. 정상 AI 답변이 이 문구를 그대로
// 담을 개연성은 사실상 없다(수집 안내 문구 고유).
const MATCH = "%not ready yet, try again%";

const client = postgres(url, { max: 1 });

try {
  const host = (() => {
    try {
      return new URL(url.replace(/:[^@:/]+@/, ":***@")).host;
    } catch {
      return "(파싱 불가)";
    }
  })();
  console.log(`[cleanup] DB host: ${host}`);
  console.log(`[cleanup] 매칭 조건: answer ILIKE '${MATCH}'`);
  console.log(`[cleanup] 모드: ${confirm ? "DELETE (실제 삭제)" : "DRY-RUN (삭제 안 함)"}`);

  // 1) 매칭 건수 + provider 분포 + 기간
  const summary = await client`
    SELECT
      count(*)::int                       AS total,
      min(created_at)                      AS oldest,
      max(created_at)                      AS newest
    FROM runs
    WHERE answer ILIKE ${MATCH}
  `;
  const total = summary[0]?.total ?? 0;
  console.log(`[cleanup] 매칭 총 건수: ${total}`);
  if (total === 0) {
    console.log("[cleanup] 삭제 대상 없음 — 종료.");
    await client.end();
    process.exit(0);
  }
  console.log(`[cleanup] 기간: ${summary[0].oldest?.toISOString?.() ?? summary[0].oldest} ~ ${summary[0].newest?.toISOString?.() ?? summary[0].newest}`);

  const byProvider = await client`
    SELECT provider, count(*)::int AS cnt
    FROM runs
    WHERE answer ILIKE ${MATCH}
    GROUP BY provider
    ORDER BY cnt DESC
  `;
  console.log("[cleanup] provider 분포:");
  for (const r of byProvider) console.log(`   - ${r.provider}: ${r.cnt}`);

  // 샘플 5건 (답변 앞부분)
  const sample = await client`
    SELECT provider, left(answer, 60) AS preview, created_at
    FROM runs
    WHERE answer ILIKE ${MATCH}
    ORDER BY created_at DESC
    LIMIT 5
  `;
  console.log("[cleanup] 샘플(최근 5건):");
  for (const r of sample) {
    console.log(`   - [${r.provider}] "${r.preview}" @ ${r.created_at?.toISOString?.() ?? r.created_at}`);
  }

  if (!confirm) {
    console.log("[cleanup] DRY-RUN 종료 — 실제 삭제하려면 CLEANUP_CONFIRM=yes 로 재실행.");
    await client.end();
    process.exit(0);
  }

  // 2) 실제 삭제
  const deleted = await client`
    DELETE FROM runs
    WHERE answer ILIKE ${MATCH}
    RETURNING id
  `;
  console.log(`[cleanup] 삭제 완료: ${deleted.length} 건`);

  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[cleanup] 실패:", err);
  await client.end();
  process.exit(1);
}
