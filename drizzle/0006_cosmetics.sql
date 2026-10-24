CREATE TYPE "public"."cosmetic_kind" AS ENUM('AVATAR_FRAME', 'CARD_DECOR');--> statement-breakpoint
CREATE TABLE "cosmetics" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "cosmetic_kind" NOT NULL,
	"name" text NOT NULL,
	"svg" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_frame_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "card_decor_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_frame_id_cosmetics_id_fk" FOREIGN KEY ("avatar_frame_id") REFERENCES "public"."cosmetics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_card_decor_id_cosmetics_id_fk" FOREIGN KEY ("card_decor_id") REFERENCES "public"."cosmetics"("id") ON DELETE no action ON UPDATE no action;