CREATE TABLE "cp_points_daily" (
	"pair_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cp_points_daily_pair_id_day_source_pk" PRIMARY KEY("pair_id","day","source")
);
--> statement-breakpoint
ALTER TABLE "cp_pairs" ADD COLUMN "intimacy" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cp_points_daily" ADD CONSTRAINT "cp_points_daily_pair_id_cp_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."cp_pairs"("id") ON DELETE no action ON UPDATE no action;