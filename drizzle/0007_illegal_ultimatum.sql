CREATE TABLE `recipe_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '库存优先' NOT NULL,
	`icon` text DEFAULT '🍲' NOT NULL,
	`cook_time` text DEFAULT '30 分钟' NOT NULL,
	`difficulty` text DEFAULT '简单' NOT NULL,
	`servings` integer DEFAULT 2 NOT NULL,
	`ingredients_json` text DEFAULT '[]' NOT NULL,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`favorited_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recipe_favorites_favorited_at` ON `recipe_favorites` (`favorited_at`);
--> statement-breakpoint
PRAGMA optimize;
