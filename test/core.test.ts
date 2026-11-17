import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.js";
import { MemoryBlobStore } from "../src/core/blobstore.js";
import { Store, globToRegex } from "../src/core/store.js";
import { merge3, unifiedDiff } from "../src/core/diff.js";

function fresh() {
  const s = new Store(openDb(":memory:"), new MemoryBlobStore());
  s.createRepo("demo");
  return s;
}
const text = (s: Store, path: string, rev = "main") => s.readFile("demo", rev, path).data.toString("utf8");

test("commit + fast-forward land", () => {
  const s = fresh();
  const c = s.commit("demo", { message: "add readme", changes: [{ path: "README.md", content: "hello\n" }] });
  const r = s.land("demo", c.id);
  assert.equal(r.status, "landed");
  assert.equal(r.rebased, false);
  assert.equal(text(s, "README.md"), "hello\n");
  assert.equal(s.changeset(c.id).changes.length, 1);
});

test("concurrent agents on different files auto-rebase", () => {
  const s = fresh();
  const base = s.getRef("demo", "main")!;
  const a = s.commit("demo", { base, message: "a", changes: [{ path: "a.txt", content: "A\n" }] });
  const b = s.commit("demo", { base, message: "b", changes: [{ path: "b.txt", content: "B\n" }] });
  assert.equal(s.land("demo", a.id).status, "landed");
  const rb = s.land("demo", b.id);
  assert.equal(rb.status, "landed");
  assert.equal(rb.rebased, true);
  assert.equal(text(s, "a.txt"), "A\n");
  assert.equal(text(s, "b.txt"), "B\n");
  assert.equal(s.changeset(rb.landed!).rebasedFrom, b.id);
});

test("same file, different lines merges cleanly; same lines conflict", () => {
  const s = fresh();
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("");
  s.land("demo", s.commit("demo", { message: "init", changes: [{ path: "f.txt", content: lines }] }).id);
  const base = s.getRef("demo", "main")!;
  const a = s.commit("demo", { base, message: "a", changes: [{ path: "f.txt", edits: [{ old: "line 1\n", new: "LINE ONE\n" }] }] });
  const b = s.commit("demo", { base, message: "b", changes: [{ path: "f.txt", edits: [{ old: "line 8\n", new: "LINE EIGHT\n" }] }] });
  const c = s.commit("demo", { base, message: "c", changes: [{ path: "f.txt", edits: [{ old: "line 1\n", new: "line uno\n" }] }] });
  assert.equal(s.land("demo", a.id).status, "landed");
  assert.equal(s.land("demo", b.id).status, "landed");
  assert.match(text(s, "f.txt"), /LINE ONE\n[\s\S]*LINE EIGHT\n/);
  const rc = s.land("demo", c.id);
  assert.equal(rc.status, "conflict");
  assert.equal(rc.conflicts![0].path, "f.txt");
  assert.match(rc.conflicts![0].merged!, /<<<<<<< branch[\s\S]*LINE ONE[\s\S]*=======\nline uno\n>>>>>>> change/);
  // Landing again is a no-op
  assert.equal(s.land("demo", a.id).status, "noop");
});

test("edits validation, moves and deletes", () => {
  const s = fresh();
  s.land("demo", s.commit("demo", { message: "init", changes: [{ path: "src/x.ts", content: "a\na\n" }] }).id);
  assert.throws(() => s.commit("demo", { message: "m", changes: [{ path: "src/x.ts", edits: [{ old: "a", new: "b" }] }] }), /matches 2 times/);
  assert.throws(() => s.commit("demo", { message: "m", changes: [{ path: "src/x.ts", edits: [{ old: "zzz", new: "b" }] }] }), /not found/);
  const mv = s.commit("demo", { message: "mv", changes: [{ path: "lib/y.ts", from: "src/x.ts" }] });
  s.land("demo", mv.id);
  assert.deepEqual(s.tree("demo", "main", "").map((e) => e.path), ["lib"]);
  assert.equal(text(s, "lib/y.ts"), "a\na\n");
  const del = s.commit("demo", { message: "rm", changes: [{ path: "lib/y.ts", delete: true }] });
  s.land("demo", del.id);
  assert.equal(s.tree("demo", "main", "").length, 0);
});

test("log, diff, blame, search, merge-base, rev~N", () => {
  const s = fresh();
  s.land("demo", s.commit("demo", { message: "one", author: "alice", changes: [{ path: "f", content: "x\ny\n" }] }).id);
  s.land("demo", s.commit("demo", { message: "two", author: "bob", changes: [{ path: "f", edits: [{ old: "y\n", new: "y\nz\n" }] }] }).id);
  const log = s.log("demo", "main", { path: "f" });
  assert.deepEqual(log.changesets.map((c) => c.message), ["two", "one"]);
  const d = s.diff("demo", "main");
  assert.equal(d.stat.added, 1);
  assert.match(d.files[0].patch!, /\+z/);
  const bl = s.blame("demo", "main", "f");
  assert.deepEqual(bl.lines.map((l) => bl.changesets[l.changeset].author), ["alice", "alice", "bob"]);
  // cached blame path
  const bl2 = s.blame("demo", "main", "f");
  assert.deepEqual(bl2.lines, bl.lines);
  assert.equal(s.search("demo", "main", "z").matches[0].line, 3);
  assert.equal(s.resolve("demo", "main~1"), log.changesets[1].id);
  const mb = s.mergeBase("demo", "main", "main~1");
  assert.equal(mb, log.changesets[1].id);
});

test("stacked drafts rebase together", () => {
  const s = fresh();
  const base = s.getRef("demo", "main")!;
  const c1 = s.commit("demo", { base, message: "c1", changes: [{ path: "a", content: "1\n" }] });
  const c2 = s.commit("demo", { base: c1.id, message: "c2", changes: [{ path: "a", content: "2\n" }] });
  s.land("demo", s.commit("demo", { base, message: "other", changes: [{ path: "b", content: "b\n" }] }).id);
  const r = s.land("demo", c2.id);
  assert.equal(r.status, "landed");
  assert.equal(text(s, "a"), "2\n");
  assert.equal(text(s, "b"), "b\n");
  assert.deepEqual(s.log("demo").changesets.slice(0, 3).map((c) => c.message), ["c2", "c1", "other"]);
});

test("manifest checkpoints survive cache loss", () => {
  const db = openDb(":memory:");
  const blobs = new MemoryBlobStore();
  const s = new Store(db, blobs);
  s.createRepo("demo");
  for (let i = 0; i < 140; i++) s.land("demo", s.commit("demo", { message: `c${i}`, changes: [{ path: `f${i % 7}`, content: `${i}\n` }] }).id);
  const s2 = new Store(db, blobs); // cold caches
  assert.equal(s2.readFile("demo", "main", "f6").data.toString(), "139\n");
  assert.equal(s2.tree("demo", "main").length, 7);
});

test("merge3 and diff basics", () => {
  assert.equal(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n").text, "A\nb\nC\n");
  assert.equal(merge3("a\n", "a\nx\n", "a\nx\n").text, "a\nx\n");
  assert.equal(merge3("a\n", "b\n", "c\n").clean, false);
  assert.equal(unifiedDiff("a\n", "b\n", "a/f", "b/f").patch, "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n");
  assert.ok(globToRegex("*.ts").test("src/deep/x.ts"));
  assert.ok(globToRegex("src/**/*.ts").test("src/x.ts"));
  assert.ok(!globToRegex("src/*.ts").test("src/a/x.ts"));
});
