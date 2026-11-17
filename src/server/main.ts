import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openDb } from "../core/db.js";
import { FsBlobStore } from "../core/blobstore.js";
import { Store } from "../core/store.js";
import { createGraftServer } from "./http.js";
import { VERSION } from "../version.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.GRAFT_DATA ?? "./graft-data");
const port = parseInt(process.env.PORT ?? process.env.GRAFT_PORT ?? "7070", 10);
// Secure by default: loopback only. Listening on other interfaces requires a token (or an explicit opt-out).
const host = process.env.GRAFT_HOST ?? "127.0.0.1";
const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
const token = process.env.GRAFT_TOKEN || undefined;
const readToken = process.env.GRAFT_READ_TOKEN || undefined;
if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (!loopback && !token && process.env.GRAFT_ALLOW_OPEN !== "1") {
  console.error(
    `refusing to listen on ${host} without authentication.\n` +
      `  Set GRAFT_TOKEN (recommended), or GRAFT_ALLOW_OPEN=1 to serve an open server on a trusted network.`,
  );
  process.exit(2);
}
if (token && token.length < 16) {
  console.error("GRAFT_TOKEN must be at least 16 characters (try: openssl rand -hex 32)");
  process.exit(2);
}
const allowedHosts = process.env.GRAFT_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
const webRoot = [process.env.GRAFT_WEB_ROOT, join(here, "../../../web"), resolve("web")]
  .filter((p): p is string => !!p)
  .find((p) => existsSync(join(p, "index.html")));

const store = new Store(openDb(join(dataDir, "graft.db")), new FsBlobStore(join(dataDir, "blobs")));
const quiet = process.env.GRAFT_QUIET === "1";
const server = createGraftServer({
  store,
  token,
  readToken,
  allowedHosts,
  version: VERSION,
  maxJsonBytes: process.env.GRAFT_MAX_JSON_BYTES ? parseInt(process.env.GRAFT_MAX_JSON_BYTES, 10) : undefined,
  maxBodyBytes: process.env.GRAFT_MAX_BLOB_BYTES ? parseInt(process.env.GRAFT_MAX_BLOB_BYTES, 10) : undefined,
  webRoot,
  log: quiet ? undefined : (l) => console.log(new Date().toISOString(), l),
});

server.listen(port, host, () => {
  console.log(`graft server v${VERSION} listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`  data: ${dataDir}`);
  console.log(`  auth: ${process.env.GRAFT_TOKEN ? "bearer token required" : process.env.GRAFT_READ_TOKEN ? "read token only" : "OPEN (set GRAFT_TOKEN to require auth)"}`);
  if (process.env.GRAFT_READ_TOKEN && !process.env.GRAFT_TOKEN) {
    console.warn("  warning: GRAFT_READ_TOKEN is set without GRAFT_TOKEN, so every write will be rejected");
  }
  if (webRoot) console.log(`  web viewer: http://localhost:${port}/`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
