// Regression tests for bugs found in the repo-wide scan. Each test names the bug it pins down.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.js";
import { FsBlobStore, MemoryBlobStore } from "../src/core/blobstore.js";
import { Store } from "../src/core/store.js";
import { createGraftServer } from "../src/server/http.js";
import { GraftClient } from "../src/client/api.js";
import { diffOps, merge3, splitLines } from "../src/core/diff.js";

let server: Server;
let url: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "graft-reg-"));
  const store = new Store(openDb(join(dir, "db.sqlite")), new FsBlobStore(join(dir, "blobs")));
  server = createGraftServer({ store });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const raw = async (method: string, path: string, body?: string) => {
  const r = await fetch(url + path, { method, body, headers: { "content-type": "application/json" } });
  return { status: r.status, json: await r.json().catch(() => null) };
};

function apply(a: string[], b: string[], ops: string[]) {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") {
      assert.equal(a[i], b[j]);
      out.push(a[i++]);
      j++;
    } else if (op === "-") i++;
    else out.push(b[j++]);
  }
  return out;
}

test("diff: huge dissimilar files no longer allocate O(D*(N+M)) memory", () => {
  const a = Array.from({ length: 60_000 }, (_, i) => `a${i}\n`);
  const b = Array.from({ length: 60_000 }, (_, i) => `b${i}\n`);
  const before = process.memoryUsage().rss;
  const t = Date.now();
  const ops = diffOps(a, b);
  assert.ok(Date.now() - t < 5000, "diff took too long");
  assert.ok(process.memoryUsage().rss - before < 400 * 1024 * 1024, "diff used too much memory");
  assert.deepEqual(apply(a, b, ops), b);
});

test("diff: randomized edit scripts reconstruct the target exactly", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: Math.floor(rnd() * 60) }, () => `${Math.floor(rnd() * 8)}\n`);
    const b = [...a];
    for (let k = Math.floor(rnd() * 10); k > 0; k--) {
      const pos = Math.floor(rnd() * (b.length + 1));
      if (rnd() < 0.5 && b.length) b.splice(pos, 1);
      else b.splice(pos, 0, `${Math.floor(rnd() * 8)}x\n`);
    }
    assert.deepEqual(apply(a, b, diffOps(a, b)), b);
  }
  // disjoint edits always merge cleanly and contain both sides
  const base = Array.from({ length: 40 }, (_, i) => `l${i}\n`).join("");
  const ours = base.replace("l3\n", "OURS\n");
  const theirs = base.replace("l30\n", "THEIRS\n");
  const m = merge3(base, ours, theirs);
  assert.ok(m.clean);
  assert.equal(splitLines(m.text).length, 40);
  assert.match(m.text, /OURS[\s\S]*THEIRS/);
});

test("http: malformed bodies and fields return 400, not 500", async () => {
  await raw("POST", "/api/repos", JSON.stringify({ name: "val" }));
  for (const body of ["null", "[]", '"x"', "{bad"]) {
    assert.equal((await raw("POST", "/api/repos/val/commit", body)).status, 400, body);
  }
  assert.equal((await raw("POST", "/api/repos", JSON.stringify({ name: 42 }))).status, 400);
  const bad = [
    { message: "m", changes: [{ path: 5, content: "x" }] },
    { message: "m", changes: [{ path: "a", content: 5 }] },
    { message: "m", changes: [null] },
    { message: "m", changes: [{ path: "a\nb", content: "x" }] },
    { message: "m", changes: [{ path: "a", edits: "nope" }] },
    { message: 7, changes: [{ path: "a", content: "x" }] },
  ];
  for (const b of bad) assert.equal((await raw("POST", "/api/repos/val/commit", JSON.stringify(b))).status, 400, JSON.stringify(b));
  assert.equal((await raw("GET", "/api/repos/%E0%A4%A/log")).status, 400);
  assert.equal((await raw("POST", "/api/blobs/upload", JSON.stringify({ blobs: [1] }))).status, 400);
});

test("http: commit defaults its base to the branch it lands on; reports per-file status", async () => {
  const c = new GraftClient({ url });
  await c.createRepo("rel");
  await c.setRef("rel", "release", "main");
  await c.commit("rel", { message: "on main", changes: [{ path: "x.txt", content: "main\n" }] });
  // x.txt does not exist on `release`, so an edit must be resolved against release, not main.
  const r = await c.commit("rel", { message: "rel file", changes: [{ path: "r.txt", content: "r\n" }], land: "release" });
  assert.equal(r.land.status, "landed");
  assert.deepEqual(r.files, [{ path: "r.txt", status: "added" }]);
  const t = await c.tree("rel", "release");
  assert.deepEqual(t.entries.map((e: any) => e.path), ["r.txt"]);
  // r.txt exists only on release: an edit landing on release must resolve against release (was: main → 422)
  const e = await c.commit("rel", { message: "edit rel", changes: [{ path: "r.txt", edits: [{ old: "r\n", new: "R\n" }] }], land: "release" });
  assert.equal(e.land.status, "landed");
  assert.equal((await c.file("rel", "r.txt", "release")).content, "R\n");
  const m = await c.commit("rel", { message: "mod", changes: [{ path: "x.txt", content: "2\n" }] });
  assert.deepEqual(m.files, [{ path: "x.txt", status: "modified" }]);
});

test("store: moves cannot double-claim a path; repo creation is atomic", () => {
  const s = new Store(openDb(":memory:"), new MemoryBlobStore());
  s.createRepo("m");
  assert.equal(s.getRepo("m").refs[0].name, "main");
  s.land("m", s.commit("m", { message: "i", changes: [{ path: "a", content: "1\n" }] }).id);
  assert.throws(() => s.commit("m", { message: "x", changes: [{ path: "b", from: "a" }, { path: "a", content: "2\n" }] }), /more than once/);
  assert.throws(() => s.commit("m", { message: "x", changes: [{ path: "a", from: "a" }] }), /same/);
  assert.throws(() => s.createRepo("m"), /exists/);
});

test("store: blame via path index matches across delete/re-create and many commits", () => {
  const s = new Store(openDb(":memory:"), new MemoryBlobStore());
  s.createRepo("b");
  const land = (msg: string, author: string, changes: any[]) => s.land("b", s.commit("b", { message: msg, author, changes }).id);
  land("v1", "old", [{ path: "f", content: "gone\n" }]);
  land("del", "x", [{ path: "f", delete: true }]);
  land("new", "alice", [{ path: "f", content: "a\nb\n" }]);
  for (let i = 0; i < 30; i++) land(`noise ${i}`, "noise", [{ path: `n${i}`, content: `${i}\n` }]);
  land("edit", "bob", [{ path: "f", edits: [{ old: "b\n", new: "B\n" }] }]);
  const bl = s.blame("b", "main", "f");
  assert.deepEqual(bl.lines.map((l) => bl.changesets[l.changeset].author), ["alice", "bob"]);
});

test("cli: racy-clean edit, noop commit, sparse overwrite guard, tracing", async () => {
  const cli = join(process.cwd(), "dist/src/cli/graft.js");
  const traceFile = join(dir, "trace.jsonl");
  const env = { ...process.env, GRAFT_URL: url, GRAFT_CACHE: join(dir, "cache"), GRAFT_TRACE: traceFile, GRAFT_AUTHOR: "tester" };
  const run = (cwd: string, ...args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" }, (err, stdout, stderr) =>
        resolve(err ? `EXIT ${err.code}\n${stdout}${stderr}` : stdout),
      ),
    );
  const c = new GraftClient({ url });
  await c.createRepo("ws");
  await c.commit("ws", { message: "seed", changes: [{ path: "src/a.txt", content: "AAAA\n" }, { path: "docs/d.txt", content: "doc\n" }] });

  // 1. racy clean: same size, same mtime, different content must still be detected
  await run(dir, "clone", "ws", "w1");
  const p = join(dir, "w1", "src/a.txt");
  const st = statSync(p);
  writeFileSync(p, "BBBB\n");
  utimesSync(p, st.atime, st.mtime);
  assert.match(await run(join(dir, "w1"), "status"), /M src\/a\.txt/);

  // 2. noop commit (identical change already landed by someone else) moves the workspace to head
  await run(dir, "clone", "ws", "w2");
  writeFileSync(join(dir, "w2", "src/a.txt"), "BBBB\n");
  assert.match(await run(join(dir, "w1"), "commit", "-m", "b"), /landed/);
  assert.match(await run(join(dir, "w2"), "commit", "-m", "same b"), /already landed/);
  const head = (await c.resolve("ws", "main")).changeset;
  const info = JSON.parse(await run(join(dir, "w2"), "info"));
  assert.equal(info.base, head);
  assert.match(await run(join(dir, "w2"), "status"), /clean/);

  // 3. sparse workspace: creating a file that exists upstream outside the sparse set is refused
  await run(dir, "clone", "ws", "w3", "--sparse", "src");
  writeFileSync(join(dir, "w3", "docs.txt"), "fine\n");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "w3", "docs"));
  writeFileSync(join(dir, "w3", "docs/d.txt"), "clobber\n");
  assert.match(await run(join(dir, "w3"), "commit", "-m", "x"), /already exists upstream outside your sparse paths/);
  assert.equal((await c.file("ws", "docs/d.txt")).content, "doc\n");

  // 4. tracing wrote one JSON line per command
  const lines = readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 8);
  assert.ok(lines.every((l) => l.system === "graft" && typeof l.ms === "number" && l.agent === "tester"));
  assert.ok(lines.some((l) => l.cmd === "commit" && l.ok === false));
});
