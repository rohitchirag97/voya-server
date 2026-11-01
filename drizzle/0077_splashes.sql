CREATE TABLE "splashes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"art" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"action" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splash_window" CHECK ("splashes"."ends_at" > "splashes"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "splashes" ADD CONSTRAINT "splashes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "splashes_window" ON "splashes" USING btree ("enabled","ends_at");--> statement-breakpoint
UPDATE "staff_roles" SET "permissions" = "permissions" || '["splash.manage"]'::jsonb WHERE "id" = 'ADMIN';
