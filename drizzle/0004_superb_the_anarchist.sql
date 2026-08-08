PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hub_character_slots` (
	`account_id` text NOT NULL,
	`slot` integer NOT NULL,
	`public_character_id` text NOT NULL,
	`level` integer NOT NULL,
	`dungeon_floor` integer DEFAULT 1 NOT NULL,
	`appearance_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `slot`),
	CONSTRAINT "hub_character_slot_range" CHECK("__new_hub_character_slots"."slot" BETWEEN 1 AND 3),
	CONSTRAINT "hub_character_level_range" CHECK("__new_hub_character_slots"."level" BETWEEN 1 AND 999),
	CONSTRAINT "hub_character_dungeon_floor_range" CHECK("__new_hub_character_slots"."dungeon_floor" BETWEEN 1 AND 999999)
);
--> statement-breakpoint
INSERT INTO `__new_hub_character_slots`("account_id", "slot", "public_character_id", "level", "dungeon_floor", "appearance_json", "created_at", "updated_at") SELECT "account_id", "slot", "public_character_id", "level", 1, "appearance_json", "created_at", "updated_at" FROM `hub_character_slots`;--> statement-breakpoint
DROP TABLE `hub_character_slots`;--> statement-breakpoint
ALTER TABLE `__new_hub_character_slots` RENAME TO `hub_character_slots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `hub_character_slots_public_character_id_unique` ON `hub_character_slots` (`public_character_id`);--> statement-breakpoint
CREATE TABLE `__new_hub_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`account_id` text NOT NULL,
	`character_slot` integer NOT NULL,
	`public_character_id` text NOT NULL,
	`display_name` text NOT NULL,
	`level` integer NOT NULL,
	`dungeon_floor` integer DEFAULT 1 NOT NULL,
	`appearance_json` text NOT NULL,
	`zone` text DEFAULT 'memory-plaza-v1' NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`facing` integer NOT NULL,
	`moving` integer DEFAULT 0 NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	`last_move_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`,`character_slot`) REFERENCES `hub_character_slots`(`account_id`,`slot`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "hub_session_slot_range" CHECK("__new_hub_sessions"."character_slot" BETWEEN 1 AND 3),
	CONSTRAINT "hub_session_level_range" CHECK("__new_hub_sessions"."level" BETWEEN 1 AND 999),
	CONSTRAINT "hub_session_dungeon_floor_range" CHECK("__new_hub_sessions"."dungeon_floor" BETWEEN 1 AND 999999),
	CONSTRAINT "hub_session_facing_range" CHECK("__new_hub_sessions"."facing" BETWEEN 0 AND 7),
	CONSTRAINT "hub_session_moving_boolean" CHECK("__new_hub_sessions"."moving" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_hub_sessions`("id", "token_hash", "account_id", "character_slot", "public_character_id", "display_name", "level", "dungeon_floor", "appearance_json", "zone", "x", "y", "facing", "moving", "last_sequence", "last_move_at", "last_seen_at", "expires_at", "version", "created_at", "updated_at") SELECT "id", "token_hash", "account_id", "character_slot", "public_character_id", "display_name", "level", 1, "appearance_json", "zone", "x", "y", "facing", "moving", "last_sequence", "last_move_at", "last_seen_at", "expires_at", "version", "created_at", "updated_at" FROM `hub_sessions`;--> statement-breakpoint
DROP TABLE `hub_sessions`;--> statement-breakpoint
ALTER TABLE `__new_hub_sessions` RENAME TO `hub_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `hub_sessions_token_hash_unique` ON `hub_sessions` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `hub_sessions_account_id_unique` ON `hub_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `hub_sessions_presence` ON `hub_sessions` (`zone`,`last_seen_at`,`x`,`y`);
