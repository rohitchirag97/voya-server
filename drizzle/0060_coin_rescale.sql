-- Coin price change: ₹1 now buys 10 coins (it bought about 0.77 before).
-- Prices in coins go up ×10 (rounder numbers, slightly cheaper in rupees); coins people already hold go up ×13, so
-- nobody's balance loses rupee value. Each balance change gets a ledger entry so ledgers still add up to balances.
UPDATE "gift_catalog" SET "coin_price" = "coin_price" * 10;--> statement-breakpoint
-- Past gifts restated in new coins, so weekly charisma, top gifters, room rank/heart and family totals don't mix units.
UPDATE "gift_transactions" SET "coins_debited" = "coins_debited" * 10;--> statement-breakpoint
INSERT INTO "wallet_ledger" ("user_id", "entry_type", "amount", "reference_type", "reference_id")
  SELECT "user_id", 'COIN_RESCALE', "balance" * 12, 'RESCALE', '0060_coin_rescale' FROM "wallet_accounts" WHERE "balance" > 0;--> statement-breakpoint
UPDATE "wallet_accounts" SET "balance" = "balance" * 13, "version" = "version" + 1 WHERE "balance" > 0;--> statement-breakpoint
INSERT INTO "seller_ledger" ("seller_id", "kind", "amount", "actor_id")
  SELECT "user_id", 'RESCALE', "balance" * 12, "user_id" FROM "coin_sellers" WHERE "balance" > 0;--> statement-breakpoint
UPDATE "coin_sellers" SET "balance" = "balance" * 13 WHERE "balance" > 0;--> statement-breakpoint
-- Open CP requests were paid in old coins: refunds must return the same value.
UPDATE "cp_proposals" SET "price" = "price" * 13 WHERE "status" = 'PENDING';
