CREATE TABLE "profile_visits" (
	"visitor_id" uuid NOT NULL,
	"visited_id" uuid NOT NULL,
	"visits" integer DEFAULT 1 NOT NULL,
	"last_visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_visits_visitor_id_visited_id_pk" PRIMARY KEY("visitor_id","visited_id")
);
--> statement-breakpoint
ALTER TABLE "profile_visits" ADD CONSTRAINT "profile_visits_visitor_id_users_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_visits" ADD CONSTRAINT "profile_visits_visited_id_users_id_fk" FOREIGN KEY ("visited_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_visits_visited" ON "profile_visits" USING btree ("visited_id","last_visited_at");