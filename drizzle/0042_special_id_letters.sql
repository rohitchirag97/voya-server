ALTER TABLE "users" DROP CONSTRAINT "special_id_format";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "special_id_format" CHECK ("users"."special_id" ~ '^[A-Z0-9]{3,9}$');