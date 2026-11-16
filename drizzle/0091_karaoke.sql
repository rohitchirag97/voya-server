ALTER TABLE "rooms" ADD COLUMN "karaoke" jsonb;--> statement-breakpoint
CREATE TABLE "songs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"cover" text,
	"track" text NOT NULL,
	"original" text,
	"lyrics" text NOT NULL,
	"duration_ms" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"plays" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);