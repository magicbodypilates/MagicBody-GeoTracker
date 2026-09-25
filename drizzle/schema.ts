/**
 * Phase 5A — 서버 데이터 스키마 (Drizzle ORM + PostgreSQL)
 *
 * 기존 IndexedDB (sovereign-aeo-tracker-*) 에 저장되던 데이터를 서버 DB 로 이관.
 * 모든 테이블은 workspace_id 로 논리적으로 분할 — 브랜드별 데이터 격리.
 *
 * 추가 설계 철학:
 * - JSONB: 스키마가 자주 바뀔 가능성이 있거나, 내부 배열/객체 구조가 복잡한 필드
 * - text[] (PG 배열): 단순 문자열 목록 (언급 목록 등)
 * - UUID PK: 애플리케이션 레이어에서도 사용 가능, 충돌 없음
 * - TIMESTAMPTZ: 타임존 보존 — KST/UTC 혼용 시 안전
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { Citation } from "@/components/dashboard/types";

/* ============================================================
 * workspaces — 브랜드별 워크스페이스
 * ============================================================ */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** 브랜드 설정 — brandName, aliases, websites, industry, keywords, description */
  brandConfig: jsonb("brand_config").$type<BrandConfig>().notNull().default({} as BrandConfig),
  /**
   * 운영 워크스페이스 여부 (경로 분리 핵심).
   *   true  = 일반관리자 경유 노출. 최고관리자 초기화 권한 필요, 일반관리자는 데이터 관리만.
   *   false = 최고관리자 테스트 전용. 일반관리자 API 에서는 접근 차단.
   */
  isProduction: boolean("is_production").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BrandConfig = {
  brandName: string;
  brandAliases: string;
  websites: string[];
  industry: string;
  keywords: string;
  description: string;
  /**
   * (세트·버전) 쌍 선택자 — 계획 §4-5 D8′. 워크스페이스가 지금 쓰는 채점 규칙 세대를 고른다.
   * 불리언이 아니라 쌍을 고르게 해 "세트와 버전은 항상 한 쌍"이 구조로 강제된다.
   *   미설정 또는 "v14a"(기본) — 세트 v14a·버전 14. 유튜브 소유 인용 판정 안 함(현행과 동일).
   *   "v15a" — 세트 v15a·버전 15. 소유 유튜브 인용을 hasCitationOnly 에 접어 판정.
   *   "v16a" — 세트 v16a·버전 16. v15a 와 판정은 같고 언론·블로그·소셜 배점만 켜진다
   *   (2026-09-23). **신규 수집** 경로에만 영향 — 이미 저장된 버전 15 행의 재계산은 재산출
   *   잡 v16 이 담당하며 이 스위치와 무관하다.
   *   "v17a" — 세트 v17a·버전 17. v16a 와 같고 언론 게재 배점만 45(2026-09-24). 운영 값.
   *   이미 저장된 버전 16 행의 재계산은 재산출 잡 v17 이 담당한다.
   * 허용 값 목록은 SCORING_SET_SWITCH_VALUES 하나가 정본이다(PATCH 검증·채점 선택자가 함께 쓴다).
   */
  scoringSetSwitch?: ScoringSetSwitchValue;
};

/**
 * scoringSetSwitch 허용 값 — 정본 목록(2026-09-25 결함 D2). 워크스페이스 PATCH 검증(zod)과
 * automation-runner 의 SCORING_PROFILES(키 전수 강제)가 이 목록 하나를 함께 쓴다. 예전엔
 * 타입·검증·선택자가 각자 목록을 들고 있어 운영 값 "v17a" 가 선택자에서 조용히 v14a 로 떨어졌다.
 * jsonb 안의 값이라 마이그레이션이 필요 없다.
 */
export const SCORING_SET_SWITCH_VALUES = ["v14a", "v15a", "v16a", "v17a"] as const;
export type ScoringSetSwitchValue = (typeof SCORING_SET_SWITCH_VALUES)[number];

/**
 * 회차 점수 기준 — 자동 수집 회차를 만들 때 워크스페이스 브랜드 설정·경쟁사를 복사해 둔 것
 * (계획 geotracker-collect-speed-260924 §2-3 "점수 기준"). 회차 도중 설정이 바뀌어도 그 회차는
 * 시작할 때의 기준으로 점수를 매긴다 — 지금 "스케줄 실행 1번에 1번 읽기"와 같은 의미다.
 * automation-runner.ts 가 import 하므로 순환 import 를 피하려고 여기(BrandConfig 옆)에 둔다.
 */
export type ScoringSnapshot = {
  brandConfig: BrandConfig;
  competitors: { name: string; aliases: string[]; websites: string[] }[];
};

/* ============================================================
 * competitors — 경쟁사 (워크스페이스 별)
 * ============================================================ */
export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default([]),
    websites: text("websites").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("idx_competitors_workspace").on(t.workspaceId),
  }),
);

/* ============================================================
 * prompts — 추적 프롬프트 라이브러리
 * ============================================================ */
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    tags: text("tags").array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceTextUnique: uniqueIndex("uq_prompts_workspace_text").on(t.workspaceId, t.text),
    workspaceActiveIdx: index("idx_prompts_workspace_active").on(t.workspaceId, t.active),
  }),
);

/* ============================================================
 * schedules — 자동 실행 스케줄
 * ============================================================ */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** node-cron 표현식. 기본 12시간 주기 = "0 0,12 * * *" */
    cronExpression: text("cron_expression").notNull(),
    /** 실행 대상 프로바이더 — ["chatgpt", "perplexity", ...] */
    providers: text("providers").array().notNull(),
    /** 실행 대상 프롬프트 ID 목록 — 빈 배열이면 워크스페이스 전체 active 프롬프트 */
    promptIds: uuid("prompt_ids").array().notNull().default([]),
    geolocation: text("geolocation"), // "kr", "us", ...
    active: boolean("active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceActiveIdx: index("idx_schedules_workspace_active").on(t.workspaceId, t.active),
    nextRunIdx: index("idx_schedules_next_run").on(t.nextRunAt),
  }),
);

/* ============================================================
 * runs — 수집된 AI 응답 (자동 + 수동)
 * ============================================================ */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** NULL 이면 수동 실행 */
    scheduleId: uuid("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
    promptText: text("prompt_text").notNull(),
    provider: text("provider").notNull(), // chatgpt|perplexity|gemini|google_ai|copilot|grok
    answer: text("answer"),
    sources: text("sources").array().notNull().default([]),
    /** Citation[] 구조 (url, domain, title, description) */
    citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
    visibilityScore: integer("visibility_score").notNull(),
    sentiment: text("sentiment").notNull(), // positive|neutral|negative|not-mentioned
    brandMentions: text("brand_mentions").array().notNull().default([]),
    competitorMentions: text("competitor_mentions").array().notNull().default([]),
    citedBrandDomains: text("cited_brand_domains").array().notNull().default([]),
    citedCompetitorDomains: text("cited_competitor_domains").array().notNull().default([]),
    attachedBrandMentions: text("attached_brand_mentions").array().notNull().default([]),
    attachedCompetitorMentions: text("attached_competitor_mentions").array().notNull().default([]),
    /**
     * 소유 유튜브 인용 증거 — 계획 geotracker-youtube-press-scoring-260923 §4-4(D6).
     * 이 응답의 citations 중 우리 채널 소유로 판정된 영상의 video-ID 목록(수집 시점 판정
     * 결과를 그대로 저장 — 재계산 시점의 소유 목록 변동과 무관하게 "그때 무엇으로
     * 판정했는가"를 보존한다). 형식은 cited_brand_domains 와 같은 text[] — 값이 없으면
     * 소유 유튜브 인용이 없었거나(applyOwnedCitationJudgment 꺼짐 포함) 기능 미사용.
     */
    citedOwnedVideoIds: text("cited_owned_video_ids").array().notNull().default([]),
    /**
     * 언론(제3자 매체) 게재 증거 — 2026-09-23 3차 개정(제3자 인용 판정 재설계).
     * 인용의 제목·설명에 브랜드 용어가 있고 우리 소유가 아니며 호스트가 소셜 플랫폼이
     * 아닌 도메인 문자열 목록(dedup, press-domain-match.ts 의 collectThirdPartyCitationEvidence
     * 산출물). 같은 조건에서 호스트가 소셜 플랫폼이면 cited_social_domains 로 간다 — 둘은
     * 배타적이다. 배점은 이번 판에서도 항상 0 이라 점수에 영향을 주지 않고, 배점을 켤지
     * 실측으로 판단할 근거로만 쌓인다.
     */
    citedPressDomains: text("cited_press_domains").array().notNull().default([]),
    /**
     * 블로그·소셜 추천 증거 — 2026-09-23 3차 개정. cited_press_domains 와 판정 조건은
     * 같고 호스트가 소셜 플랫폼(SOCIAL_PLATFORM_DOMAINS)일 때만 여기로 간다. 언론 게재와
     * 블로거·소셜 추천을 별도 집계로 나눈 것 — 직전 개정이 소셜 플랫폼을 통째로 제외해
     * 이 증거를 잃었던 것을 되돌린다. 인스타그램 개별 게시물처럼 경로에 채널 핸들이 없는
     * 형태는 우리 게시물이어도 소유 판별이 안 돼 여기로 섞일 수 있다 — 받아들이는 한계.
     */
    citedSocialDomains: text("cited_social_domains").array().notNull().default([]),
    geolocation: text("geolocation"),
    isAuto: boolean("is_auto").notNull().default(false),
    /** "2026-04-21T12" 슬롯 기반 중복 실행 방지 */
    intervalSlot: text("interval_slot"),
    /** 응답 품질 플래그 — 파싱/캐시/응답길이 이상치 집계에서 제외하기 위한 지표 */
    parseQuality: text("parse_quality"), // high|medium|low
    isCachedResponse: boolean("is_cached_response").notNull().default(false),
    responseLength: integer("response_length"),
    executionDurationMs: integer("execution_duration_ms"),
    /**
     * visibility_score 가 산출된 점수 룰 버전.
     *   0 = 옛 룰 (백필 대상). 새 응답은 항상 최신 버전으로 저장.
     *   1 = 옵션 B (2026-04-24): 본문 brand 언급 차원 + URL 차원 분리, mentions>=1 시 URL 점수 안 줌
     *   2 = brand 모드 점수 재조정 (2026-04-28): 긍정 +20, 적극 추천 +30, 본문 URL +5, 참고자료 +2
     * 백필 스크립트는 score_version < CURRENT_VERSION 인 row 만 처리 → 멱등성 보장.
     */
    scoreVersion: integer("score_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * 응답 보관 시각 — 계획 geotracker-response-archive-260924 §2-2. NULL = 보관 안 함.
     * 「질문 목록에 없는 질문」의 응답을 사용자가 보관함으로 옮기면 그 시점 행에만 채워진다
     * (스냅숏 — 이후 같은 문구로 새로 생긴 행은 NULL 로 들어와 보관함 ①에 다시 보인다).
     * 보관 행은 응답 목록·모든 통계·변동 알림에서 빠지고(lib/server/run-archive.ts 의
     * notArchivedRunCondition 단일 정의), 되돌리면 NULL 로 돌아가 그대로 다시 들어간다.
     * 중복 수집 확인(uq_runs_auto_slot)은 보관 행도 센다 — 되돌렸을 때 같은 칸에 응답이
     * 두 개 생기지 않게 하기 위해서다.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceCreatedIdx: index("idx_runs_workspace_created").on(t.workspaceId, t.createdAt),
    workspaceAutoIdx: index("idx_runs_workspace_auto_created").on(
      t.workspaceId,
      t.isAuto,
      t.createdAt,
    ),
    scheduleIdx: index("idx_runs_schedule").on(t.scheduleId, t.createdAt),
    slotIdx: index("idx_runs_slot").on(
      t.workspaceId,
      t.intervalSlot,
      t.promptText,
      t.provider,
    ),
    /**
     * 동일 (workspace, interval_slot, prompt_text, provider) 조합 중복 실행 방지.
     * interval_slot 이 NULL 인 행(수동 실행) 은 제외 — 부분 인덱스 사용.
     */
    autoSlotUnique: uniqueIndex("uq_runs_auto_slot")
      .on(t.workspaceId, t.intervalSlot, t.promptText, t.provider)
      .where(sql`interval_slot IS NOT NULL`),
    /**
     * 보관 행 전용 부분 인덱스 — 보관함 목록(문구별 묶음·max(archived_at) 정렬)과 변동 알림
     * 숨김(알림 뒤에 보관됐는지 시각 비교)을 인덱스 안에서 끝낸다. 보관 행만 담아 작다.
     */
    archivedPromptIdx: index("idx_runs_ws_prompt_archived")
      .on(t.workspaceId, t.promptText, t.archivedAt)
      .where(sql`archived_at IS NOT NULL`),
  }),
);

/* ============================================================
 * daily_stats — 일별 집계 (Phase 5C 에서 롤업)
 * ============================================================ */
export const dailyStats = pgTable(
  "daily_stats",
  {
    date: date("date").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /**
     * 프롬프트별 집계 대상. 기본키(date, workspace_id, provider, prompt_id)의 일부라
     * Postgres 가 NOT NULL 을 강제한다(onDelete: "set null" 은 여기 도달할 일이 없다 —
     * 프롬프트가 지워지면 그 prompt_id 를 가리키던 daily_stats 행도 없기 때문. 매칭되는
     * 프롬프트가 없는 runs 는 애초에 집계에서 제외된다 — automation-runner.ts runDailyRollup 참고).
     */
    promptId: uuid("prompt_id").references(() => prompts.id, {
      onDelete: "set null",
    }),
    sampleCount: integer("sample_count").notNull(),
    avgVisibility: numeric("avg_visibility", { precision: 5, scale: 2 }).notNull(),
    mentionRate: numeric("mention_rate", { precision: 5, scale: 4 }).notNull(),
    positiveSentimentRate: numeric("positive_sentiment_rate", { precision: 5, scale: 4 }),
    citedOfficialRate: numeric("cited_official_rate", { precision: 5, scale: 4 }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.workspaceId, t.provider, t.promptId] }),
    lookupIdx: index("idx_daily_stats_lookup").on(t.workspaceId, t.date, t.provider),
  }),
);

/* ============================================================
 * drift_alerts — 가시성 급변 알림
 * ============================================================ */
export const driftAlerts = pgTable(
  "drift_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    promptText: text("prompt_text").notNull(),
    provider: text("provider").notNull(),
    oldScore: integer("old_score").notNull(),
    newScore: integer("new_score").notNull(),
    delta: integer("delta").notNull(),
    severity: text("severity").notNull(), // info|warning|critical
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceActiveIdx: index("idx_drift_alerts_workspace_active").on(
      t.workspaceId,
      t.dismissed,
      t.createdAt,
    ),
  }),
);

/* ============================================================
 * audit_history — AEO 감사 이력
 * ============================================================ */
export const auditHistory = pgTable(
  "audit_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    score: integer("score").notNull(),
    /** AuditReport 전체 JSON */
    report: jsonb("report").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceCreatedIdx: index("idx_audit_workspace_created").on(t.workspaceId, t.createdAt),
  }),
);

/* ============================================================
 * brand_youtube_videos — 우리 채널(@magicbody1) 소유 유튜브 영상 집합
 * ============================================================
 * 계획 geotracker-youtube-video-match-v2 §4·R2.
 *
 * 목적: AI 답변이 인용한 유튜브 영상 URL 의 video-ID 가 우리 소유 영상인지 판정하기 위한
 *   video-ID 집합. 조회시점에 로드해 "내 사이트 인용" 목록에 반영한다(노출 점수 재계산 X — D1).
 *
 * 자동 갱신 신뢰성(§2): 하드삭제 없이 소프트삭제(is_active)로만 운영한다.
 *   - upsert 는 절대 삭제하지 않고 is_active=true·missing_count=0·last_seen_at 갱신.
 *   - 채널에서 사라진 영상은 missing_count 를 누적해 임계(기본 2회) 도달 시에만 is_active=false.
 *   → 갱신이 부분 실패해도 기존 목록이 손상되지 않는다(행 유지·복구 가능).
 *
 * brand_config(sync 대상)와 완전히 분리된 별도 테이블 — 클라이언트 sync 오염 원천 차단(K6).
 */
export const brandYoutubeVideos = pgTable(
  "brand_youtube_videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** 유튜브 video-ID (11자 [A-Za-z0-9_-]) — CHECK 제약으로 형식 방어(L1) */
    videoId: text("video_id").notNull(),
    /** 소유 채널 핸들 — 다채널 확장 전까지 단일값. 감사 추적용 default(L2) */
    channelHandle: text("channel_handle").notNull().default("@magicbody1"),
    /** 소프트삭제 플래그(H3) — false 면 조회 집합에서 제외되지만 행은 보존 */
    isActive: boolean("is_active").notNull().default(true),
    /** 채널 목록에서 연속 미관측 횟수(H3) — 임계 도달 시에만 소프트삭제 */
    missingCount: integer("missing_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** 마지막으로 채널 목록에서 관측된 시각 — 신선도(stale) 판정에 사용(§2.2) */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (workspace, video_id) 유일 — upsert ON CONFLICT 대상
    wsVideoUnique: uniqueIndex("uq_brand_yt_videos_ws_video").on(t.workspaceId, t.videoId),
    // 조회 경로(is_active=true 집합) 인덱스
    wsActiveIdx: index("idx_brand_yt_videos_ws_active").on(t.workspaceId, t.isActive),
    // video-ID 형식 방어(L1) — 11자 [A-Za-z0-9_-]
    videoIdFormat: check("brand_yt_videos_video_id_format", sql`video_id ~ '^[A-Za-z0-9_-]{11}$'`),
  }),
);

/* ============================================================
 * 자동 수집 대기열 — 계획 geotracker-collect-speed-260924 (Step 3 · 마이그레이션 0008)
 * ============================================================
 * 예전 엔진은 틱 하나가 모든 질문 × AI 를 메모리 반복문으로 몇 시간씩 붙잡았다. 새 엔진은
 * 회차(collection_rounds)와 회차별 항목(collection_items)을 DB 에 두고, 1분마다 도는 짧은 두 줄기
 * (보내기·거두기)가 항목 상태를 한 단계씩 옮긴다. Bright Data 요청 번호를 항목에 남겨 재시작·
 * 배포 뒤에도 같은 번호로 이어서 받는다. 항목은 회차마다 따로 두고 덮어쓰지 않는다 — 회차별
 * 비용·원인·결과가 섞이지 않게 하기 위해서다(검수 #9).
 * 기존 표(runs·schedules 등)는 바꾸지 않는다.
 */

/** 회차 마감 요약 — 상태별 개수와 과금 추적 칸, AI별 원인 코드 개수. */
export type CollectionRoundSummary = {
  saved: number;
  duplicate: number;
  failed: number;
  cancelled: number;
  /** 200/202 로 접수가 확인된 제출 수 (과금 확정분) */
  paidAttempts: number;
  /** 접수 여부 불명 제출 수 (끊김·5xx·네트워크) — 과금 상한 계산에 포함 */
  unknownSubmits: number;
  /** 일반 재시도 수 (회차당 AI별 예산 안) */
  paidRetries: number;
  /** perplexity 지역값 없이 재시도 수 (예산 밖) — 2026-09-25 폐지 뒤 새 회차는 늘 0 */
  countryFallbacks: number;
  byProvider: Record<
    string,
    { saved: number; duplicate: number; failed: number; cancelled: number; failedByCode: Record<string, number> }
  >;
};

/* collection_rounds — 자동 수집 회차 (계획 geotracker-collect-speed-260924) */
export const collectionRounds = pgTable(
  "collection_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    /** cron | manual | first_run */
    trigger: text("trigger").notNull(),
    /** 즉시 실행·첫 회차 1, 정기 0 — 제출 순서에서 높은 쪽이 먼저 */
    priority: integer("priority").notNull().default(0),
    /** running | completed | skipped_overlap */
    status: text("status").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /** 회차 예정 시각의 UTC 시 ("YYYY-MM-DDTHH") — 회차 내내 고정, runs.interval_slot 으로 저장 */
    intervalSlot: text("interval_slot").notNull(),
    /** 스케줄 값 사본 → runs.geolocation (지금과 같음) */
    geolocation: text("geolocation"),
    /** 회차 점수 기준(브랜드 설정·경쟁사 사본) — skipped_overlap 은 null */
    scoringSnapshot: jsonb("scoring_snapshot").$type<ScoringSnapshot>(),
    expectedItems: integer("expected_items").notNull().default(0),
    summary: jsonb("summary").$type<CollectionRoundSummary>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    occurrenceUnique: uniqueIndex("uq_collection_rounds_occurrence").on(t.scheduleId, t.scheduledFor),
    /** 스케줄당 진행 중 회차는 1개 — DB 가 강제한다 */
    oneRunning: uniqueIndex("uq_collection_rounds_one_running")
      .on(t.scheduleId)
      .where(sql`status = 'running'`),
    workspaceCreatedIdx: index("idx_collection_rounds_workspace_created").on(t.workspaceId, t.createdAt),
    statusIdx: index("idx_collection_rounds_status").on(t.status),
  }),
);

/** 제출 시도 1회의 기록 — 돈이 들 수 있는 호출 **전에** 칸을 만들고 결과를 채운다(검수 #4). */
export type CollectionAttempt = {
  /** 1부터 — 제출 시도 순번 (무료 재대기 포함) */
  n: number;
  /** 실제로 보낸 지역값 (null = 보내지 않음) */
  country: string | null;
  /** claim 시각 ISO — 돈이 들 수 있는 구간의 시작 */
  startedAt: string;
  snapshotId?: string;
  /** 200/202 를 받았으면 true */
  accepted?: boolean;
  finishedAt?: string;
  outcome?: "saved" | "duplicate" | "retry" | "failed" | "requeued" | "unknown";
  errorCode?: string;
  /** redactErrorText 로 가린 300자 이내 */
  error?: string;
  progress?: { records?: number; errors?: number };
  durationMs?: number;
};

/* collection_items — 회차별 불변 항목 (질문 × AI) */
export const collectionItems = pgTable(
  "collection_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => collectionRounds.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    intervalSlot: text("interval_slot").notNull(),
    promptText: text("prompt_text").notNull(),
    provider: text("provider").notNull(),
    seq: integer("seq").notNull(),
    /** 스케줄 geolocation ?? "KR". 단 Perplexity 는 NULL — 2026-09-25부터 국가를 요청하지 않는다 */
    countryRequested: text("country_requested"),
    /** (2026-09-25부터 쓰지 않음 — 옛 기록) perplexity 지역값 재시도 뒤 true 였다 */
    dropCountry: boolean("drop_country").notNull().default(false),
    /** queued | submitting | submitted | saved | duplicate | failed | cancelled */
    status: text("status").notNull(),
    /** Bright Data 요청 번호 (진행 중일 때) */
    snapshotId: text("snapshot_id"),
    /** 200/202 로 접수가 확인된 제출 */
    paidAttempts: integer("paid_attempts").notNull().default(0),
    /** 접수 여부 불명(끊김·5xx·네트워크) — 과금 상한에 포함 */
    unknownSubmits: integer("unknown_submits").notNull().default(0),
    /** 일반 재시도 0/1 */
    paidRetries: integer("paid_retries").notNull().default(0),
    /** (2026-09-25부터 쓰지 않음 — 옛 기록) perplexity 지역값 없이 재시도 0/1 (예산 밖) */
    countryFallbacks: integer("country_fallbacks").notNull().default(0),
    /** 429 재대기 */
    freeRequeues: integer("free_requeues").notNull().default(0),
    pollErrors: integer("poll_errors").notNull().default(0),
    downloadErrors: integer("download_errors").notNull().default(0),
    persistErrors: integer("persist_errors").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    submitStartedAt: timestamp("submit_started_at", { withTimezone: true }),
    firstSubmittedAt: timestamp("first_submitted_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    pollDeadlineAt: timestamp("poll_deadline_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    /** redactErrorText 로 가린 300자 이내 */
    lastError: text("last_error"),
    attempts: jsonb("attempts").$type<CollectionAttempt[]>().notNull().default([]),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roundUnique: uniqueIndex("uq_collection_items_round").on(t.roundId, t.promptText, t.provider),
    comboIdx: index("idx_collection_items_combo").on(t.workspaceId, t.intervalSlot, t.promptText, t.provider),
    queueIdx: index("idx_collection_items_queue").on(t.status, t.provider, t.nextAttemptAt),
    pollIdx: index("idx_collection_items_poll").on(t.status, t.nextPollAt),
  }),
);

/**
 * 엔진 공용 작은 상태 — 키: auth_pause_until · rate_pause:<provider> · daily_rollup · process
 * (perplexity_country_failed_at 은 2026-09-25부터 쓰지 않는다 — 남은 행은 무해).
 * 재시작해도 유지돼야 하는 값만 둔다(예전엔 메모리에 있어 배포마다 사라졌다).
 */
export const collectorState = pgTable("collector_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
 * 타입 export — API 레이어에서 재사용
 * ============================================================ */
export type Workspace = InferSelectModel<typeof workspaces>;
export type NewWorkspace = InferInsertModel<typeof workspaces>;
export type Competitor = InferSelectModel<typeof competitors>;
export type NewCompetitor = InferInsertModel<typeof competitors>;
export type Prompt = InferSelectModel<typeof prompts>;
export type NewPrompt = InferInsertModel<typeof prompts>;
export type Schedule = InferSelectModel<typeof schedules>;
export type NewSchedule = InferInsertModel<typeof schedules>;
export type Run = InferSelectModel<typeof runs>;
export type NewRun = InferInsertModel<typeof runs>;
export type DailyStat = InferSelectModel<typeof dailyStats>;
export type NewDailyStat = InferInsertModel<typeof dailyStats>;
export type DriftAlert = InferSelectModel<typeof driftAlerts>;
export type NewDriftAlert = InferInsertModel<typeof driftAlerts>;
export type AuditHistoryEntry = InferSelectModel<typeof auditHistory>;
export type NewAuditHistoryEntry = InferInsertModel<typeof auditHistory>;
export type BrandYoutubeVideo = InferSelectModel<typeof brandYoutubeVideos>;
export type NewBrandYoutubeVideo = InferInsertModel<typeof brandYoutubeVideos>;
export type CollectionRound = InferSelectModel<typeof collectionRounds>;
export type NewCollectionRound = InferInsertModel<typeof collectionRounds>;
export type CollectionItem = InferSelectModel<typeof collectionItems>;
export type NewCollectionItem = InferInsertModel<typeof collectionItems>;
export type CollectorStateRow = InferSelectModel<typeof collectorState>;
