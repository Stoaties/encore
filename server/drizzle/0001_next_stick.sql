CREATE TABLE "playlist_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" text NOT NULL,
	"token" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "playlist_shares" ADD CONSTRAINT "playlist_shares_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_shares_owner_playlist_idx" ON "playlist_shares" USING btree ("owner_id","playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_shares_token_idx" ON "playlist_shares" USING btree ("token");