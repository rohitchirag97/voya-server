CREATE TABLE "admin_grants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"items" jsonb NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "for_prize" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "for_mall" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cosmetics" ADD COLUMN "for_prize" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cosmetics" ADD COLUMN "for_mall" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notices" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_grants" ADD CONSTRAINT "admin_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_grants" ADD CONSTRAINT "admin_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_grants_created" ON "admin_grants" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Items made in the panel so far were event prizes.
UPDATE "cosmetics" SET "for_prize" = true WHERE "exclusive";--> statement-breakpoint
UPDATE "badges" SET "for_prize" = true WHERE "sort_order" = 1000;
