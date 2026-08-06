CREATE TABLE `realtime_world_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
