ALTER TABLE "rooms" ADD COLUMN "pin_slot" integer;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "official" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_pin_slot_unique" ON "rooms" USING btree ("pin_slot") WHERE "rooms"."pin_slot" is not null;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_pin_slot" CHECK ("rooms"."pin_slot" between 1 and 4);