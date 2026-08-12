/// <reference types="@cloudflare/workers-types" />

import secureMarketSql from "../drizzle/0001_secure_market.sql?raw";
import listingExpirySql from "../drizzle/0002_loud_major_mapleleaf.sql?raw";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * Sites applies numbered migrations before publishing. Vinext's local
 * Cloudflare preview only creates the D1 binding, so a fresh local database
 * otherwise has no economy tables. Local recovery is sourced from the exact
 * production migrations; remote databases remain fail-closed.
 */
export const economySchemaStatements = [secureMarketSql, listingExpirySql]
  .flatMap((source) => source.split(STATEMENT_BREAKPOINT))
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0 && !/^PRAGMA\s/i.test(statement));

for (const statement of economySchemaStatements) {
  if (!/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement)) {
    throw new Error("Local economy bootstrap contains a non-idempotent statement.");
  }
}

type EconomySchemaObject = { type: "table" | "index"; name: string };

export const economySchemaObjects = economySchemaStatements
  .map<EconomySchemaObject | null>((statement) => {
    const match = /^CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\s+[`\"]?([A-Za-z0-9_]+)[`\"]?/i.exec(statement);
    if (!match) return null;
    return {
      type: match[1].toUpperCase() === "TABLE" ? "table" : "index",
      name: match[2],
    };
  })
  .filter((object): object is EconomySchemaObject => object !== null);

export const economySchemaTableNames = economySchemaObjects
  .filter((object) => object.type === "table")
  .map((object) => object.name);

const duplicateTableNames = economySchemaTableNames.filter(
  (name, index) => economySchemaTableNames.indexOf(name) !== index,
);
if (duplicateTableNames.some((name) => name !== "economy_listing_expiry_commands")) {
  throw new Error("Unexpected duplicate economy table definition.");
}

const requiredSchemaObjects = [...new Map(
  economySchemaObjects.map((object) => [`${object.type}:${object.name}`, object]),
).values()];
const schemaReady = new WeakMap<object, Promise<void>>();

export class EconomySchemaMissingError extends Error {
  constructor(readonly missingObjects: readonly string[]) {
    super(`Missing economy schema objects: ${missingObjects.join(", ")}`);
    this.name = "EconomySchemaMissingError";
  }
}

async function missingEconomySchemaObjects(db: D1Database): Promise<string[]> {
  const objectNames = requiredSchemaObjects.map((object) => object.name);
  const placeholders = objectNames.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT type,name FROM sqlite_master WHERE type IN ('table','index') AND name IN (${placeholders})`,
  ).bind(...objectNames).all<{ type: string; name: string }>();
  const present = new Set((result.results ?? []).map((row) => `${row.type}:${row.name}`));
  return requiredSchemaObjects
    .map((object) => `${object.type}:${object.name}`)
    .filter((key) => !present.has(key));
}

export function resetEconomySchemaReadiness(db: D1Database): void {
  schemaReady.delete(db as object);
}

export async function ensureEconomySchema(
  db: D1Database,
  options: { allowLocalBootstrap: boolean },
): Promise<void> {
  const existing = schemaReady.get(db as object);
  if (existing) return existing;

  const setup = (async () => {
    let missing = await missingEconomySchemaObjects(db);
    if (missing.length === 0) return;
    if (!options.allowLocalBootstrap) throw new EconomySchemaMissingError(missing);

    await db.batch(economySchemaStatements.map((statement) => db.prepare(statement)));
    missing = await missingEconomySchemaObjects(db);
    if (missing.length > 0) throw new EconomySchemaMissingError(missing);
  })().catch((error: unknown) => {
    schemaReady.delete(db as object);
    throw error;
  });

  schemaReady.set(db as object, setup);
  return setup;
}
