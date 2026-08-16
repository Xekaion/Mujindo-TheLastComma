ALTER TABLE `hub_character_slots` ADD `nickname` text;--> statement-breakpoint
ALTER TABLE `hub_character_slots` ADD `nickname_key` text;--> statement-breakpoint
ALTER TABLE `hub_character_slots` ADD `nickname_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `hub_character_slots` ADD `identity_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `hub_character_nickname_key` ON `hub_character_slots` (`nickname_key`) WHERE "hub_character_slots"."nickname_key" IS NOT NULL;--> statement-breakpoint
DELETE FROM `hub_sessions`;
