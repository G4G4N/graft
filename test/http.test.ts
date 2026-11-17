import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.js";
import { FsBlobStore } from "../src/core/blobstore.js";
import { Store } from "../src/core/store.js";
import { createGraftServer } from "../src/server/http.js";
import { GraftClient } from "../src/client/api.js";

let server: Server;
let url: string;
let dir: string;
const TOKEN = "test-token";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "graft-test-"));
  const store = new Store(openDb(join(dir, "db.sqlite")), new FsBlobStore(join(dir, "blobs")));
  server = createGraftServer({ store, token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("auth is enforced", async () => {
  const anon = new GraftClient({ url });
  await assert.rejects(anon.listRepos(), /bearer token/);
  assert.equal((await anon.health()).ok, true);
});

test("50 concurrent agents committing to one repo all land", async () => {
  const c = new GraftClient({ url, token: TOKEN });
  await c.createRepo("swarm");
  const shared = Array.from({ length: 50 }, (_, i) => `slot ${i}\n`).join("");
  await c.commit("swarm", { message: "init", changes: [{ path: "shared.txt", content: shared }] });
  const base = (await c.resolve("swarm", "main")).changeset;
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      new GraftClient({ url, token: TOKEN, author: `agent-${i}` }).commit("swarm", {
        base,
        message: `agent ${i}`,
        changes: [
          { path: `agents/${i}.txt`, content: `hello from ${i}\n` },
          { path: "shared.txt", edits: [{ old: `slot ${i}\n`, new: `slot ${i} done by agent-${i}\n` }] },
        ],
      }),
    ),
  );
  assert.ok(results.every((r) => r.land.status === "landed"), JSON.stringify(results.find((r) => r.land.status !== "landed")?.land));
  const f = await c.file("swarm", "shared.txt");
  for (let i = 0; i < 50; i++) assert.ok(f.content.includes(`slot ${i} done by agent-${i}\n`));
  const t = await c.tree("swarm", "main", "agents");
  assert.equal(t.entries.length, 50);
  const log = await c.log("swarm", "main", undefined, 100);
  assert.equal(log.changesets.length, 52);
});

test("CLI: clone, edit, commit, conflict, resolve", async () => {
  const cli = join(process.cwd(), "dist/src/cli/graft.js");
  const env = { ...process.env, GRAFT_URL: url, GRAFT_TOKEN: TOKEN, GRAFT_CACHE: join(dir, "cache") };
  // Async: the server under test runs in this same process, so blocking would deadlock.
  const run = (cwd: string, ...args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" }, (err, stdout, stderr) =>
        resolve(err ? `EXIT ${err.code}\n${stdout}${stderr}` : stdout),
      ),
    );
  await run(dir, "create", "cli-repo");
  await run(dir, "clone", "cli-repo", "w1");
  await run(dir, "clone", "cli-repo", "w2");
  const w1 = join(dir, "w1");
  const w2 = join(dir, "w2");
  writeFileSync(join(w1, "a.txt"), "one\n");
  assert.match(await run(w1, "status"), /A a\.txt/);
  assert.match(await run(w1, "commit", "-m", "add a"), /landed/);
  writeFileSync(join(w2, "a.txt"), "two\n"); // add-add conflict
  const out = await run(w2, "commit", "-m", "add a too");
  assert.match(out, /CONFLICT/);
  assert.match(readFileSync(join(w2, "a.txt"), "utf8"), /<<<<<<< local/);
  assert.match(await run(w2, "commit", "-m", "x"), /conflict markers/);
  writeFileSync(join(w2, "a.txt"), "one\ntwo\n");
  assert.match(await run(w2, "commit", "-m", "resolve"), /landed/);
  assert.match(await run(w1, "sync"), /1 file\(s\) updated/);
  assert.equal(readFileSync(join(w1, "a.txt"), "utf8"), "one\ntwo\n");
  assert.ok(existsSync(join(w1, ".graft", "index.json")));
});
