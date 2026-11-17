#!/usr/bin/env node
// Launches the Graft server. Node's built-in SQLite needs --experimental-sqlite on some versions
// (22.5–22.12, 23.0–23.3); newer releases have it unflagged. Detect instead of guessing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let needsFlag = false;
try {
  await import("node:sqlite");
} catch {
  needsFlag = true;
}
const main = join(dirname(fileURLToPath(import.meta.url)), "../dist/src/server/main.js");
const flags = needsFlag ? ["--experimental-sqlite", "--no-warnings"] : [];
const child = spawn(process.execPath, [...flags, main, ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
