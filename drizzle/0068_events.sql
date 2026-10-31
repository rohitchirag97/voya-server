CREATE TABLE "event_payouts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"reward" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"banner_url" text,
	"banner_home" boolean DEFAULT true NOT NULL,
	"banner_room" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"gift_category_id" integer,
	"config" jsonb NOT NULL,
	"paid_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_window" CHECK ("events"."ends_at" > "events"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "event_payouts" ADD CONSTRAINT "event_payouts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_payouts" ADD CONSTRAINT "event_payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_payouts" ADD CONSTRAINT "event_payouts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_gift_category_id_gift_categories_id_fk" FOREIGN KEY ("gift_category_id") REFERENCES "public"."gift_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_payouts_once" ON "event_payouts" USING btree ("event_id","user_id","source");--> statement-breakpoint
CREATE INDEX "events_window" ON "events" USING btree ("published","starts_at","ends_at");