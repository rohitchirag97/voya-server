ALTER TABLE "rooms" ADD COLUMN "background" text DEFAULT 'night' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "show_entry" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "gift_animations" boolean DEFAULT true NOT NULL;