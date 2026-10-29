CREATE TABLE "diamond_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "diamonds_non_negative" CHECK ("diamond_accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "diamond_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" integer NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diamond_accounts" ADD CONSTRAINT "diamond_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diamond_ledger" ADD CONSTRAINT "diamond_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diamond_ledger_user" ON "diamond_ledger" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "diamond_ledger_idempotency" ON "diamond_ledger" USING btree ("user_id","idempotency_key");