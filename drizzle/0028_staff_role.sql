CREATE TYPE "public"."staff_role" AS ENUM('SUPPORT', 'MODERATOR', 'ADMIN');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "staff_role" "staff_role";