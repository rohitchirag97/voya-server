CREATE TYPE "public"."live_pk_status" AS ENUM('INVITED', 'ACTIVE', 'ENDED', 'DECLINED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."room_kind" AS ENUM('AUDIO', 'LIVE');--> statement-breakpoint
CREATE TABLE "live_pks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_a" uuid NOT NULL,
	"room_b" uuid NOT NULL,
	"status" "live_pk_status" DEFAULT 'INVITED' NOT NULL,
	"minutes" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"winner_room" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_seat_count";--> statement-breakpoint
DROP INDEX "rooms_one_open_per_host";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "kind" "room_kind" DEFAULT 'AUDIO' NOT NULL;--> statement-breakpoint
ALTER TABLE "live_pks" ADD CONSTRAINT "live_pks_room_a_rooms_id_fk" FOREIGN KEY ("room_a") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_pks" ADD CONSTRAINT "live_pks_room_b_rooms_id_fk" FOREIGN KEY ("room_b") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_pk_one_open_a" ON "live_pks" USING btree ("room_a") WHERE "live_pks"."status" in ('INVITED', 'ACTIVE');--> statement-breakpoint
CREATE UNIQUE INDEX "live_pk_one_open_b" ON "live_pks" USING btree ("room_b") WHERE "live_pks"."status" in ('INVITED', 'ACTIVE');--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_one_open_per_host_kind" ON "rooms" USING btree ("host_user_id","kind") WHERE "rooms"."status" in ('CREATED', 'LIVE');--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_seat_count" CHECK ("rooms"."seat_count" in (4, 8, 10, 12, 16, 20));