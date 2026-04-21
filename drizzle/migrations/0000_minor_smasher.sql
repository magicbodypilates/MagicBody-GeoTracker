CREATE TABLE "audit_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"score" integer NOT NULL,
	"report" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"websites" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"date" date NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"prompt_id" uuid,
	"sample_count" integer NOT NULL,
	"avg_visibility" numeric(5, 2) NOT NULL,
	"mention_rate" numeric(5, 4) NOT NULL,
	"positive_sentiment_rate" numeric(5, 4),
	"cited_official_rate" numeric(5, 4),
	CONSTRAINT "daily_stats_date_workspace_id_provider_prompt_id_pk" PRIMARY KEY("date","workspace_id","provider","prompt_id")
);
--> statement-breakpoint
CREATE TABLE "drift_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prompt_text" text NOT NULL,
	"provider" text NOT NULL,
	"old_score" integer NOT NULL,
	"new_score" integer NOT NULL,
	"delta" integer NOT NULL,
	"severity" text NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"schedule_id" uuid,
	"prompt_text" text NOT NULL,
	"provider" text NOT NULL,
	"answer" text,
	"sources" text[] DEFAULT '{}' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility_score" integer NOT NULL,
	"sentiment" text NOT NULL,
	"brand_mentions" text[] DEFAULT '{}' NOT NULL,
	"competitor_mentions" text[] DEFAULT '{}' NOT NULL,
	"cited_brand_domains" text[] DEFAULT '{}' NOT NULL,
	"cited_competitor_domains" text[] DEFAULT '{}' NOT NULL,
	"attached_brand_mentions" text[] DEFAULT '{}' NOT NULL,
	"attached_competitor_mentions" text[] DEFAULT '{}' NOT NULL,
	"geolocation" text,
	"is_auto" boolean DEFAULT false NOT NULL,
	"interval_slot" text,
	"parse_quality" text,
	"is_cached_response" boolean DEFAULT false NOT NULL,
	"response_length" integer,
	"execution_duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron_expression" text NOT NULL,
	"providers" text[] NOT NULL,
	"prompt_ids" uuid[] DEFAULT '{}' NOT NULL,
	"geolocation" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"brand_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_history" ADD CONSTRAINT "audit_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_alerts" ADD CONSTRAINT "drift_alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_workspace_created" ON "audit_history" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_competitors_workspace" ON "competitors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_daily_stats_lookup" ON "daily_stats" USING btree ("workspace_id","date","provider");--> statement-breakpoint
CREATE INDEX "idx_drift_alerts_workspace_active" ON "drift_alerts" USING btree ("workspace_id","dismissed","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompts_workspace_text" ON "prompts" USING btree ("workspace_id","text");--> statement-breakpoint
CREATE INDEX "idx_prompts_workspace_active" ON "prompts" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE INDEX "idx_runs_workspace_created" ON "runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_workspace_auto_created" ON "runs" USING btree ("workspace_id","is_auto","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_schedule" ON "runs" USING btree ("schedule_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_slot" ON "runs" USING btree ("workspace_id","interval_slot","prompt_text","provider");--> statement-breakpoint
CREATE INDEX "idx_schedules_workspace_active" ON "schedules" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE INDEX "idx_schedules_next_run" ON "schedules" USING btree ("next_run_at");