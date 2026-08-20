CREATE TABLE `flyer_deal_metadata` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`item_key` text DEFAULT '' NOT NULL,
	`package_quantity` real,
	`package_unit` text DEFAULT '' NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`verified_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`is_saved` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `flyer_match_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`inventory_name` text NOT NULL,
	`deal_pattern` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`match_kind` text DEFAULT 'substitute' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_flyer_match_rules_pattern` ON `flyer_match_rules` (`deal_pattern`,`active`);--> statement-breakpoint
CREATE TABLE `flyer_price_history` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`store_id` text NOT NULL,
	`item_key` text NOT NULL,
	`item_name` text NOT NULL,
	`price` real NOT NULL,
	`regular_price` real,
	`unit` text DEFAULT '件' NOT NULL,
	`package_quantity` real,
	`package_unit` text DEFAULT '' NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text NOT NULL,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_flyer_price_history_item_store` ON `flyer_price_history` (`item_key`,`store_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_flyer_price_history_deal` ON `flyer_price_history` (`deal_id`);--> statement-breakpoint
CREATE TABLE `flyer_recommendation_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` text,
	`item_pattern` text DEFAULT '' NOT NULL,
	`store_id` text,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_flyer_feedback_action_pattern` ON `flyer_recommendation_feedback` (`action`,`item_pattern`);