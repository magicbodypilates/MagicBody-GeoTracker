CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"interval_slot" text NOT NULL,
	"prompt_text" text NOT NULL,
	"provider" text NOT NULL,
	"seq" integer NOT NULL,
	"country_requested" text,
	"drop_country" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"snapshot_id" text,
	"paid_attempts" integer DEFAULT 0 NOT NULL,
	"unknown_submits" integer DEFAULT 0 NOT NULL,
	"paid_retries" integer DEFAULT 0 NOT NULL,
	"country_fallbacks" integer DEFAULT 0 NOT NULL,
	"free_requeues" integer DEFAULT 0 NOT NULL,
	"poll_errors" integer DEFAULT 0 NOT NULL,
	"download_errors" integer DEFAULT 0 NOT NULL,
	"persist_errors" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"submit_started_at" timestamp with time zone,
	"first_submitted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"poll_deadline_at" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"schedule_id" uuid,
	"trigger" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"interval_slot" text NOT NULL,
	"geolocation" text,
	"scoring_snapshot" jsonb,
	"expected_items" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collector_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_round_id_collection_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."collection_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_rounds" ADD CONSTRAINT "collection_rounds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_rounds" ADD CONSTRAINT "collection_rounds_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collection_items_round" ON "collection_items" USING btree ("round_id","prompt_text","provider");--> statement-breakpoint
CREATE INDEX "idx_collection_items_combo" ON "collection_items" USING btree ("workspace_id","interval_slot","prompt_text","provider");--> statement-breakpoint
CREATE INDEX "idx_collection_items_queue" ON "collection_items" USING btree ("status","provider","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_collection_items_poll" ON "collection_items" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collection_rounds_occurrence" ON "collection_rounds" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collection_rounds_one_running" ON "collection_rounds" USING btree ("schedule_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "idx_collection_rounds_workspace_created" ON "collection_rounds" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_collection_rounds_status" ON "collection_rounds" USING btree ("status");