CREATE TYPE "public"."import_source" AS ENUM('spotify', 'youtube');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('resolving', 'review', 'requesting', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('auto', 'needs_review', 'confirmed', 'rejected', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."play_event" AS ENUM('play', 'complete', 'skip');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'approved', 'denied', 'searching', 'downloading', 'processing', 'available', 'failed');--> statement-breakpoint
CREATE TYPE "public"."request_type" AS ENUM('track', 'album', 'artist');--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"status" "import_status" DEFAULT 'resolving' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source_title" text NOT NULL,
	"source_artist" text,
	"source_album" text,
	"duration_ms" integer,
	"match_mb_recording_id" text,
	"match_title" text,
	"match_artist" text,
	"match_mb_release_group_id" text,
	"match_album" text,
	"match_score" real,
	"match_status" "match_status" DEFAULT 'unmatched' NOT NULL,
	"in_library" boolean DEFAULT false NOT NULL,
	"request_id" uuid
);
--> statement-breakpoint
CREATE TABLE "job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mb_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "request_type" NOT NULL,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"parent_id" uuid,
	"mb_artist_id" text,
	"artist_name" text NOT NULL,
	"mb_release_group_id" text,
	"album_title" text,
	"mb_recording_id" text,
	"track_title" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"progress" real,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"available_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_plays" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"event" "play_event" NOT NULL,
	"position_sec" real,
	"duration_sec" real,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jellyfin_user_id" text NOT NULL,
	"username" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"jellyfin_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_jellyfin_user_id_unique" UNIQUE("jellyfin_user_id")
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_plays" ADD CONSTRAINT "track_plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_items_batch_pos_idx" ON "import_items" USING btree ("batch_id","position");--> statement-breakpoint
CREATE INDEX "job_logs_job_idx" ON "job_logs" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "jobs_poll_idx" ON "jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "jobs_request_idx" ON "jobs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "requests_requested_by_idx" ON "requests" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "requests_parent_idx" ON "requests" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "requests_rg_idx" ON "requests" USING btree ("mb_release_group_id");--> statement-breakpoint
CREATE INDEX "requests_rec_idx" ON "requests" USING btree ("mb_recording_id");--> statement-breakpoint
CREATE INDEX "track_plays_user_item_idx" ON "track_plays" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "track_plays_at_idx" ON "track_plays" USING btree ("at");