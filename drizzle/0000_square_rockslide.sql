CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`location` text DEFAULT '未分类' NOT NULL,
	`precision` text DEFAULT 'quantity' NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT '件' NOT NULL,
	`level` text DEFAULT '充足' NOT NULL,
	`expiry_date` text,
	`note` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
