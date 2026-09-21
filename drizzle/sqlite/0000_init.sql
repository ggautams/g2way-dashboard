CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`action` text NOT NULL,
	`target` text,
	`before` text,
	`after` text,
	`gateway_method` text,
	`gateway_path` text,
	`gateway_status` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_org_created_idx` ON `audit_log` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_org_email_unique` ON `users` (`org_id`,`email`);