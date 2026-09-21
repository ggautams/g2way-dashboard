CREATE TABLE `login_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_failures_lookup_idx` ON `login_failures` (`org_id`,`kind`,`key`,`created_at`);