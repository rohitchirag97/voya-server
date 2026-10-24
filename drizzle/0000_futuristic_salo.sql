CREATE TYPE "public"."message_type" AS ENUM('USER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('HOST', 'MODERATOR', 'SPEAKER', 'AUDIENCE');--> statement-breakpoint
CREATE TYPE "public"."presence_status" AS ENUM('CONNECTED', 'DISCONNECTED', 'LEFT', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('CREATED', 'LIVE', 'ENDING', 'ENDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'BANNED');--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "block_no_self" CHECK ("blocks"."blocker_id" <> "blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"sender_user_id" uuid,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"type" "message_type" DEFAULT 'USER' NOT NULL,
	"payload" jsonb,
	"moderation_status" text DEFAULT 'VISIBLE' NOT NULL,
	"client_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followed_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followed_id_pk" PRIMARY KEY("follower_id","followed_id"),
	CONSTRAINT "follow_no_self" CHECK ("follows"."follower_id" <> "follows"."followed_id")
);
--> statement-breakpoint
CREATE TABLE "gift_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"asset_url" text NOT NULL,
	"coin_price" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_quantity" integer DEFAULT 99 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_price_positive" CHECK ("gift_catalog"."coin_price" > 0)
);
--> statement-breakpoint
CREATE TABLE "gift_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"gift_id" text NOT NULL,
	"room_id" uuid NOT NULL,
	"recipient_seat_index" integer NOT NULL,
	"quantity" integer NOT NULL,
	"coins_debited" integer NOT NULL,
	"status" text DEFAULT 'SETTLED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_no_self" CHECK ("gift_transactions"."sender_id" <> "gift_transactions"."recipient_id")
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"phone" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "participant_role" DEFAULT 'AUDIENCE' NOT NULL,
	"presence" "presence_status" DEFAULT 'CONNECTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room_seats" (
	"room_id" uuid NOT NULL,
	"seat_index" integer NOT NULL,
	"row_index" integer NOT NULL,
	"column_index" integer NOT NULL,
	"occupant_user_id" uuid,
	"stream_id" text,
	"mic_muted" boolean DEFAULT false NOT NULL,
	"assigned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_seats_room_id_seat_index_pk" PRIMARY KEY("room_id","seat_index")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zego_room_id" text NOT NULL,
	"host_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"cover_url" text,
	"status" "room_status" DEFAULT 'CREATED' NOT NULL,
	"seat_count" integer NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"listener_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "rooms_zego_room_id_unique" UNIQUE("zego_room_id"),
	CONSTRAINT "rooms_seat_count" CHECK ("rooms"."seat_count" in (8, 10, 12, 16, 20))
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wallet_non_negative" CHECK ("wallet_accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" integer NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followed_id_users_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_gift_id_gift_catalog_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gift_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_seats" ADD CONSTRAINT "room_seats_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_seats" ADD CONSTRAINT "room_seats_occupant_user_id_users_id_fk" FOREIGN KEY ("occupant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_room" ON "chat_messages" USING btree ("room_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_client_id" ON "chat_messages" USING btree ("room_id","sender_user_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_tx_idempotency" ON "gift_transactions" USING btree ("sender_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_active" ON "room_participants" USING btree ("room_id","user_id") WHERE "room_participants"."left_at" is null;--> statement-breakpoint
CREATE INDEX "room_participants_user" ON "room_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_seats_one_per_user" ON "room_seats" USING btree ("room_id","occupant_user_id") WHERE "room_seats"."occupant_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_one_open_per_host" ON "rooms" USING btree ("host_user_id") WHERE "rooms"."status" in ('CREATED', 'LIVE');--> statement-breakpoint
CREATE INDEX "rooms_status_started" ON "rooms" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_display_name_lower" ON "users" USING btree (lower("display_name"));--> statement-breakpoint
CREATE INDEX "wallet_ledger_user" ON "wallet_ledger" USING btree ("user_id","id");