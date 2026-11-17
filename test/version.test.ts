import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../src/version.js";
import { openDb, schemaVersion, SCHEMA_VERSION } from "../src/core/db.js";

test("every version field agrees with src/version.ts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const plugin = JSON.parse(readFileSync("plugin/.claude-plugin/plugin.json", "utf8"));
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(plugin.version, VERSION);
  assert.match(readFileSync("CHANGELOG.md", "utf8"), new RegExp(`^## \\[(${VERSION.replace(/\./g, "\\.")}|Unreleased)\\]`, "m"));
});

test("schema: new databases are stamped; v0.1.0 databases are adopted; newer schemas are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-schema-"));
  assert.equal(schemaVersion(openDb(join(dir, "new.db"))), SCHEMA_VERSION);
  // A v0.1.0 database: tables exist, user_version 0.
  const legacy = new DatabaseSync(join(dir, "legacy.db"));
  legacy.exec("CREATE TABLE changesets (id TEXT PRIMARY KEY, repo TEXT, parent1 TEXT, parent2 TEXT, author TEXT, message TEXT, created_at TEXT, generation INTEGER, rebased_from TEXT, change_count INTEGER)");
  legacy.close();
  assert.equal(schemaVersion(openDb(join(dir, "legacy.db"))), SCHEMA_VERSION);
  const future = new DatabaseSync(join(dir, "future.db"));
  future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  future.close();
  assert.throws(() => openDb(join(dir, "future.db")), /newer than this Graft supports/);
});
