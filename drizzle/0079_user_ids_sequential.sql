CREATE SEQUENCE "public"."user_public_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 630000001 CACHE 1;--> statement-breakpoint
-- Everyone gets a 9-digit id in signup order (630000001 = oldest). Old ids are 10 digits, so the new ones never collide mid-update.
UPDATE "users" u SET "public_id" = 630000000 + r.n FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "users") r WHERE u."id" = r."id";--> statement-breakpoint
SELECT setval('user_public_id_seq', GREATEST((SELECT max("public_id") FROM "users"), 630000000));--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "public_id" SET DEFAULT nextval('user_public_id_seq');--> statement-breakpoint
DROP FUNCTION IF EXISTS gen_public_id();
