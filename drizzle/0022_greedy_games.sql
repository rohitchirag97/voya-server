DROP INDEX "greedy_rounds_created";--> statement-breakpoint
ALTER TABLE "greedy_rounds" ADD COLUMN "game" text DEFAULT 'jungle' NOT NULL;--> statement-breakpoint
CREATE INDEX "greedy_rounds_game_created" ON "greedy_rounds" USING btree ("game","created_at");--> statement-breakpoint
CREATE INDEX "greedy_rounds_game_id" ON "greedy_rounds" USING btree ("game","id");