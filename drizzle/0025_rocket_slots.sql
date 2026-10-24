-- Hand-ordered: the column must exist before the new primary key uses it. Existing bets become panel 0.
ALTER TABLE "rocket_bets" ADD COLUMN "slot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rocket_bets" DROP CONSTRAINT "rocket_bets_round_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "rocket_bets" ADD CONSTRAINT "rocket_bets_round_id_user_id_slot_pk" PRIMARY KEY("round_id","user_id","slot");--> statement-breakpoint
ALTER TABLE "rocket_bets" ADD CONSTRAINT "rocket_bet_slot" CHECK ("rocket_bets"."slot" in (0, 1));
