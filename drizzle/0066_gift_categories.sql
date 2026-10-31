CREATE TABLE "gift_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The starting set (ids 1-4; 1 = Classic is every gift's default). Admins rename, reorder and add more in the panel.
INSERT INTO "gift_categories" ("id", "name", "sort_order") VALUES (1, 'Classic', 1), (2, 'Love', 2), (3, 'Animated', 3), (4, 'Luxury', 4);--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('gift_categories', 'id'), 4);--> statement-breakpoint
ALTER TABLE "gift_catalog" ADD COLUMN "category_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_catalog" ADD CONSTRAINT "gift_catalog_category_id_gift_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."gift_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "gift_catalog" SET "category_id" = 2 WHERE "id" IN ('rose', 'teddy', 'perfume', 'love_letter', 'diamond_ring');--> statement-breakpoint
UPDATE "gift_catalog" SET "category_id" = 3 WHERE "effect" IS NOT NULL;--> statement-breakpoint
UPDATE "gift_catalog" SET "category_id" = 4 WHERE "id" IN ('sports_car', 'yacht', 'castle', 'private_jet', 'dragon', 'treasure_chest', 'universe');