CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"image_url" text,
	"color" text DEFAULT '#08C9D9' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"in_inbox" boolean DEFAULT false NOT NULL,
	"home_tab" text DEFAULT 'BOTH' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_window" CHECK ("notices"."ends_at" > "notices"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "home_tab" text DEFAULT 'BOTH' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notices_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notices_window" ON "notices" USING btree ("published","starts_at","ends_at");