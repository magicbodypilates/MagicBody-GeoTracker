/**
 * 검증(읽기 전용) — 인용된 유튜브 영상 중 우리 채널 영상(brand_youtube_videos active)에
 * 실제로 매칭되는 규모를 집계. 배포 후 "몇 개나 잡히나" 확인용.
 *
 * 사용(운영 앱 컨테이너): node scripts/verify-youtube-match.mjs
 * 환경변수: POSTGRES_URL (읽기 전용)
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) { console.error("[verify-yt] POSTGRES_URL 없음"); process.exit(1); }
const client = postgres(url, { max: 1 });

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const GOOGLE_HOSTS = new Set(["google.com", "www.google.com"]);

// app의 youtube-video-match 핵심 로직을 간략 복제(검증용 카운트)
function extractVideoId(raw, depth = 0) {
  if (!raw || depth > 1) return null;
  let u;
  try { u = new URL(raw.startsWith("http") ? raw : `https://${raw}`); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) {
    const id = u.pathname.replace(/^\/+/, "").split("/")[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (YT_HOSTS.has(host)) {
    const v = u.searchParams.get("v");
    if (v && VIDEO_ID_RE.test(v)) return v;
    const m = u.pathname.match(/^\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return null;
  }
  if (GOOGLE_HOSTS.has(host)) {
    for (const p of ["q", "url"]) {
      const val = u.searchParams.get(p);
      if (val) { const inner = extractVideoId(val, depth + 1); if (inner) return inner; }
    }
    return null;
  }
  return null;
}

try {
  const wss = await client`SELECT id, brand_config FROM workspaces`;
  for (const ws of wss) {
    const sites = Array.isArray(ws.brand_config?.websites) ? ws.brand_config.websites : [];
    if (!sites.some((s) => String(s).toLowerCase().includes("magicbodypilates.co.kr"))) continue;

    const owned = await client`SELECT video_id FROM brand_youtube_videos WHERE workspace_id = ${ws.id} AND is_active = true`;
    const ownedSet = new Set(owned.map((r) => r.video_id));
    console.log(`[verify-yt] ws ${ws.id} · 우리 채널 영상(active) ${ownedSet.size}개`);

    // 유튜브 영상 후보 인용 전수(watch·youtu.be·google 래핑)
    const rows = await client`
      SELECT c->>'url' AS url
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.citations) AS c
      WHERE r.workspace_id = ${ws.id}
        AND jsonb_typeof(r.citations) = 'array'
        AND (c->>'url' ILIKE '%youtube.com/watch%' OR c->>'url' ILIKE '%youtu.be/%'
             OR c->>'url' ILIKE '%youtube.com/embed%' OR c->>'url' ILIKE '%youtube.com/shorts%'
             OR c->>'url' ILIKE '%google.com/search%youtu%')
    `;
    let totalCites = 0, ownedCites = 0;
    const allVideoUrls = new Set(), ownedVideoUrls = new Set(), ownedVideoIds = new Set();
    for (const r of rows) {
      const id = extractVideoId(r.url || "");
      if (!id) continue;
      totalCites++; allVideoUrls.add(r.url);
      if (ownedSet.has(id)) { ownedCites++; ownedVideoUrls.add(r.url); ownedVideoIds.add(id); }
    }
    console.log(`[verify-yt] 인용된 유튜브 영상 — 전체 고유 URL ${allVideoUrls.size}개 · 인용 ${totalCites}건`);
    console.log(`[verify-yt] 그중 우리 채널 영상 — 고유 영상 ${ownedVideoIds.size}개 · 고유 URL ${ownedVideoUrls.size}개 · 인용 ${ownedCites}건`);
  }
  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[verify-yt] 실패:", err);
  await client.end();
  process.exit(1);
}
