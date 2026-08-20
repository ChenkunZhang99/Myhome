CREATE TABLE `recipe_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recipe_attachments_recipe_id` ON `recipe_attachments` (`recipe_id`);