CREATE TABLE `analytics_ingest_state` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`environment` text NOT NULL,
	`records_ingested` integer DEFAULT 0 NOT NULL,
	`records_rejected` integer DEFAULT 0 NOT NULL,
	`batches` integer DEFAULT 0 NOT NULL,
	`backlog` integer DEFAULT 0 NOT NULL,
	`last_drained_at` integer,
	`last_record_at` integer,
	`last_rejection` text,
	`last_error` text,
	`last_error_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_ingest_state_env_unique` ON `analytics_ingest_state` (`org_id`,`environment`);--> statement-breakpoint
CREATE TABLE `analytics_rollups` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`environment` text NOT NULL,
	`bucket_seconds` integer NOT NULL,
	`bucket_start` integer NOT NULL,
	`api_id` text NOT NULL,
	`dimension` text NOT NULL,
	`value` text NOT NULL,
	`label` text,
	`requests` integer DEFAULT 0 NOT NULL,
	`status_1xx` integer DEFAULT 0 NOT NULL,
	`status_2xx` integer DEFAULT 0 NOT NULL,
	`status_3xx` integer DEFAULT 0 NOT NULL,
	`status_4xx` integer DEFAULT 0 NOT NULL,
	`status_5xx` integer DEFAULT 0 NOT NULL,
	`latency_sum_ms` integer DEFAULT 0 NOT NULL,
	`latency_max_ms` integer DEFAULT 0 NOT NULL,
	`upstream_requests` integer DEFAULT 0 NOT NULL,
	`upstream_latency_sum_ms` integer DEFAULT 0 NOT NULL,
	`request_bytes` integer DEFAULT 0 NOT NULL,
	`response_bytes` integer DEFAULT 0 NOT NULL,
	`latency_le_1` integer DEFAULT 0 NOT NULL,
	`latency_le_2` integer DEFAULT 0 NOT NULL,
	`latency_le_5` integer DEFAULT 0 NOT NULL,
	`latency_le_10` integer DEFAULT 0 NOT NULL,
	`latency_le_25` integer DEFAULT 0 NOT NULL,
	`latency_le_50` integer DEFAULT 0 NOT NULL,
	`latency_le_100` integer DEFAULT 0 NOT NULL,
	`latency_le_250` integer DEFAULT 0 NOT NULL,
	`latency_le_500` integer DEFAULT 0 NOT NULL,
	`latency_le_1000` integer DEFAULT 0 NOT NULL,
	`latency_le_2500` integer DEFAULT 0 NOT NULL,
	`latency_le_5000` integer DEFAULT 0 NOT NULL,
	`latency_le_10000` integer DEFAULT 0 NOT NULL,
	`latency_over` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_rollups_bucket_unique` ON `analytics_rollups` (`org_id`,`environment`,`bucket_seconds`,`bucket_start`,`api_id`,`dimension`,`value`);--> statement-breakpoint
CREATE INDEX `analytics_rollups_drill_idx` ON `analytics_rollups` (`org_id`,`environment`,`bucket_seconds`,`dimension`,`api_id`,`bucket_start`);