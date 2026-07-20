/**
 * 인용된 URL 조회 (읽기 전용, 재사용 도구) — 특정 경로 패턴으로 인용 출처를 필터해 목록 출력.
 *
 * 사용(운영 앱 컨테이너):
 *   URL_FILTER='%magicbodypilates.co.kr/blog/%' node scripts/query-cited-urls.mjs
 *
 * 환경변수:
 *   POSTGRES_URL — 앱 컨테이너 주입
 *   URL_FILTER   — SQL ILIKE 패턴 (기본: 매직바디 블로그 상세 '%magicbodypilates.co.kr/blog/%')
 *   TOP          — 출력 상한(기본 300)
 *
 * 집계 기준: 같은 응답(run) 안에서 같은 URL 은 1회로 계산(앱의 "내 사이트 인용" 수치와 동일 기준).
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) { console.error("[query] POSTGRES_URL 없음"); process.exit(1); }
const filter = process.env.URL_FILTER || "%magicbodypilates.co.kr/blog/%";
const top = Math.min(Number(process.env.TOP) || 300, 1000);

const client = postgres(url, { max: 1 });

try {
  const wss = await client`SELECT id, brand_config FROM workspaces`;
  for (const ws of wss) {
    const sites = Array.isArray(ws.brand_config?.websites) ? ws.brand_config.websites : [];
    if (!sites.some((s) => String(s).toLowerCase().includes("magicbodypilates.co.kr"))) continue;

    console.log(`[query] 필터: ${filter}`);

    // run 단위 dedup 후 URL별 집계
    const rows = await client`
      WITH hits AS (
        SELECT DISTINCT r.id AS run_id, c->>'url' AS url, r.prompt_text, r.provider, r.created_at
        FROM runs r
        CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
        WHERE r.workspace_id = ${ws.id}
          AND jsonb_typeof(r.citations) = 'array'
          AND c->>'url' ILIKE ${filter}
      )
      SELECT url,
             count(DISTINCT run_id)::int      AS cite_runs,
             count(DISTINCT prompt_text)::int AS prompts,
             count(DISTINCT provider)::int    AS providers,
             min(created_at)                  AS first_seen,
             max(created_at)                  AS last_seen
      FROM hits
      GROUP BY url
      ORDER BY cite_runs DESC, url
      LIMIT ${top}
    `;

    console.log(`[query] 매칭 URL ${rows.length}개\n`);
    console.log("순위\t인용(응답수)\t질문수\tAI수\t최근인용\tURL");
    rows.forEach((r, i) => {
      const last = r.last_seen?.toISOString?.().slice(0, 10) ?? "";
      console.log(`${i + 1}\t${r.cite_runs}\t${r.prompts}\t${r.providers}\t${last}\t${r.url}`);
    });

    const totalRuns = rows.reduce((a, b) => a + b.cite_runs, 0);
    console.log(`\n[query] 합계 — 고유 URL ${rows.length}개 · 인용(응답 기준) ${totalRuns}건`);
  }
  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[query] 실패:", err);
  await client.end();
  process.exit(1);
}
