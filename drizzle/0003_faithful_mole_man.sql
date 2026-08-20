ALTER TABLE `stores` ADD `source_key` text;--> statement-breakpoint
ALTER TABLE `stores` ADD `flyer_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `stores` ADD `flyer_format` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `stores` ADD `last_synced_at` text;--> statement-breakpoint
CREATE INDEX `idx_stores_source_key` ON `stores` (`source_key`);--> statement-breakpoint
INSERT OR IGNORE INTO `stores` (`id`, `name`, `address`, `source_key`, `flyer_url`, `flyer_format`)
VALUES ('store-hmart-coquitlam', 'H Mart Coquitlam', '#100 - 329 North Rd, Coquitlam, BC V3K 3V8', 'hmart-coquitlam', 'https://hmart.ca/index.php?pn=flyer', 'pdf');--> statement-breakpoint
INSERT OR IGNORE INTO `stores` (`id`, `name`, `address`, `source_key`, `flyer_url`, `flyer_format`)
VALUES ('store-pricesmart-lougheed', 'PriceSmart Foods Lougheed', '9899 Austin Rd, Burnaby, BC V3J 1N4', 'pricesmart-lougheed', 'https://www.pricesmartfoods.com/sm/pickup/rsid/2280/weekly-specials', 'catalog');--> statement-breakpoint
INSERT OR IGNORE INTO `stores` (`id`, `name`, `address`, `source_key`, `flyer_url`, `flyer_format`)
VALUES ('store-walmart-lougheed', 'Walmart Supercentre Lougheed', '9855 Austin Rd, Burnaby, BC V3J 1N5', 'walmart-lougheed', 'https://www.walmart.ca/en/flyer', 'dynamic');
