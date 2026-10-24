-- Random 10-digit public id (1000000000-9999999999), retried until unused. The unique constraint still guards races.
CREATE FUNCTION gen_public_id() RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
DECLARE candidate bigint;
BEGIN
  LOOP
    candidate := 1000000000 + floor(random() * 9000000000)::bigint;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE public_id = candidate);
  END LOOP;
  RETURN candidate;
END $$;--> statement-breakpoint
-- Existing users get an id first, then the column becomes required with the generator as default.
ALTER TABLE "users" ADD COLUMN "public_id" bigint;--> statement-breakpoint
UPDATE "users" SET "public_id" = gen_public_id();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "public_id" SET DEFAULT gen_public_id();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "special_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_special_id_unique" UNIQUE("special_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "special_id_format" CHECK ("users"."special_id" ~ '^[0-9]{3,9}$');
