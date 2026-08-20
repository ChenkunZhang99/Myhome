CREATE TABLE `inventory_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_inventory_attachments_item_id` ON `inventory_attachments` (`item_id`);