-- IF NOT EXISTS: on a database older than this, add the value in its own transaction first (migrate runs 0039+0040 together, and Postgres won't index a value added in the same transaction).
ALTER TYPE "public"."staff_role" ADD VALUE IF NOT EXISTS 'OWNER';
