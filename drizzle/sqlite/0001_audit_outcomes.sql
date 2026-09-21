-- Hand-edited (ADR-0006): SQLite cannot ADD a NOT NULL column without a default,
-- so audit_log is rebuilt. No release ever wrote audit rows, but any that exist
-- are kept, marked as recorded before outcomes were tracked.
CREATE TABLE `__new_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`actor_role` text,
	`action` text NOT NULL,
	`target` text,
	`before` text,
	`after` text,
	`gateway_method` text,
	`gateway_path` text,
	`gateway_status` integer,
	`environment` text,
	`request` text,
	`outcome` text NOT NULL,
	`error` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_audit_log` (`id`, `org_id`, `actor_id`, `actor_email`, `action`, `target`, `before`, `after`, `gateway_method`, `gateway_path`, `gateway_status`, `outcome`, `note`, `created_at`)
	SELECT `id`, `org_id`, `actor_id`, `actor_email`, `action`, `target`, `before`, `after`, `gateway_method`, `gateway_path`, `gateway_status`, 'success', 'recorded before outcomes were tracked', `created_at` FROM `audit_log`;
--> statement-breakpoint
DROP TABLE `audit_log`;
--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;
--> statement-breakpoint
CREATE INDEX `audit_log_org_created_idx` ON `audit_log` (`org_id`,`created_at`);
