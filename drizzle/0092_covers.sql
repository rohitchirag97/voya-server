ALTER TABLE "posts" DROP CONSTRAINT "posts_kind";--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_has_content";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "audio" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "song_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "part" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "duet_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "duet_of" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_song_id_songs_id_fk" FOREIGN KEY ("song_id") REFERENCES "public"."songs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_duet_of_posts_id_fk" FOREIGN KEY ("duet_of") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_open_duets" ON "posts" USING btree ("song_id","created_at") WHERE "posts"."duet_open";--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_kind" CHECK ("posts"."kind" in ('IMAGE', 'VIDEO', 'TEXT', 'COVER'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_has_content" CHECK (("posts"."kind" = 'TEXT' and "posts"."caption" <> '') or ("posts"."kind" = 'IMAGE' and "posts"."image" is not null) or ("posts"."kind" = 'VIDEO' and "posts"."video" is not null and "posts"."image" is not null) or ("posts"."kind" = 'COVER' and "posts"."audio" is not null and "posts"."song_id" is not null));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_part" CHECK ("posts"."part" is null or "posts"."part" in ('A', 'B'));