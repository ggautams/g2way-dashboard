CREATE TABLE "analytics_tail" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"environment" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"api_id" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"path_template" text NOT NULL,
	"status" integer NOT NULL,
	"latency_ms" bigint NOT NULL,
	"upstream_latency_ms" bigint,
	"key_hash" text,
	"key_alias" text,
	"request_bytes" bigint,
	"response_bytes" bigint
);
--> statement-breakpoint
CREATE INDEX "analytics_tail_env_at_idx" ON "analytics_tail" USING btree ("org_id","environment","at");