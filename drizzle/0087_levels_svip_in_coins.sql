-- Levels and SVIP are measured in coins recharged instead of rupees (₹1 = 100 coins), so nobody's level or tier moves:
-- XP and level thresholds ×100 (task XP already claimed too), and recharge rows still in old coins (₹1 = 10, before
-- 0084) are put in new coins so this month's SVIP totals and recharge events add up in one unit.
ALTER TABLE "users" ALTER COLUMN "xp" SET DATA TYPE bigint;--> statement-breakpoint
UPDATE "users" SET "xp" = "xp" * 100 WHERE "xp" > 0;--> statement-breakpoint
UPDATE "level_thresholds" SET "xp_required" = "xp_required" * 100;--> statement-breakpoint
UPDATE "task_claims" SET "points" = "points" * 100 WHERE "task_id" LIKE 'user-%';--> statement-breakpoint
-- Old-rate rows are exactly those where coins × 10 = paise (₹1 bought 10 coins); new-rate rows have coins = paise.
UPDATE "recharges" SET "coins" = "coins" * 10 WHERE "coins" * 10 = "price_paise";