CREATE TABLE IF NOT EXISTS `economy_listing_expiry_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `economy_listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `economy_listing_expiry_listing` ON `economy_listing_expiry_commands` (`listing_id`);
