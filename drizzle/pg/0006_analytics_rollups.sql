CREATE TABLE "analytics_ingest_state" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"environment" text NOT NULL,
	"records_ingested" bigint DEFAULT 0 NOT NULL,
	"records_rejected" bigint DEFAULT 0 NOT NULL,
	"batches" bigint DEFAULT 0 NOT NULL,
	"backlog" bigint DEFAULT 0 NOT NULL,
	"last_drained_at" timestamp with time zone,
	"last_record_at" timestamp with time zone,
	"last_rejection" text,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"environment" text NOT NULL,
	"bucket_seconds" integer NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"api_id" text NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"requests" bigint DEFAULT 0 NOT NULL,
	"status_1xx" bigint DEFAULT 0 NOT NULL,
	"status_2xx" bigint DEFAULT 0 NOT NULL,
	"status_3xx" bigint DEFAULT 0 NOT NULL,
	"status_4xx" bigint DEFAULT 0 NOT NULL,
	"status_5xx" bigint DEFAULT 0 NOT NULL,
	"latency_sum_ms" bigint DEFAULT 0 NOT NULL,
	"latency_max_ms" bigint DEFAULT 0 NOT NULL,
	"upstream_requests" bigint DEFAULT 0 NOT NULL,
	"upstream_latency_sum_ms" bigint DEFAULT 0 NOT NULL,
	"request_bytes" bigint DEFAULT 0 NOT NULL,
	"response_bytes" bigint DEFAULT 0 NOT NULL,
	"latency_le_1" bigint DEFAULT 0 NOT NULL,
	"latency_le_2" bigint DEFAULT 0 NOT NULL,
	"latency_le_5" bigint DEFAULT 0 NOT NULL,
	"latency_le_10" bigint DEFAULT 0 NOT NULL,
	"latency_le_25" bigint DEFAULT 0 NOT NULL,
	"latency_le_50" bigint DEFAULT 0 NOT NULL,
	"latency_le_100" bigint DEFAULT 0 NOT NULL,
	"latency_le_250" bigint DEFAULT 0 NOT NULL,
	"latency_le_500" bigint DEFAULT 0 NOT NULL,
	"latency_le_1000" bigint DEFAULT 0 NOT NULL,
	"latency_le_2500" bigint DEFAULT 0 NOT NULL,
	"latency_le_5000" bigint DEFAULT 0 NOT NULL,
	"latency_le_10000" bigint DEFAULT 0 NOT NULL,
	"latency_over" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_ingest_state_env_unique" ON "analytics_ingest_state" USING btree ("org_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_rollups_bucket_unique" ON "analytics_rollups" USING btree ("org_id","environment","bucket_seconds","bucket_start","api_id","dimension","value");--> statement-breakpoint
CREATE INDEX "analytics_rollups_drill_idx" ON "analytics_rollups" USING btree ("org_id","environment","bucket_seconds","dimension","api_id","bucket_start");