-- Coin price change: ₹1 now buys 100 coins (it bought 10). Everything priced or counted in coins goes ×10, so no rupee
-- value changes: balances, gift prices, past gifts (charisma, room level/heart, family totals), open CP requests.
-- Diamonds go ×10 too (a diamond is now ₹0.005; still 2 diamonds = 1 coin), and so do salary diamond targets in code.
-- Each wallet change gets a ledger row first, so the coin audit (0083) still adds up at commit.
INSERT INTO "wallet_ledger" ("user_id", "entry_type", "amount", "reference_type", "reference_id")
  SELECT "user_id", 'COIN_RESCALE', "balance" * 9, 'RESCALE', '0084_coin_rescale_100' FROM "wallet_accounts" WHERE "balance" > 0;--> statement-breakpoint
UPDATE "wallet_accounts" SET "balance" = "balance" * 10, "version" = "version" + 1 WHERE "balance" > 0;--> statement-breakpoint
INSERT INTO "seller_ledger" ("seller_id", "kind", "amount", "actor_id")
  SELECT "user_id", 'RESCALE', "balance" * 9, "user_id" FROM "coin_sellers" WHERE "balance" > 0;--> statement-breakpoint
UPDATE "coin_sellers" SET "balance" = "balance" * 10 WHERE "balance" > 0;--> statement-breakpoint
UPDATE "gift_catalog" SET "coin_price" = "coin_price" * 10;--> statement-breakpoint
UPDATE "gift_transactions" SET "coins_debited" = "coins_debited" * 10;--> statement-breakpoint
-- Open CP requests were paid in old coins: refunds must return the same value.
UPDATE "cp_proposals" SET "price" = "price" * 10 WHERE "status" = 'PENDING';--> statement-breakpoint
-- Room task claims are room level points (user task claims are XP, which is rupees and unchanged).
UPDATE "task_claims" SET "points" = "points" * 10 WHERE "task_id" LIKE 'room-%';--> statement-breakpoint
-- Diamonds: accounts and agency salary pools (all months, so past sheets still read against the new targets).
INSERT INTO "diamond_ledger" ("user_id", "entry_type", "amount", "reference_type", "reference_id")
  SELECT "user_id", 'DIAMOND_RESCALE', "balance" * 9, 'RESCALE', '0084_coin_rescale_100' FROM "diamond_accounts" WHERE "balance" > 0;--> statement-breakpoint
UPDATE "diamond_accounts" SET "balance" = "balance" * 10 WHERE "balance" > 0;--> statement-breakpoint
INSERT INTO "diamond_ledger" ("user_id", "entry_type", "amount", "reference_type", "reference_id")
  SELECT "user_id", 'DIAMOND_RESCALE', sum("earned" - "converted") * 9, 'RESCALE', '0084_coin_rescale_100:pool'
  FROM "host_months" WHERE "settled_at" IS NULL GROUP BY "user_id" HAVING sum("earned" - "converted") > 0;--> statement-breakpoint
UPDATE "host_months" SET "earned" = "earned" * 10, "converted" = "converted" * 10;--> statement-breakpoint
UPDATE "salary_lines" SET "diamonds" = "diamonds" * 10, "converted_diamonds" = "converted_diamonds" * 10;
