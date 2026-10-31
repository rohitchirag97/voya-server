CREATE TABLE "gift_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gift_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gift_changes" ADD CONSTRAINT "gift_changes_gift_id_gift_catalog_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gift_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_changes" ADD CONSTRAINT "gift_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_changes_gift" ON "gift_changes" USING btree ("gift_id","created_at");