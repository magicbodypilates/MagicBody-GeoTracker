/**
 * 실데이터 스모크 점검 — "인용 출처 URL 드릴다운" 신규 조회가 운영 DB에서 실제로 도는지 확인.
 *
 * 목적:
 *   1) B-1 회귀 확인: `SET LOCAL statement_timeout = <정수 리터럴>` 이 실제 PostgreSQL 에서
 *      오류 없이 실행되는지(과거 `$1` bind 로 렌더돼 100% 실패하던 결함의 실DB 검증).
 *   2) jsonb_array_elements 펼침 조회가 실제 인용 데이터를 반환하는지.
 *   3) 내 사이트(브랜드 공식 도메인) URL 이 실제로 집계되는지 + URL 별 질문(프롬프트) 매핑 샘플.
 *
 * 이 스크립트는 신규 route 와 동일한 핵심 SQL 을 재현한다(라우트 자체는 관리자 인증이 필요해
 * 외부 HTTP 로는 실데이터 검증이 불가하므로, 앱 컨테이너 안에서 DB 직결로 확인).
 *
 * 사용 (운영 앱 컨테이너 안):
 *   node scripts/smoke-citation-urls.mjs
 *
 * 환경변수: POSTGRES_URL (앱 컨테이너에 주입됨). 읽기 전용 — 데이터 변경 없음.
 */

import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("[smoke] POSTGRES_URL 없음");
  process.exit(1);
}

const STATEMENT_TIMEOUT_MS = 15000; // 신규 route 와 동일한 정수 리터럴 인라인(B-1 검증 대상)
const ROW_CAP = 50000;
const LOOKBACK_DAYS = 3650; // 사실상 전체 기간(all-time)

const client = postgres(url, { max: 1 });

function brandHostOf(u) {
  try {
    const withScheme = u.startsWith("http") ? u : `https://${u}`;
    return new URL(withScheme).hostname.replace(/^www\./, "").replace(/^m\./, "").toLowerCase();
  } catch {
    return null;
  }
}

try {
  console.log(`[smoke] DB: ${(() => { try { return new URL(url.replace(/:[^@:/]+@/, ":***@")).host; } catch { return "?"; } })()}`);

  const workspaces = await client`SELECT id, brand_config FROM workspaces`;
  console.log(`[smoke] workspace 수: ${workspaces.length}`);

  let setLocalOk = false;

  for (const ws of workspaces) {
    const websites = Array.isArray(ws.brand_config?.websites) ? ws.brand_config.websites : [];
    const brandHosts = new Set(websites.map(brandHostOf).filter(Boolean));

    // 신규 route 와 동일: 트랜잭션 안에서 SET LOCAL(정수 리터럴) → 펼침 조회
    const rows = await client.begin(async (sql) => {
      await sql.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      setLocalOk = true; // 위 문장이 오류 없이 지나면 B-1 해소 확인
      return sql`
        SELECT r.prompt_text AS prompt_text,
               r.provider    AS provider,
               c->>'url'     AS url,
               c->>'domain'  AS domain
        FROM runs r
        CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
        WHERE r.workspace_id = ${ws.id}
          AND r.created_at >= now() - (${LOOKBACK_DAYS} || ' days')::interval
          AND (r.parse_quality <> 'low' OR r.parse_quality IS NULL)
          AND r.is_auto = true
          AND jsonb_typeof(r.citations) = 'array'
        LIMIT ${ROW_CAP}
      `;
    });

    // 브랜드 URL 집계 (full URL 단위) + URL별 프롬프트 집합
    const byUrl = new Map(); // url -> { count, prompts:Set }
    for (const row of rows) {
      const host = brandHostOf(row.url || row.domain || "");
      if (!host) continue;
      const isBrand = [...brandHosts].some((bh) => host === bh || host.endsWith(`.${bh}`));
      if (!isBrand) continue;
      const key = row.url || "";
      if (!key) continue;
      if (!byUrl.has(key)) byUrl.set(key, { count: 0, prompts: new Set() });
      const e = byUrl.get(key);
      e.count += 1;
      if (row.prompt_text) e.prompts.add(row.prompt_text);
    }

    console.log(`\n[smoke] === workspace ${ws.id} ===`);
    console.log(`[smoke] 브랜드 공식 도메인: ${[...brandHosts].join(", ") || "(설정 없음)"}`);
    console.log(`[smoke] 펼친 인용 행 수: ${rows.length}${rows.length >= ROW_CAP ? " (cap 도달)" : ""}`);
    console.log(`[smoke] 내 사이트 인용 URL(고유): ${byUrl.size}`);

    const top = [...byUrl.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8);
    for (const [u, e] of top) {
      console.log(`   - ${u}  (인용 ${e.count}회 · 질문 ${e.prompts.size}종)`);
      const sampleQ = [...e.prompts].slice(0, 2);
      for (const q of sampleQ) console.log(`        · 질문 예: ${q.slice(0, 50)}`);
    }
  }

  console.log(`\n[smoke] SET LOCAL statement_timeout 실행: ${setLocalOk ? "정상(오류 없음) — B-1 해소 확인" : "미실행"}`);
  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[smoke] 실패:", err);
  await client.end();
  process.exit(1);
}
