CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`environment` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`name` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`query` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_owner_name_unique` ON `saved_views` (`org_id`,`environment`,`owner_id`,`name`);--> statement-breakpoint
CREATE INDEX `saved_views_env_shared_idx` ON `saved_views` (`org_id`,`environment`,`shared`);