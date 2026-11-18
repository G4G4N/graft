import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.js";
import { MemoryBlobStore } from "../src/core/blobstore.js";
import { Store } from "../src/core/store.js";
import { GraftError } from "../src/core/types.js";
import { createGraftServer } from "../src/server/http.js";
import { loadExtensions, type GraftEvent, type GraftExtension } from "../src/server/extensions.js";

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
function call(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const u = new URL(base + path);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const r = httpRequest(
      { host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : null }));
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function setup() {
  const events: GraftEvent[] = [];
  const users: Record<string, { name: string; roles: string[] }> = {
    "tok-alice": { name: "alice", roles: ["admin"] },
    "tok-rita": { name: "rita", roles: ["read"] },
  };
  const ext: GraftExtension = {
    name: "test-identities",
    authenticate(req) {
      const t = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!t) return null;
      const u = users[t];
      if (!u) throw new GraftError(401, "unknown token");
      return { name: u.name, roles: u.roles };
    },
    authorize(identity, action) {
      if (!identity) return action === "read";
      if (identity.roles?.includes("admin")) return true;
      return action === "read";
    },
    onEvent(ev) {
      events.push(ev);
    },
  };
  const store = new Store(openDb(":memory:"), new MemoryBlobStore());
  return { server: createGraftServer({ store, extensions: [ext] }), events };
}

test("extensions: identity sets the author, overriding a spoofed header", async () => {
  const { server, events } = setup();
  const url = await listen(server);
  const alice = { authorization: "Bearer tok-alice" };
  assert.equal((await call(url, "POST", "/api/repos", alice, { name: "x" })).status, 200);
  const r = await call(url, "POST", "/api/repos/x/commit", { ...alice, "x-graft-author": "mallory" }, { message: "m", changes: [{ path: "a", content: "1" }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.changeset.author, "alice");
  assert.deepEqual(events.map((e) => e.type), ["repo.created", "changeset.created", "branch.landed"]);
  assert.ok(events.every((e) => e.actor === "alice" && typeof e.at === "string"));
  assert.equal(events[2].data.branch, "main");
  server.close();
});

test("extensions: authorize denies by role and reports access.denied", async () => {
  const { server, events } = setup();
  const url = await listen(server);
  await call(url, "POST", "/api/repos", { authorization: "Bearer tok-alice" }, { name: "x" });
  const rita = { authorization: "Bearer tok-rita" };
  assert.equal((await call(url, "GET", "/api/repos/x/log", rita)).status, 200);
  const w = await call(url, "POST", "/api/repos/x/commit", rita, { message: "m", changes: [{ path: "a", content: "1" }] });
  assert.equal(w.status, 403);
  const d = events.find((e) => e.type === "access.denied");
  assert.ok(d);
  assert.equal(d!.actor, "rita");
  assert.equal(d!.repo, "x");
  assert.equal(d!.data.action, "write");
  // Anonymous callers fall through to authorize with identity null; unknown tokens are rejected outright.
  assert.equal((await call(url, "POST", "/api/repos", {}, { name: "y" })).status, 403);
  assert.equal((await call(url, "GET", "/api/repos", { authorization: "Bearer nope" })).status, 401);
  // Probes stay public.
  assert.equal((await call(url, "GET", "/api/version", { authorization: "Bearer nope" })).status, 200);
  server.close();
});

test("extensions: an authentication extension relaxes the loopback-only host rule", async () => {
  const { server } = setup();
  const url = await listen(server);
  assert.equal((await call(url, "GET", "/api/repos", { host: "graft.example.com", authorization: "Bearer tok-alice" })).status, 200);
  server.close();
});

test("extensions: loaded from modules (object or factory default export)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ext-"));
  writeFileSync(join(dir, "obj.mjs"), `export default { name: "obj", onEvent() {} };`);
  writeFileSync(join(dir, "factory.mjs"), `export default async () => ({ name: "factory" });`);
  writeFileSync(join(dir, "bad.mjs"), `export default 42;`);
  const exts = await loadExtensions([join(dir, "obj.mjs"), " ", join(dir, "factory.mjs")]);
  assert.deepEqual(exts.map((e) => e.name), ["obj", "factory"]);
  await assert.rejects(loadExtensions([join(dir, "bad.mjs")]), /does not export a Graft extension/);
});
