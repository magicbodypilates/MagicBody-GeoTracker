CREATE TABLE "brand_youtube_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"channel_handle" text DEFAULT '@magicbody1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_yt_videos_video_id_format" CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$')
);
--> statement-breakpoint
ALTER TABLE "brand_youtube_videos" ADD CONSTRAINT "brand_youtube_videos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_brand_yt_videos_ws_video" ON "brand_youtube_videos" USING btree ("workspace_id","video_id");--> statement-breakpoint
CREATE INDEX "idx_brand_yt_videos_ws_active" ON "brand_youtube_videos" USING btree ("workspace_id","is_active");