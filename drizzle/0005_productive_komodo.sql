CREATE TABLE `flyer_sync_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_hours` integer DEFAULT 24 NOT NULL,
	`next_sync_at` text,
	`last_started_at` text,
	`last_completed_at` text,
	`last_status` text DEFAULT 'never' NOT NULL,
	`last_message` text DEFAULT '尚未自动同步' NOT NULL,
	`deals_imported` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `flyer_deals` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `flyer_deals` ADD `source_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `flyer_deals` ADD `source_fingerprint` text;--> statement-breakpoint
CREATE INDEX `idx_flyer_deals_store_source` ON `flyer_deals` (`store_id`,`source`);