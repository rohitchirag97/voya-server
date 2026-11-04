ALTER TABLE "coin_sellers" ADD COLUMN "ledger_total" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_ledger" ADD COLUMN "balance_after" bigint;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD COLUMN "ledger_total" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD COLUMN "balance_after" bigint;--> statement-breakpoint
CREATE INDEX "seller_ledger_time" ON "seller_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallet_ledger_time" ON "wallet_ledger" USING btree ("created_at");--> statement-breakpoint
-- Coin audit (hand-written). From here on the database itself guarantees: no coin moves without a ledger row, and ledger
-- rows are never changed or deleted. Wallet balances that already differ from their ledger are recorded once, openly,
-- as an AUDIT_OPENING_ADJUSTMENT row (the difference stays visible in the ledger rather than being hidden).
INSERT INTO "wallet_ledger" ("user_id", "entry_type", "amount", "reference_type", "reference_id")
SELECT w."user_id", 'AUDIT_OPENING_ADJUSTMENT', w."balance" - coalesce(l.total, 0), 'AUDIT', 'migration-0083'
FROM "wallet_accounts" w LEFT JOIN (SELECT "user_id", sum("amount") AS total FROM "wallet_ledger" GROUP BY 1) l USING ("user_id")
WHERE w."balance" <> coalesce(l.total, 0);--> statement-breakpoint
INSERT INTO "seller_ledger" ("seller_id", "kind", "amount", "actor_id")
SELECT s."user_id", 'AUDIT_OPENING_ADJUSTMENT', s."balance" - coalesce(l.total, 0), s."user_id"
FROM "coin_sellers" s LEFT JOIN (SELECT "seller_id", sum("amount") AS total FROM "seller_ledger" GROUP BY 1) l ON l."seller_id" = s."user_id"
WHERE s."balance" <> coalesce(l.total, 0);--> statement-breakpoint
UPDATE "wallet_accounts" w SET "ledger_total" = coalesce((SELECT sum("amount") FROM "wallet_ledger" l WHERE l."user_id" = w."user_id"), 0);--> statement-breakpoint
UPDATE "coin_sellers" s SET "ledger_total" = coalesce((SELECT sum("amount") FROM "seller_ledger" l WHERE l."seller_id" = s."user_id"), 0);--> statement-breakpoint
UPDATE "wallet_ledger" l SET "balance_after" = r.run FROM (SELECT "id", sum("amount") OVER (PARTITION BY "user_id" ORDER BY "id") AS run FROM "wallet_ledger") r WHERE r."id" = l."id";--> statement-breakpoint
UPDATE "seller_ledger" l SET "balance_after" = r.run FROM (SELECT "id", sum("amount") OVER (PARTITION BY "seller_id" ORDER BY "id") AS run FROM "seller_ledger") r WHERE r."id" = l."id";--> statement-breakpoint

-- A new ledger row adds its amount to the wallet's ledger_total and stamps the balance after it. A user wallet that
-- doesn't exist yet is created (at 0, so the commit check below still demands the matching balance change).
CREATE FUNCTION wallet_ledger_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallet_accounts (user_id) VALUES (NEW.user_id) ON CONFLICT DO NOTHING;
  UPDATE wallet_accounts SET ledger_total = ledger_total + NEW.amount WHERE user_id = NEW.user_id RETURNING ledger_total INTO NEW.balance_after;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER wallet_ledger_apply BEFORE INSERT ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION wallet_ledger_apply();--> statement-breakpoint
-- Seller ledger rows for a user with no seller row change nothing (that transaction fails on its own).
CREATE FUNCTION seller_ledger_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE coin_sellers SET ledger_total = ledger_total + NEW.amount WHERE user_id = NEW.seller_id RETURNING ledger_total INTO NEW.balance_after;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER seller_ledger_apply BEFORE INSERT ON seller_ledger FOR EACH ROW EXECUTE FUNCTION seller_ledger_apply();--> statement-breakpoint

-- Ledgers are append-only.
CREATE FUNCTION coin_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'coin ledger rows can''t be changed or deleted; add a correcting row instead' USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION coin_ledger_immutable();--> statement-breakpoint
CREATE TRIGGER seller_ledger_immutable BEFORE UPDATE OR DELETE ON seller_ledger FOR EACH ROW EXECUTE FUNCTION coin_ledger_immutable();--> statement-breakpoint
CREATE TRIGGER wallet_accounts_no_delete BEFORE DELETE ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION coin_ledger_immutable();--> statement-breakpoint

-- ledger_total is only moved by the ledger triggers above (they run one trigger level down).
CREATE FUNCTION coin_ledger_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ledger_total IS DISTINCT FROM OLD.ledger_total AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger_total is kept by the database; insert a ledger row instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER wallet_ledger_total_guard BEFORE UPDATE ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION coin_ledger_total_guard();--> statement-breakpoint
CREATE TRIGGER seller_ledger_total_guard BEFORE UPDATE ON coin_sellers FOR EACH ROW EXECUTE FUNCTION coin_ledger_total_guard();--> statement-breakpoint

-- At commit, every wallet touched must match its ledger, or the whole transaction is refused. Deferred, so the balance
-- change and its ledger row can come in either order inside one transaction; it re-reads the row as of commit.
CREATE FUNCTION wallet_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bigint; t bigint;
BEGIN
  SELECT balance, ledger_total INTO b, t FROM wallet_accounts WHERE user_id = NEW.user_id;
  IF b IS DISTINCT FROM t THEN
    RAISE EXCEPTION 'coin audit: wallet % has balance % but its ledger adds up to %', NEW.user_id, b, t USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_balance_check AFTER INSERT OR UPDATE ON wallet_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_balance_check();--> statement-breakpoint
CREATE FUNCTION seller_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bigint; t bigint;
BEGIN
  SELECT balance, ledger_total INTO b, t FROM coin_sellers WHERE user_id = NEW.user_id;
  IF b IS DISTINCT FROM t THEN
    RAISE EXCEPTION 'coin audit: seller wallet % has balance % but its ledger adds up to %', NEW.user_id, b, t USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER seller_balance_check AFTER INSERT OR UPDATE ON coin_sellers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION seller_balance_check();
