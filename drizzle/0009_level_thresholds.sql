CREATE TABLE "level_thresholds" (
	"level" integer PRIMARY KEY NOT NULL,
	"xp_required" integer NOT NULL,
	CONSTRAINT "level_positive" CHECK ("level_thresholds"."level" >= 1),
	CONSTRAINT "xp_required_non_negative" CHECK ("level_thresholds"."xp_required" >= 0)
);
--> statement-breakpoint
-- XP switched from "1 per coin" to "1 per ₹1": recompute from successful recharges.
UPDATE "users" u SET "xp" = coalesce((SELECT sum(r."price_paise") / 100 FROM "recharges" r WHERE r."user_id" = u."id" AND r."status" = 'SUCCESS'), 0);
