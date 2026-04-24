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
    geolocation: text("geolocation"),
    isAuto: boolean("is_auto").notNull().default(false),
    /** "2026-04-21T12" 슬롯 기반 중복 실행 방지 */
    intervalSlot: text("interval_slot"),
    /** 응답 품질 플래그 — 파싱/캐시/응답길이 이상치 집계에서 제외하기 위한 지표 */
    parseQuality: text("parse_quality"), // high|medium|low
    isCachedResponse: boolean("is_cached_response").notNull().default(false),
    responseLength: integer("response_length"),
    executionDurationMs: integer("execution_duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    /** NULL 이면 프로바이더 단위 전체 집계, 아니면 프롬프트별 */
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
