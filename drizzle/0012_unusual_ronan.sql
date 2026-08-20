ALTER TABLE `inventory_items` ADD `remaining_percent` integer DEFAULT 100 NOT NULL;
--> statement-breakpoint
UPDATE `inventory_items` SET `remaining_percent` = 0 WHERE `quantity` <= 0 OR `level` = '已用完';
