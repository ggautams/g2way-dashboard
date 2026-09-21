-- Hand-edited (ADR-0006): `outcome` is NOT NULL with no default. Any rows written
-- before it existed (no release wrote any) are backfilled, then the default dropped.
ALTER TABLE "audit_log" ADD COLUMN "actor_role" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "outcome" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "outcome" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "note" text;
