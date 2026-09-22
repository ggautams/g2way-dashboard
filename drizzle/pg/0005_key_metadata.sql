CREATE TABLE "key_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"environment" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text,
	"owner" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "key_metadata_key_unique" ON "key_metadata" USING btree ("org_id","environment","key_hash");