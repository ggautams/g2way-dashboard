CREATE TABLE `analytics_tail` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`environment` text NOT NULL,
	`at` integer NOT NULL,
	`api_id` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`path_template` text NOT NULL,
	`status` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`upstream_latency_ms` integer,
	`key_hash` text,
	`key_alias` text,
	`request_bytes` integer,
	`response_bytes` integer
);
--> statement-breakpoint
CREATE INDEX `analytics_tail_env_at_idx` ON `analytics_tail` (`org_id`,`environment`,`at`);