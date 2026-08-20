CREATE TABLE `flyer_deals` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`item_name` text NOT NULL,
	`category` text DEFAULT '其他' NOT NULL,
	`price` real NOT NULL,
	`regular_price` real,
	`unit` text DEFAULT '件' NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_flyer_deals_valid_to` ON `flyer_deals` (`valid_to`);--> statement-breakpoint
CREATE TABLE `household_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`postal_code` text DEFAULT '' NOT NULL,
	`food_budget` real DEFAULT 0 NOT NULL,
	`household_budget` real DEFAULT 0 NOT NULL,
	`max_stores` integer DEFAULT 2 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shopping_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT '件' NOT NULL,
	`category` text DEFAULT '其他' NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_shopping_items_checked` ON `shopping_items` (`checked`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`is_favorite` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
