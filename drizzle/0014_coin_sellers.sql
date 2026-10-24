CREATE TYPE "public"."coin_seller_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "coin_sellers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" "coin_seller_status" DEFAULT 'PENDING' NOT NULL,
	"message" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "coin_sellers" ADD CONSTRAINT "coin_sellers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coin_sellers_status" ON "coin_sellers" USING btree ("status");