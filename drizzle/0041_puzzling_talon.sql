CREATE TABLE "seller_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"counterparty_id" uuid,
	"actor_id" uuid NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coin_sellers" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "coin_sellers" ADD COLUMN "balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_ledger" ADD CONSTRAINT "seller_ledger_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_ledger" ADD CONSTRAINT "seller_ledger_counterparty_id_users_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_ledger" ADD CONSTRAINT "seller_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_ledger_seller" ON "seller_ledger" USING btree ("seller_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_ledger_idem" ON "seller_ledger" USING btree ("actor_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "coin_sellers" ADD CONSTRAINT "coin_sellers_parent_id_users_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coin_sellers_parent" ON "coin_sellers" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "coin_sellers" ADD CONSTRAINT "seller_balance_non_negative" CHECK ("coin_sellers"."balance" >= 0);--> statement-breakpoint
ALTER TABLE "coin_sellers" ADD CONSTRAINT "seller_not_own_parent" CHECK ("coin_sellers"."parent_id" <> "coin_sellers"."user_id");