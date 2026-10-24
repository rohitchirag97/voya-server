ALTER TABLE "posts" ALTER COLUMN "image" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "kind" text DEFAULT 'IMAGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "video" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_kind" CHECK ("posts"."kind" in ('IMAGE', 'VIDEO', 'TEXT'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_has_content" CHECK (("posts"."kind" = 'TEXT' and "posts"."caption" <> '') or ("posts"."kind" = 'IMAGE' and "posts"."image" is not null) or ("posts"."kind" = 'VIDEO' and "posts"."video" is not null and "posts"."image" is not null));