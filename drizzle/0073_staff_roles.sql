CREATE TABLE "staff_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#1D9BF0' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"show_tag" boolean DEFAULT true NOT NULL,
	"badge_id" text,
	"frame_id" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Today's four roles, with the access they had (the owner's list is ignored: the owner can do everything).
INSERT INTO "staff_roles" ("id", "name", "color", "permissions", "sort_order") VALUES
  ('OWNER', 'Owner', '#F5B301', '[]', 0),
  ('ADMIN', 'Admin', '#1D9BF0', '["users.view","users.ban","users.specialId","sellers.manage","coins.mint","salaries.pay","withdrawals.decide","gifts.manage","events.manage","events.payout","notices.manage","items.manage","agencies.manage","support.general","support.svip","rooms.pin"]', 10),
  ('MODERATOR', 'Moderator', '#1D9BF0', '["support.general","rooms.pin"]', 20),
  ('SUPPORT', 'Support', '#1D9BF0', '["support.general","rooms.pin"]', 30);
--> statement-breakpoint
DROP INDEX IF EXISTS "users_single_owner";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "staff_role" SET DATA TYPE text USING "staff_role"::text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_owner" ON "users" USING btree ("staff_role") WHERE "users"."staff_role" = 'OWNER';--> statement-breakpoint
ALTER TABLE "user_cosmetics" ADD COLUMN "from_role" text;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_frame_id_cosmetics_id_fk" FOREIGN KEY ("frame_id") REFERENCES "public"."cosmetics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_staff_role_staff_roles_id_fk" FOREIGN KEY ("staff_role") REFERENCES "public"."staff_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."staff_role";
