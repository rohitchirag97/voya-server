CREATE TYPE "public"."cp_proposal_status" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."cp_type" AS ENUM('LOVE', 'BESTIE', 'SIBLING');--> statement-breakpoint
CREATE TABLE "cp_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"type" "cp_type" NOT NULL,
	"label" text,
	"proposal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "cp_pair_order" CHECK ("cp_pairs"."user_a" < "cp_pairs"."user_b")
);
--> statement-breakpoint
CREATE TABLE "cp_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" "cp_type" NOT NULL,
	"label" text,
	"price" integer NOT NULL,
	"status" "cp_proposal_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cp_not_self" CHECK ("cp_proposals"."from_id" <> "cp_proposals"."to_id")
);
--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "cp_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "cp_pairs" ADD CONSTRAINT "cp_pairs_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cp_pairs" ADD CONSTRAINT "cp_pairs_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cp_pairs" ADD CONSTRAINT "cp_pairs_proposal_id_cp_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."cp_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cp_pairs" ADD CONSTRAINT "cp_pairs_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cp_proposals" ADD CONSTRAINT "cp_proposals_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cp_proposals" ADD CONSTRAINT "cp_proposals_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cp_pairs_one_active" ON "cp_pairs" USING btree ("user_a","user_b") WHERE "cp_pairs"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "cp_pairs_a" ON "cp_pairs" USING btree ("user_a") WHERE "cp_pairs"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "cp_pairs_b" ON "cp_pairs" USING btree ("user_b") WHERE "cp_pairs"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "cp_one_pending_per_pair" ON "cp_proposals" USING btree ("from_id","to_id") WHERE "cp_proposals"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "cp_proposals_pending_expiry" ON "cp_proposals" USING btree ("expires_at") WHERE "cp_proposals"."status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_cp_proposal_id_cp_proposals_id_fk" FOREIGN KEY ("cp_proposal_id") REFERENCES "public"."cp_proposals"("id") ON DELETE no action ON UPDATE no action;