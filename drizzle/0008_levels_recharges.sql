CREATE TABLE "recharges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"coins" integer NOT NULL,
	"price_paise" integer NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'SUCCESS' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recharge_coins_positive" CHECK ("recharges"."coins" > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "xp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recharges" ADD CONSTRAINT "recharges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recharges_idempotency" ON "recharges" USING btree ("user_id","idempotency_key");