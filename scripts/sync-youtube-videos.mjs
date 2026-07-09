/**
 * sync-youtube-videos.mjs — 우리 채널(@magicbody1) 소유 유튜브 영상 목록을 brand_youtube_videos 에
 * 안전하게 반영(upsert + 소프트삭제)한다.
 *
 * 사용 (운영 앱 컨테이너 안):
 *   node scripts/sync-youtube-videos.mjs
 *
 * 입력 env:
 *   POSTGRES_URL           (필수) DB 접속
 *   VIDEO_IDS_FILE         video-ID 목록 파일 경로(줄/공백 구분). 또는
 *   VIDEO_IDS              video-ID 목록 문자열(줄/공백 구분)
 *   MATCH_BRAND_HOST       워크스페이스 판정용 브랜드 대표 도메인 (기본 magicbodypilates.co.kr)
 *   CHANNEL_HANDLE         소유 채널 핸들 (기본 @magicbody1) — 감사 추적
 *   DRY_RUN=1              계획만 로그, 쓰기 0 (배포 전/최초 1회 필수)
 *   DEACTIVATE_MISSING     기본 true. false 면 채널에서 사라진 영상도 영구 active 유지(발행 이력 전체)
 *   ABS_MIN                절대 최소 영상 수(기본 50). 이 미만이면 전면 abort(테이블 보호)
 *   MIN_RATIO              현재 active 대비 최소 비율(기본 0.5). 이 미만이면 abort
 *   MISS_THRESHOLD         연속 미관측 임계(기본 2). 이 횟수 도달 시에만 소프트삭제
 *   MAX_DEACTIVATE_PER_RUN 한 run 비활성 상한(기본 20). 초과 시 비활성 보류 + Slack
 *   SLACK_WEBHOOK          실패/이상 경보 webhook (없으면 SLACK_APPROVAL_WEBHOOK_URL 사용)
 *
 * 신뢰성 설계(계획 geotracker-youtube-video-match-v2 §2.3):
 *   - 하드 DELETE 문 자체를 두지 않는다 — 오직 소프트삭제(is_active=false)만.
 *   - 다층 가드(절대최소·상대하한·비활성 상한)로 부분 취득이 목록을 손상시키지 못하게 한다.
 *   - 미관측 2회 연속 후에만 비활성(주 1회면 약 2주). 복구 가능(행 보존).
 *   - 실패/이상 시 Slack 경보 + exit≠0 (조용한 실패 금지). 전 과정 단일 트랜잭션·파라미터 바인딩.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";

/* ── env 헬퍼 ── */
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !(raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "no");
}

const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error("[sync-yt] POSTGRES_URL 없음");
  process.exit(1);
}

// 화이트리스트 검증(M4) — 파라미터 바인딩 전 형식 방어. shell 조립 없음.
const HOST_RE = /^[A-Za-z0-9@._-]+$/;
const MATCH_BRAND_HOST = (process.env.MATCH_BRAND_HOST || "magicbodypilates.co.kr").trim();
const CHANNEL_HANDLE = (process.env.CHANNEL_HANDLE || "@magicbody1").trim();
if (!HOST_RE.test(MATCH_BRAND_HOST) || !HOST_RE.test(CHANNEL_HANDLE)) {
  console.error("[sync-yt] MATCH_BRAND_HOST/CHANNEL_HANDLE 형식 오류");
  process.exit(1);
}

const DRY_RUN = envBool("DRY_RUN", false);
const DEACTIVATE_MISSING = envBool("DEACTIVATE_MISSING", true);
const ABS_MIN = envInt("ABS_MIN", 50, 1, 100000);
const MIN_RATIO_PCT = envInt("MIN_RATIO_PCT", 50, 1, 100); // 비율은 정수 %로 받아 안전 처리
const MISS_THRESHOLD = envInt("MISS_THRESHOLD", 2, 1, 100);
const MAX_DEACTIVATE_PER_RUN = envInt("MAX_DEACTIVATE_PER_RUN", 20, 1, 100000);
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || process.env.SLACK_APPROVAL_WEBHOOK_URL || "";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Slack 경보(있으면). 실패해도 스크립트 흐름은 막지 않는다(경보는 보조). */
async function slack(text) {
  if (!SLACK_WEBHOOK) {
    console.warn("[sync-yt] SLACK_WEBHOOK 미설정 — 경보 로그만:", text);
    return;
  }
  try {
    await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[GeoTracker sync-yt] ${text}` }),
    });
  } catch (e) {
    console.error("[sync-yt] Slack 전송 실패:", e?.message || e);
  }
}

/** video-ID 목록 취득 — 파일 또는 env. 형식 검증 + dedup. */
function loadVideoIds() {
  let raw = "";
  const file = process.env.VIDEO_IDS_FILE;
  if (file) {
    raw = readFileSync(file, "utf8");
  } else if (process.env.VIDEO_IDS) {
    raw = process.env.VIDEO_IDS;
  } else {
    throw new Error("VIDEO_IDS_FILE 또는 VIDEO_IDS 필요");
  }
  const set = new Set();
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (VIDEO_ID_RE.test(t)) set.add(t);
  }
  return [...set];
}

async function main() {
  const ids = loadVideoIds();
  const sql = postgres(POSTGRES_URL, { max: 1 });

  try {
    // 워크스페이스 판정 — brand_config.websites 에 MATCH_BRAND_HOST 를 포함하는 WS(citation-insight 규약).
    const wss = await sql`SELECT id, brand_config FROM workspaces`;
    const target = wss.find((w) => {
      const sites = Array.isArray(w.brand_config?.websites) ? w.brand_config.websites : [];
      return sites.some((s) => String(s).toLowerCase().includes(MATCH_BRAND_HOST.toLowerCase()));
    });
    if (!target) {
      await slack(`워크스페이스 판정 실패 — MATCH_BRAND_HOST=${MATCH_BRAND_HOST} 미발견. 갱신 보류.`);
      throw new Error("workspace not found");
    }
    const wsId = target.id;

    // 현재 active 수 (상대 하한 가드 기준)
    const [{ active_count }] = await sql`
      SELECT count(*)::int AS active_count
      FROM brand_youtube_videos
      WHERE workspace_id = ${wsId} AND is_active = true
    `;
    const currentActive = Number(active_count) || 0;

    console.log(
      `[sync-yt] ws=${wsId} fetched=${ids.length} currentActive=${currentActive} ` +
        `DRY_RUN=${DRY_RUN} DEACTIVATE_MISSING=${DEACTIVATE_MISSING} ` +
        `ABS_MIN=${ABS_MIN} MIN_RATIO=${MIN_RATIO_PCT}% MISS_THRESHOLD=${MISS_THRESHOLD} MAX_DEACT=${MAX_DEACTIVATE_PER_RUN}`,
    );

    /* ── 가드 1: 절대 최소치 ── */
    if (ids.length < ABS_MIN) {
      await slack(`부분실패 의심 — 취득 목록 과소(fetched=${ids.length} < ABS_MIN=${ABS_MIN}). 갱신 보류(쓰기 0).`);
      throw new Error("abs_min guard");
    }
    /* ── 가드 2: 상대 하한(현재 active 대비) ── */
    const minByRatio = Math.floor((currentActive * MIN_RATIO_PCT) / 100);
    if (currentActive > 0 && ids.length < minByRatio) {
      await slack(
        `부분실패 의심 — 취득 목록이 현재 active 의 ${MIN_RATIO_PCT}% 미만(fetched=${ids.length} < ${minByRatio}). 갱신 보류(쓰기 0).`,
      );
      throw new Error("min_ratio guard");
    }

    // 미관측(비활성 후보) 계획 미리 계산 — dry-run 로그·상한 가드용.
    // active 이면서 이번 fetched 에 없고, (증가 후) missing_count+1 >= 임계가 될 행 수.
    const [{ deact_candidates }] = await sql`
      SELECT count(*)::int AS deact_candidates
      FROM brand_youtube_videos
      WHERE workspace_id = ${wsId}
        AND is_active = true
        AND NOT (video_id = ANY(${ids}))
        AND missing_count + 1 >= ${MISS_THRESHOLD}
    `;
    const deactCandidates = Number(deact_candidates) || 0;

    const [{ new_count }] = await sql`
      SELECT count(*)::int AS new_count
      FROM (SELECT unnest(${ids}::text[]) AS vid) f
      WHERE NOT EXISTS (
        SELECT 1 FROM brand_youtube_videos b
        WHERE b.workspace_id = ${wsId} AND b.video_id = f.vid
      )
    `;
    const newCount = Number(new_count) || 0;

    console.log(
      `[sync-yt] 계획 — 신규 insert=${newCount} · upsert(유지/재활성)=${ids.length - newCount} · ` +
        `비활성 후보=${deactCandidates}${DEACTIVATE_MISSING ? "" : " (DEACTIVATE_MISSING=false → 비활성 안 함)"}`,
    );

    /* ── 가드 3: 비활성 상한 ── */
    if (DEACTIVATE_MISSING && deactCandidates > MAX_DEACTIVATE_PER_RUN) {
      await slack(
        `비활성 대상 급증 — ${deactCandidates}개 > 상한 ${MAX_DEACTIVATE_PER_RUN}. 비활성 보류·부분실패 의심. 갱신 보류.`,
      );
      throw new Error("max_deactivate guard");
    }

    if (DRY_RUN) {
      console.log("[sync-yt] DRY_RUN — 쓰기 0. 계획만 출력하고 종료.");
      await sql.end();
      process.exit(0);
    }

    /* ── 쓰기 (단일 트랜잭션) ── */
    let deactivated = 0;
    await sql.begin(async (tx) => {
      // 1) upsert(무손상) — fetched 전체를 재활성·last_seen_at 갱신·missing_count 리셋. 절대 삭제 없음.
      const rows = ids.map((vid) => ({
        workspace_id: wsId,
        video_id: vid,
        channel_handle: CHANNEL_HANDLE,
      }));
      // 큰 목록도 한 번에 안전 — postgres.js 다중행 INSERT + ON CONFLICT.
      await tx`
        INSERT INTO brand_youtube_videos ${tx(rows, "workspace_id", "video_id", "channel_handle")}
        ON CONFLICT (workspace_id, video_id) DO UPDATE
          SET is_active = true,
              last_seen_at = now(),
              missing_count = 0,
              channel_handle = EXCLUDED.channel_handle
      `;

      if (DEACTIVATE_MISSING) {
        // 2) 미관측 처리 — active 인데 이번 fetched 에 없는 행은 missing_count += 1.
        await tx`
          UPDATE brand_youtube_videos
          SET missing_count = missing_count + 1
          WHERE workspace_id = ${wsId}
            AND is_active = true
            AND NOT (video_id = ANY(${ids}))
        `;

        // 3) 임계 도달 행만 소프트 비활성(행 보존·복구 가능). 상한은 위에서 이미 가드.
        const deactRows = await tx`
          UPDATE brand_youtube_videos
          SET is_active = false
          WHERE workspace_id = ${wsId}
            AND is_active = true
            AND missing_count >= ${MISS_THRESHOLD}
            AND NOT (video_id = ANY(${ids}))
          RETURNING video_id
        `;
        deactivated = deactRows.length;
      }
    });

    const [{ total_active }] = await sql`
      SELECT count(*)::int AS total_active
      FROM brand_youtube_videos
      WHERE workspace_id = ${wsId} AND is_active = true
    `;

    console.log(
      `[sync-yt] 완료 — 신규=${newCount} · 비활성=${deactivated} · 현재 active 총 ${total_active}`,
    );
    await sql.end();
    process.exit(0);
  } catch (err) {
    console.error("[sync-yt] 실패:", err?.message || err);
    try {
      await sql.end();
    } catch {
      /* noop */
    }
    process.exit(1);
  }
}

main();
