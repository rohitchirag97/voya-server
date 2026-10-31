ALTER TYPE "public"."cosmetic_kind" ADD VALUE 'ENTRY_EFFECT';--> statement-breakpoint
CREATE TABLE "special_id_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"days" integer,
	"claim_by" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"special_id" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "svip_grants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "svip_grant_tier" CHECK ("svip_grants"."tier" between 1 and 6)
);
--> statement-breakpoint
CREATE TABLE "user_cosmetics" (
	"user_id" uuid NOT NULL,
	"cosmetic_id" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "user_cosmetics_user_id_cosmetic_id_pk" PRIMARY KEY("user_id","cosmetic_id")
);
--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "svga" text;--> statement-breakpoint
ALTER TABLE "cosmetics" ADD COLUMN "exclusive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "repeat" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "repeated_into" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entry_effect_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "special_id_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "special_id_vouchers" ADD CONSTRAINT "special_id_vouchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "svip_grants" ADD CONSTRAINT "svip_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cosmetics" ADD CONSTRAINT "user_cosmetics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cosmetics" ADD CONSTRAINT "user_cosmetics_cosmetic_id_cosmetics_id_fk" FOREIGN KEY ("cosmetic_id") REFERENCES "public"."cosmetics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "special_id_vouchers_user" ON "special_id_vouchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "svip_grants_user" ON "svip_grants" USING btree ("user_id","expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_entry_effect_id_cosmetics_id_fk" FOREIGN KEY ("entry_effect_id") REFERENCES "public"."cosmetics"("id") ON DELETE no action ON UPDATE no action;