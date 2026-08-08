CREATE TABLE `hub_character_slots` (
	`account_id` text NOT NULL,
	`slot` integer NOT NULL,
	`public_character_id` text NOT NULL,
	`level` integer NOT NULL,
	`appearance_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `slot`),
	CONSTRAINT "hub_character_slot_range" CHECK("hub_character_slots"."slot" BETWEEN 1 AND 3),
	CONSTRAINT "hub_character_level_range" CHECK("hub_character_slots"."level" BETWEEN 1 AND 999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hub_character_slots_public_character_id_unique` ON `hub_character_slots` (`public_character_id`);--> statement-breakpoint
CREATE TABLE `hub_rate_limits` (
	`account_id` text NOT NULL,
	`bucket` text NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer NOT NULL,
	`blocked_until` integer,
	PRIMARY KEY(`account_id`, `bucket`)
);
--> statement-breakpoint
CREATE TABLE `hub_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`account_id` text NOT NULL,
	`character_slot` integer NOT NULL,
	`public_character_id` text NOT NULL,
	`display_name` text NOT NULL,
	`level` integer NOT NULL,
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
	CONSTRAINT "hub_session_slot_range" CHECK("hub_sessions"."character_slot" BETWEEN 1 AND 3),
	CONSTRAINT "hub_session_level_range" CHECK("hub_sessions"."level" BETWEEN 1 AND 999),
	CONSTRAINT "hub_session_facing_range" CHECK("hub_sessions"."facing" BETWEEN 0 AND 7),
	CONSTRAINT "hub_session_moving_boolean" CHECK("hub_sessions"."moving" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hub_sessions_token_hash_unique` ON `hub_sessions` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `hub_sessions_account_id_unique` ON `hub_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `hub_sessions_presence` ON `hub_sessions` (`zone`,`last_seen_at`,`x`,`y`);