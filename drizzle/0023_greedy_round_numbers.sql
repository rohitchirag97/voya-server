-- Hand-edited: existing rounds get numbers per game in id order before the column becomes NOT NULL.
ALTER TABLE "greedy_rounds" ADD COLUMN "number" integer;--> statement-breakpoint
UPDATE "greedy_rounds" r SET "number" = n.rn FROM (SELECT "id", row_number() OVER (PARTITION BY "game" ORDER BY "id") AS rn FROM "greedy_rounds") n WHERE r."id" = n."id";--> statement-breakpoint
ALTER TABLE "greedy_rounds" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "greedy_rounds_game_number" ON "greedy_rounds" USING btree ("game","number");
