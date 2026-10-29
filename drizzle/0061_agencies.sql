CREATE TYPE "public"."agency_host_status" AS ENUM('APPLIED', 'INVITED', 'ACTIVE', 'LEAVING');--> statement-breakpoint
CREATE TYPE "public"."agency_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" integer GENERATED ALWAYS AS IDENTITY (sequence name "agencies_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 100001 CACHE 1),
	"name" text NOT NULL,
	"image_url" text,
	"owner_id" uuid NOT NULL,
	"status" "agency_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agencies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "agency_hosts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"status" "agency_host_status" NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"leave_requested_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "agency_id" uuid;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_hosts" ADD CONSTRAINT "agency_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_hosts" ADD CONSTRAINT "agency_hosts_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_one_open_per_owner" ON "agencies" USING btree ("owner_id") WHERE "agencies"."status" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "agency_hosts_agency" ON "agency_hosts" USING btree ("agency_id","status");--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;