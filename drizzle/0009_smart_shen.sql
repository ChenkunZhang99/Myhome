CREATE TABLE `recipe_preferences` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`allergies` text DEFAULT '' NOT NULL,
	`avoid_foods` text DEFAULT '' NOT NULL,
	`dislikes` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
