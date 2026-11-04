CREATE TABLE "task_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"period" text NOT NULL,
	"points" integer NOT NULL,
	"claimed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_claims_once" ON "task_claims" USING btree ("subject_id","task_id","period");