/**
 * 브랜드 공식 URL(웹사이트/채널) 추가 — 워크스페이스 brand_config.websites 에 한 건 append.
 *
 * 배경:
 *   "내 사이트 인용"은 citation URL/도메인이 brand_config.websites 와 매칭될 때 잡힌다.
 *   소셜 플랫폼(youtube·blog.naver·brunch 등)은 host + 핸들(첫 경로 세그먼트)까지 일치해야 매칭.
 *   여기에 URL 을 추가하면 신규 "내 사이트 인용 URL 전수" 섹션(조회 시점 매칭)이 기존 인용까지 소급 반영.
 *
 * 사용 (운영 앱 컨테이너 안):
 *   ADD_URL="https://brunch.co.kr/@4f336b19d422421" node scripts/add-brand-website.mjs
 *
 * 환경변수:
 *   POSTGRES_URL — 앱 컨테이너에 주입됨
 *   ADD_URL      — 추가할 브랜드 공식 URL
 *   MATCH_BRAND_HOST — (선택) 대상 워크스페이스 식별용 기존 브랜드 호스트. 기본 "magicbodypilates.co.kr"
 *
 * 안전: 이미 있으면 중복 추가 안 함. 대상 워크스페이스는 기존 브랜드 호스트를 가진 것으로 한정.
 */

import postgres from "postgres";

const url = process.env.POSTGRES_URL;
const addUrl = process.env.ADD_URL;
const matchHost = process.env.MATCH_BRAND_HOST || "magicbodypilates.co.kr";

if (!url) { console.error("[add] POSTGRES_URL 없음"); process.exit(1); }
if (!addUrl) { console.error("[add] ADD_URL 없음"); process.exit(1); }

// 추가할 URL 에서 host/핸들 추출 (citation 카운트용)
function parseHostSeg(u) {
  try {
    const withScheme = u.startsWith("http") ? u : `https://${u}`;
    const p = new URL(withScheme);
    const host = p.hostname.replace(/^www\./, "").replace(/^m\./, "").toLowerCase();
    const seg = p.pathname.replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
    return { host, seg };
  } catch { return { host: "", seg: "" }; }
}

const { host, seg } = parseHostSeg(addUrl);
const client = postgres(url, { max: 1 });

try {
  console.log(`[add] 추가 대상 URL: ${addUrl}  (host=${host} 핸들=${seg})`);

  const wss = await client`SELECT id, brand_config FROM workspaces`;
  let targetCount = 0;

  for (const ws of wss) {
    const sites = Array.isArray(ws.brand_config?.websites) ? ws.brand_config.websites : [];
    const hasBrandHost = sites.some((s) => String(s).toLowerCase().includes(matchHost));
    if (!hasBrandHost) continue; // 매직바디 워크스페이스만
    targetCount++;

    if (sites.some((s) => String(s).trim() === addUrl.trim())) {
      console.log(`[add] ws ${ws.id}: 이미 등록됨 — 건너뜀`);
    } else {
      const next = [...sites, addUrl];
      await client`
        UPDATE workspaces
        SET brand_config = jsonb_set(brand_config, '{websites}', ${client.json(next)}::jsonb)
        WHERE id = ${ws.id}
      `;
      console.log(`[add] ws ${ws.id}: 추가 완료 (${sites.length} → ${next.length}개)`);
    }

    // 현재 이 host/핸들 citation 이 얼마나 쌓여 있는지 (소급 반영 규모)
    const rows = await client`
      SELECT count(*)::int AS cnt
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'url' ILIKE ${"%" + host + "%"} OR c->>'domain' ILIKE ${"%" + host + "%"})
    `;
    const hostCnt = rows[0]?.cnt ?? 0;

    let handleCnt = 0;
    if (seg) {
      const hr = await client`
        SELECT count(*)::int AS cnt
        FROM runs r
        CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
        WHERE r.workspace_id = ${ws.id}
          AND jsonb_typeof(r.citations) = 'array'
          AND c->>'url' ILIKE ${"%" + host + "/" + seg + "%"}
      `;
      handleCnt = hr[0]?.cnt ?? 0;
    }
    console.log(`[add] ws ${ws.id}: 현재 ${host} 인용 ${hostCnt}건 · 그중 내 핸들(${seg}) URL 인용 ${handleCnt}건`);
  }

  console.log(`[add] 대상 워크스페이스 ${targetCount}개 처리 완료.`);
  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[add] 실패:", err);
  await client.end();
  process.exit(1);
}
