ALTER TABLE `recipe_cook_history` ADD `consumption_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `shopping_items` ADD `stocked` integer DEFAULT false NOT NULL;