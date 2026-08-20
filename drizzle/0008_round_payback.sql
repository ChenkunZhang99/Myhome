CREATE TABLE `household_members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text DEFAULT '🙂' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meal_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`member_id` text NOT NULL,
	`desired_from` text,
	`desired_to` text,
	`meal_type` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT '想吃' NOT NULL,
	`servings` integer DEFAULT 2 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`scheduled_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_meal_requests_status_date` ON `meal_requests` (`status`,`scheduled_date`);--> statement-breakpoint
CREATE TABLE `recipe_activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text,
	`member_id` text,
	`action` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recipe_activity_log_created_at` ON `recipe_activity_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `recipe_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '家庭自建' NOT NULL,
	`icon` text DEFAULT '🍲' NOT NULL,
	`cook_time` text DEFAULT '30 分钟' NOT NULL,
	`difficulty` text DEFAULT '简单' NOT NULL,
	`servings` integer DEFAULT 2 NOT NULL,
	`ingredients_json` text DEFAULT '[]' NOT NULL,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`meal_types_json` text DEFAULT '[]' NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`is_custom` integer DEFAULT false NOT NULL,
	`cooked_count` integer DEFAULT 0 NOT NULL,
	`last_cooked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recipe_catalog_updated_at` ON `recipe_catalog` (`updated_at`);--> statement-breakpoint
CREATE TABLE `recipe_cook_history` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`request_id` text,
	`cooked_date` text NOT NULL,
	`meal_type` text DEFAULT '' NOT NULL,
	`servings` integer DEFAULT 2 NOT NULL,
	`cook_member_id` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recipe_cook_history_recipe_date` ON `recipe_cook_history` (`recipe_id`,`cooked_date`);--> statement-breakpoint
CREATE TABLE `recipe_ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`member_id` text NOT NULL,
	`rating` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recipe_ratings_recipe_id` ON `recipe_ratings` (`recipe_id`);
--> statement-breakpoint
PRAGMA optimize;
