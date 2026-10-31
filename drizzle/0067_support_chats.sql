CREATE TYPE "public"."support_desk" AS ENUM('GENERAL', 'SVIP');--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"from_staff" boolean NOT NULL,
	"body" text NOT NULL,
	"image_url" text,
	"client_message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"desk" "support_desk" NOT NULL,
	"open" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_staff_id" uuid,
	"user_last_read_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_support_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_last_staff_id_users_id_fk" FOREIGN KEY ("last_staff_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_client" ON "support_messages" USING btree ("sender_id","client_message_id");--> statement-breakpoint
CREATE INDEX "support_messages_thread" ON "support_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_threads_user_desk" ON "support_threads" USING btree ("user_id","desk");--> statement-breakpoint
CREATE INDEX "support_threads_queue" ON "support_threads" USING btree ("desk","open","last_message_at");