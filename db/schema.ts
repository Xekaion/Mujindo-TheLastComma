import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The polling realtime coordinator deliberately uses one compare-and-swap row.
 * Keeping the world in a single JSON document makes queueing, matchmaking,
 * combat simulation, and announcements commit atomically in D1.
 */
export const realtimeWorldState = sqliteTable("realtime_world_state", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull().default(0),
  stateJson: text("state_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
