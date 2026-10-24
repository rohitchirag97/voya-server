ALTER TYPE "public"."cosmetic_kind" ADD VALUE 'CHAT_BUBBLE';--> statement-breakpoint
ALTER TABLE "cosmetics" ADD COLUMN "style" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_bubble_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_chat_bubble_id_cosmetics_id_fk" FOREIGN KEY ("chat_bubble_id") REFERENCES "public"."cosmetics"("id") ON DELETE no action ON UPDATE no action;