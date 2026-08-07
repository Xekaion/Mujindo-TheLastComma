/// <reference types="@cloudflare/workers-types" />

import economyTriggerSql from "./economy-triggers.sql?raw";

const TRIGGER_VERSION = "secure-market-triggers-v2";
const TRIGGER_MARKER_SUBJECT = "system:economy-schema";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export const economyTriggerStatements = economyTriggerSql
  .split(STATEMENT_BREAKPOINT)
  .map((statement) => statement.trim())
  .filter(Boolean);

const triggerNames = economyTriggerStatements.map((statement) => {
  const match = /^CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/i.exec(statement);
  if (!match) throw new Error("Invalid economy trigger definition.");
  return match[1];
});

if (new Set(triggerNames).size !== economyTriggerStatements.length) {
  throw new Error("Duplicate economy trigger definition.");
}

/**
 * Sites applies table/index migrations before the Worker starts. D1 trigger
 * bodies are then installed as individual prepared statements in one batch,
 * avoiding multi-statement migration parser ambiguity while preserving the
 * database-authoritative transaction boundary.
 */
export async function ensureEconomyTriggers(db: D1Database): Promise<void> {
  const installed = await db.prepare(
    `SELECT 1 AS ready FROM economy_rate_limits WHERE subject_key=? AND bucket=? LIMIT 1`,
  ).bind(TRIGGER_MARKER_SUBJECT, TRIGGER_VERSION).first<{ ready: number }>();
  if (installed?.ready === 1) return;

  const now = Date.now();
  await db.batch([
    ...economyTriggerStatements.map((statement) => db.prepare(statement)),
    db.prepare(`INSERT INTO economy_rate_limits(subject_key,bucket,window_started_at,request_count,blocked_until)
      VALUES(?,?,?,0,NULL)
      ON CONFLICT(subject_key,bucket) DO UPDATE SET window_started_at=excluded.window_started_at,request_count=0,blocked_until=NULL`)
      .bind(TRIGGER_MARKER_SUBJECT, TRIGGER_VERSION, now),
  ]);

  const placeholders = triggerNames.map(() => "?").join(",");
  const verified = await db.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`,
  ).bind(...triggerNames).first<{ count: number }>();
  if (Number(verified?.count ?? 0) !== triggerNames.length) {
    throw new Error("economy_trigger_install_incomplete");
  }
}
