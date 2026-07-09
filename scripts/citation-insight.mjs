/**
 * 진단(읽기 전용) — 두 기능 설계용 규모 조회.
 *  1) 브랜드 언급 외부 출처: 인용 출처의 제목/설명에 "매직바디/magicbody"가 들어간 것(제3자 도메인).
 *  2) 유튜브: 브랜드 유튜브 등록 형태 + 영상(watch/youtu.be) 주소 인용이 잡히는지.
 *
 * 사용 (운영 앱 컨테이너): node scripts/citation-insight.mjs
 * 환경변수: POSTGRES_URL (읽기 전용, 데이터 변경 없음)
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) { console.error("[insight] POSTGRES_URL 없음"); process.exit(1); }
const client = postgres(url, { max: 1 });

const OWNED_PRIMARY = "magicbodypilates.co.kr"; // 대표 소유 도메인(외부 판정용)

try {
  const wss = await client`SELECT id, brand_config FROM workspaces`;
  for (const ws of wss) {
    const sites = Array.isArray(ws.brand_config?.websites) ? ws.brand_config.websites : [];
    if (!sites.some((s) => String(s).toLowerCase().includes(OWNED_PRIMARY))) continue;
    console.log(`\n[insight] === workspace ${ws.id} ===`);
    console.log(`[insight] 등록된 브랜드 공식 URL (${sites.length}개):`);
    for (const s of sites) console.log(`     · ${s}`);

    // 1) 브랜드 언급 외부 출처 (제목/설명에 매직바디/ magicbody, 소유 도메인 제외)
    const mention = await client`
      SELECT count(*)::int AS occ,
             count(distinct (c->>'url'))::int AS urls,
             count(distinct (c->>'domain'))::int AS domains
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'title' ILIKE '%매직바디%' OR c->>'description' ILIKE '%매직바디%'
             OR c->>'title' ILIKE '%magicbody%' OR c->>'description' ILIKE '%magicbody%')
        AND coalesce(c->>'domain','') NOT ILIKE ${"%" + OWNED_PRIMARY + "%"}
        AND coalesce(c->>'url','')    NOT ILIKE ${"%" + OWNED_PRIMARY + "%"}
    `;
    console.log(`[insight] (1) 브랜드 언급 외부 출처 — 인용 ${mention[0].occ}건 · 고유 URL ${mention[0].urls}개 · 도메인 ${mention[0].domains}개`);

    const topDomains = await client`
      SELECT c->>'domain' AS domain, count(*)::int AS cnt
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'title' ILIKE '%매직바디%' OR c->>'description' ILIKE '%매직바디%'
             OR c->>'title' ILIKE '%magicbody%' OR c->>'description' ILIKE '%magicbody%')
        AND coalesce(c->>'domain','') NOT ILIKE ${"%" + OWNED_PRIMARY + "%"}
      GROUP BY 1 ORDER BY cnt DESC LIMIT 8
    `;
    console.log(`[insight]     상위 도메인:`);
    for (const d of topDomains) console.log(`        - ${d.domain || "(없음)"}: ${d.cnt}`);

    // 2) 유튜브 영상(watch/youtu.be) 인용
    const ytVideo = await client`
      SELECT count(*)::int AS occ, count(distinct (c->>'url'))::int AS urls
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'url' ILIKE '%youtube.com/watch%' OR c->>'url' ILIKE '%youtu.be/%')
    `;
    const ytVideoBrand = await client`
      SELECT count(*)::int AS occ, count(distinct (c->>'url'))::int AS urls
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'url' ILIKE '%youtube.com/watch%' OR c->>'url' ILIKE '%youtu.be/%')
        AND (c->>'title' ILIKE '%매직바디%' OR c->>'description' ILIKE '%매직바디%'
             OR c->>'title' ILIKE '%magicbody%' OR c->>'description' ILIKE '%magicbody%')
    `;
    const ytHandle = await client`
      SELECT count(*)::int AS occ, count(distinct (c->>'url'))::int AS urls
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'url' ILIKE '%youtube.com/@%' OR c->>'url' ILIKE '%youtube.com/channel/%'
             OR c->>'url' ILIKE '%youtube.com/c/%')
    `;
    console.log(`[insight] (2) 유튜브 영상(watch/youtu.be) 인용 — 인용 ${ytVideo[0].occ}건 · 고유 URL ${ytVideo[0].urls}개`);
    console.log(`[insight]     그중 제목/설명에 매직바디 언급 — 인용 ${ytVideoBrand[0].occ}건 · 고유 URL ${ytVideoBrand[0].urls}개`);
    console.log(`[insight]     유튜브 채널/핸들 주소 인용 — 인용 ${ytHandle[0].occ}건 · 고유 URL ${ytHandle[0].urls}개`);

    // 샘플 영상 URL 몇 개 (형태 확인)
    const ytSample = await client`
      SELECT distinct c->>'url' AS url, left(coalesce(c->>'title',''), 40) AS title
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'url' ILIKE '%youtube.com/watch%' OR c->>'url' ILIKE '%youtu.be/%')
      LIMIT 5
    `;
    console.log(`[insight]     영상 URL 샘플:`);
    for (const s of ytSample) console.log(`        - ${s.url}  | ${s.title}`);
  }
  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[insight] 실패:", err);
  await client.end();
  process.exit(1);
}
