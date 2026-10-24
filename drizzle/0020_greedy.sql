CREATE TABLE "greedy_bets" (
	"round_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"item" integer NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "greedy_bets_round_id_user_id_item_pk" PRIMARY KEY("round_id","user_id","item"),
	CONSTRAINT "greedy_bet_positive" CHECK ("greedy_bets"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "greedy_rounds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bet_ends_at" timestamp with time zone NOT NULL,
	"result_item" integer,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_round_id_greedy_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."greedy_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "greedy_rounds_unsettled" ON "greedy_rounds" USING btree ("id") WHERE "greedy_rounds"."settled_at" is null;