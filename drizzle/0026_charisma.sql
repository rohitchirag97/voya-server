ALTER TABLE "rooms" ADD COLUMN "charisma_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "gift_tx_room_time" ON "gift_transactions" USING btree ("room_id","created_at");