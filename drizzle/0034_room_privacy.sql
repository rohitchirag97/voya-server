CREATE TYPE "public"."room_privacy" AS ENUM('PUBLIC', 'LOCKED', 'PRIVATE');--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "privacy" "room_privacy" DEFAULT 'PUBLIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "password_hash" text;