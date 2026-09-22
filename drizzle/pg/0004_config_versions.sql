CREATE TABLE "config_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"environment" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"action" text NOT NULL,
	"definition" jsonb,
	"actor_id" text,
	"actor_email" text,
	"audit_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "config_versions_resource_idx" ON "config_versions" USING btree ("org_id","environment","kind","resource_id","created_at");