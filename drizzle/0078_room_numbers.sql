CREATE SEQUENCE "public"."room_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 100001 CACHE 1;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "number" integer DEFAULT nextval('room_number_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_number_unique" UNIQUE("number");