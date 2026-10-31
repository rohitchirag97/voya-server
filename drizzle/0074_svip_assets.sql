CREATE TABLE "svip_assets" (
	"kind" text NOT NULL,
	"tier" integer NOT NULL,
	"svga" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "svip_assets_kind_tier_pk" PRIMARY KEY("kind","tier"),
	CONSTRAINT "svip_asset_tier" CHECK ("svip_assets"."tier" between 1 and 6)
);
--> statement-breakpoint
-- Today's built-in SVIP animations.
INSERT INTO "svip_assets" ("kind", "tier", "svga") SELECT k, t, 'games/fx/svip/' || k || '/' || t || '.svga' FROM (VALUES ('entry', 1), ('seat', 1), ('name', 4), ('badge', 5)) AS f(k, low), generate_series(1, 6) AS t WHERE t >= low;--> statement-breakpoint
UPDATE "staff_roles" SET "permissions" = "permissions" || '["svip.manage"]'::jsonb WHERE "id" = 'ADMIN';
