ALTER TABLE "import_batches" ADD COLUMN "cover_url" text;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "jellyfin_playlist_id" text;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "truncated" boolean DEFAULT false NOT NULL;
