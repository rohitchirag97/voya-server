CREATE TYPE "public"."withdrawal_status" AS ENUM('PENDING', 'PAID', 'REJECTED');--> statement-breakpoint
CREATE TABLE "cash_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_paise" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cash_non_negative" CHECK ("cash_accounts"."balance_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cash_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_months" (
	"user_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"month" date NOT NULL,
	"earned" integer DEFAULT 0 NOT NULL,
	"converted" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "host_months_user_id_agency_id_month_pk" PRIMARY KEY("user_id","agency_id","month"),
	CONSTRAINT "host_month_converted" CHECK ("host_months"."converted" <= "host_months"."earned")
);
--> statement-breakpoint
CREATE TABLE "payout_details" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"account_name" text NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"month" date NOT NULL,
	"user_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"level" integer NOT NULL,
	"diamonds" integer NOT NULL,
	"mic_minutes" integer NOT NULL,
	"gross_paise" integer NOT NULL,
	"converted_diamonds" integer NOT NULL,
	"pay_paise" integer NOT NULL,
	"paid_in" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_runs" (
	"month" date PRIMARY KEY NOT NULL,
	"started_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"account_name" text NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"status" "withdrawal_status" DEFAULT 'PENDING' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid
);
--> statement-breakpoint
ALTER TABLE "mic_sessions" ADD COLUMN "agency_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_months" ADD CONSTRAINT "host_months_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_months" ADD CONSTRAINT "host_months_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_details" ADD CONSTRAINT "payout_details_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_lines" ADD CONSTRAINT "salary_lines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_lines" ADD CONSTRAINT "salary_lines_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_runs" ADD CONSTRAINT "salary_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_ledger_user" ON "cash_ledger" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_lines_once" ON "salary_lines" USING btree ("month","user_id","agency_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_one_open" ON "withdrawals" USING btree ("user_id") WHERE "withdrawals"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "withdrawals_status" ON "withdrawals" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "mic_sessions" ADD CONSTRAINT "mic_sessions_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;