CREATE TABLE "rocket_bets" (
	"round_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"auto100" integer,
	"cashed100" integer,
	"payout" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rocket_bets_round_id_user_id_pk" PRIMARY KEY("round_id","user_id"),
	CONSTRAINT "rocket_bet_positive" CHECK ("rocket_bets"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "rocket_rounds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"crash100" integer NOT NULL,
	"salt" text NOT NULL,
	"hash" text NOT NULL,
	"launch_at" timestamp with time zone NOT NULL,
	"crashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rocket_crash_range" CHECK ("rocket_rounds"."crash100" >= 100)
);
--> statement-breakpoint
ALTER TABLE "rocket_bets" ADD CONSTRAINT "rocket_bets_round_id_rocket_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rocket_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocket_bets" ADD CONSTRAINT "rocket_bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rocket_rounds_number" ON "rocket_rounds" USING btree ("number");--> statement-breakpoint
CREATE INDEX "rocket_rounds_open" ON "rocket_rounds" USING btree ("id") WHERE "rocket_rounds"."crashed_at" is null;--> statement-breakpoint
CREATE INDEX "rocket_rounds_created" ON "rocket_rounds" USING btree ("created_at");