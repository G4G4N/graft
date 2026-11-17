import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Changesets are the write-ahead log: immutable, content-addressed, first-parent relative.
CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  parent1 TEXT,
  parent2 TEXT,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  generation INTEGER NOT NULL,
  rebased_from TEXT,
  change_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changesets_repo_gen ON changesets(repo, generation);

CREATE TABLE IF NOT EXISTS changes (
  changeset_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT,
  PRIMARY KEY (changeset_id, path)
);
CREATE INDEX IF NOT EXISTS changes_repo_path ON changes(repo, path);

-- Refs move only by compare-and-swap on a single row; creating a changeset never touches refs.
CREATE TABLE IF NOT EXISTS refs (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);

-- Derived data (manifest checkpoints, blame) keyed by immutable inputs; safe to drop and recompute.
CREATE TABLE IF NOT EXISTS derived (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
`;

/**
 * Schema versioning. The database records its schema version in `PRAGMA user_version`.
 * To change the schema: append a migration (SQL run inside a transaction) and bump SCHEMA_VERSION.
 * Migrations run automatically on startup; a database written by a newer Graft is refused.
 */
export const SCHEMA_VERSION = 1;
const MIGRATIONS: Record<number, string> = {
  1: SCHEMA, // initial schema
};

export class SchemaTooNewError extends Error {}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
  migrate(db);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function migrate(db: DatabaseSync) {
  let current = schemaVersion(db);
  if (current === 0) {
    // Databases created by v0.1.0 predate versioning but have the v1 schema.
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'changesets'").get();
    if (existing) {
      db.exec(SCHEMA); // idempotent (IF NOT EXISTS)
      db.exec("PRAGMA user_version = 1");
      current = 1;
    }
  }
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNewError(
      `database schema v${current} is newer than this Graft supports (v${SCHEMA_VERSION}); upgrade Graft instead of downgrading`,
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export type Db = DatabaseSync;
