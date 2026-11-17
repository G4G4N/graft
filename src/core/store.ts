import type { StatementSync } from "node:sqlite";
import type { BlobStore } from "./blobstore.js";
import type { Db } from "./db.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isBinary, merge3, splitLines, unifiedDiff, diffOps } from "./diff.js";
import { globToRegex } from "./glob.js";
import { normalizePath } from "./paths.js";
export { normalizePath };
export { globToRegex };
import {
  type ChangeInput,
  type Changeset,
  type Conflict,
  type FileChange,
  type LandResult,
  GraftError,
} from "./types.js";

export type Manifest = Map<string, string>;

const CHECKPOINT_EVERY = 64;
const DEFAULT_BRANCH = "main";

function validRepoName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    throw new GraftError(400, "repo name must be 1-100 chars of letters, digits, . _ - and start with a letter/digit");
  }
}

function validRefName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) || name.includes("..") || name.includes("~")) {
    throw new GraftError(400, `invalid ref name: ${name}`);
  }
}

interface CsRow {
  id: string;
  repo: string;
  parent1: string | null;
  parent2: string | null;
  author: string;
  message: string;
  created_at: string;
  generation: number;
  rebased_from: string | null;
  change_count: number;
}

export interface CommitOptions {
  /** Revision the change is based on (default: tip of main). */
  base?: string;
  changes: ChangeInput[];
  message: string;
  author?: string;
  /** Optional second parent (records a merge). */
  mergeParent?: string;
  allowEmpty?: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  blob?: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  oldBlob: string | null;
  newBlob: string | null;
  binary: boolean;
  added: number;
  removed: number;
  patch?: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * The authoritative repository store. All history, merges and rebases happen here,
 * so clients never need the full history locally.
 */
export class Store {
  private manifestCache = new Map<string, Manifest>();
  private csCache = new Map<string, Changeset>();
  private st: Record<string, StatementSync>;

  constructor(private db: Db, readonly blobs: BlobStore) {
    const p = (sql: string) => db.prepare(sql);
    this.st = {
      insertRepo: p("INSERT INTO repos(name, description, created_at) VALUES (?, ?, ?)"),
      getRepo: p("SELECT * FROM repos WHERE name = ?"),
      listRepos: p("SELECT * FROM repos ORDER BY name"),
      insertCs: p(
        "INSERT OR IGNORE INTO changesets(id, repo, parent1, parent2, author, message, created_at, generation, rebased_from, change_count) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ),
      insertChange: p("INSERT OR IGNORE INTO changes(changeset_id, repo, path, blob) VALUES (?,?,?,?)"),
      getCs: p("SELECT * FROM changesets WHERE id = ?"),
      getChanges: p("SELECT path, blob FROM changes WHERE changeset_id = ? ORDER BY path"),
      csByPrefix: p("SELECT id FROM changesets WHERE repo = ? AND id >= ? AND id < ? LIMIT 2"),
      getRef: p("SELECT * FROM refs WHERE repo = ? AND name = ?"),
      listRefs: p("SELECT name, target, version, updated_at FROM refs WHERE repo = ? ORDER BY name"),
      insertRef: p("INSERT OR IGNORE INTO refs(repo, name, target, version, updated_at) VALUES (?,?,?,1,?)"),
      casRef: p("UPDATE refs SET target = ?, version = version + 1, updated_at = ? WHERE repo = ? AND name = ? AND target = ?"),
      deleteRef: p("DELETE FROM refs WHERE repo = ? AND name = ? AND target = ?"),
      getDerived: p("SELECT value FROM derived WHERE kind = ? AND key = ?"),
      putDerived: p("INSERT OR REPLACE INTO derived(kind, key, value) VALUES (?,?,?)"),
      touching: p("SELECT changeset_id FROM changes WHERE repo = ? AND (path = ? OR (path >= ? AND path < ?))"),
      touchingExact: p("SELECT changeset_id FROM changes WHERE repo = ? AND path = ?"),
      countCs: p("SELECT COUNT(*) AS n FROM changesets WHERE repo = ?"),
    };
  }

  // ---------------------------------------------------------------- repos & refs

  createRepo(name: string, description = "", author = "graft"): { name: string; head: string } {
    validRepoName(name);
    if (this.st.getRepo.get(name)) throw new GraftError(409, `repo already exists: ${name}`);
    const now = new Date().toISOString();
    let head = "";
    // One transaction: a crash can never leave a repo without its root changeset or main ref.
    this.tx(() => {
      this.st.insertRepo.run(name, String(description ?? "").slice(0, 1000), now);
      head = this.writeChangeset(name, [], author, "Create repository", [], null, now).id;
      this.st.insertRef.run(name, DEFAULT_BRANCH, head, now);
    });
    return { name, head };
  }

  listRepos() {
    return (this.st.listRepos.all() as any[]).map((r) => {
      const head = this.st.getRef.get(r.name, DEFAULT_BRANCH) as any;
      return { name: r.name, description: r.description, createdAt: r.created_at, head: head?.target ?? null };
    });
  }

  getRepo(name: string) {
    const r = this.st.getRepo.get(name) as any;
    if (!r) throw new GraftError(404, `no such repo: ${name}`);
    const refs = (this.st.listRefs.all(name) as any[]).map((x) => ({
      name: x.name,
      target: x.target,
      version: x.version,
      updatedAt: x.updated_at,
    }));
    const n = (this.st.countCs.get(name) as any).n as number;
    return { name: r.name, description: r.description, createdAt: r.created_at, defaultBranch: DEFAULT_BRANCH, refs, changesets: n };
  }

  private requireRepo(name: string) {
    if (!this.st.getRepo.get(name)) throw new GraftError(404, `no such repo: ${name}`);
  }

  getRef(repo: string, name: string): string | null {
    const r = this.st.getRef.get(repo, name) as any;
    return r ? r.target : null;
  }

  /**
   * Create, move or delete a ref with compare-and-swap.
   * expected: undefined = don't care, null = must not exist, string = must currently point there.
   */
  setRef(repo: string, name: string, target: string | null, expected?: string | null): { name: string; target: string | null } {
    this.requireRepo(repo);
    validRefName(name);
    const now = new Date().toISOString();
    const cur = this.getRef(repo, name);
    if (expected !== undefined && expected !== cur) {
      throw new GraftError(409, `ref ${name} is at ${cur ?? "(none)"}, expected ${expected ?? "(none)"}`, { current: cur });
    }
    if (target === null) {
      if (name === DEFAULT_BRANCH) throw new GraftError(400, "cannot delete the default branch");
      if (cur) this.st.deleteRef.run(repo, name, cur);
      return { name, target: null };
    }
    const id = this.resolve(repo, target);
    if (cur === null) {
      const r = this.st.insertRef.run(repo, name, id, now);
      if (r.changes !== 1) throw new GraftError(409, `ref ${name} was created concurrently`);
    } else {
      const r = this.st.casRef.run(id, now, repo, name, cur);
      if (r.changes !== 1) throw new GraftError(409, `ref ${name} moved concurrently`);
    }
    return { name, target: id };
  }

  // ---------------------------------------------------------------- changesets

  /** Resolve a branch name, full id, unique id prefix, or `<rev>~N` (first-parent ancestors). */
  resolve(repo: string, rev?: string | null): string {
    this.requireRepo(repo);
    let r = (rev ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
    let back = 0;
    const m = /^(.*?)~(\d*)$/.exec(r);
    if (m) {
      r = m[1] || DEFAULT_BRANCH;
      back = m[2] === "" ? 1 : parseInt(m[2], 10);
    }
    let id = this.getRef(repo, r);
    if (!id) {
      if (/^[0-9a-f]{64}$/.test(r)) {
        const cs = this.st.getCs.get(r) as CsRow | undefined;
        if (cs && cs.repo === repo) id = r;
      } else if (/^[0-9a-f]{4,63}$/.test(r)) {
        const rows = this.st.csByPrefix.all(repo, r, r + "g") as any[];
        if (rows.length > 1) throw new GraftError(400, `ambiguous changeset prefix: ${r}`);
        if (rows.length === 1) id = rows[0].id;
      }
    }
    if (!id) throw new GraftError(404, `unknown revision: ${rev}`);
    for (let i = 0; i < back; i++) {
      const cs = this.changeset(id!);
      if (!cs.parents[0]) throw new GraftError(404, `revision ${rev} goes past the root`);
      id = cs.parents[0];
    }
    return id!;
  }

  changeset(id: string): Changeset {
    const hit = this.csCache.get(id);
    if (hit) return hit;
    const row = this.st.getCs.get(id) as CsRow | undefined;
    if (!row) throw new GraftError(404, `no such changeset: ${id}`);
    const changes = (this.st.getChanges.all(id) as any[]).map((c) => ({ path: c.path, blob: c.blob ?? null }));
    const cs: Changeset = {
      id: row.id,
      repo: row.repo,
      parents: [row.parent1, row.parent2].filter((x): x is string => !!x),
      author: row.author,
      message: row.message,
      createdAt: row.created_at,
      generation: row.generation,
      rebasedFrom: row.rebased_from,
      changes,
    };
    if (this.csCache.size > 5000) this.csCache.delete(this.csCache.keys().next().value!);
    this.csCache.set(id, cs);
    return cs;
  }

  private csRow(id: string): CsRow {
    const row = this.st.getCs.get(id) as CsRow | undefined;
    if (!row) throw new GraftError(404, `no such changeset: ${id}`);
    return row;
  }

  private writeChangeset(
    repo: string,
    parents: string[],
    author: string,
    message: string,
    changes: FileChange[],
    rebasedFrom: string | null,
    createdAt = new Date().toISOString(),
  ): Changeset {
    const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const generation = parents.length ? Math.max(...parents.map((p) => this.csRow(p).generation)) + 1 : 0;
    const id = sha256(canonicalJson({ repo, parents, author, message, createdAt, rebasedFrom, changes: sorted }));
    this.tx(() => {
      this.st.insertCs.run(id, repo, parents[0] ?? null, parents[1] ?? null, author, message, createdAt, generation, rebasedFrom, sorted.length);
      for (const c of sorted) this.st.insertChange.run(id, repo, c.path, c.blob);
    });
    const cs = this.changeset(id);
    // Eager derivation: checkpoint full manifests periodically so lookups stay O(changes) after restarts.
    if (generation % CHECKPOINT_EVERY === 0) {
      const m = this.manifest(id);
      const key = this.blobs.put(Buffer.from(JSON.stringify([...m])));
      this.st.putDerived.run("manifest", id, key);
    }
    return cs;
  }

  /**
   * Create a changeset on the server from agent-friendly change inputs.
   * The result is a draft: it exists everywhere immediately but no ref points at it until it lands.
   */
  commit(repo: string, opts: CommitOptions): Changeset {
    if (opts.base !== undefined && opts.base !== null && typeof opts.base !== "string") throw new GraftError(400, "base must be a string");
    const base = this.resolve(repo, opts.base);
    const author = String(opts.author || "agent").slice(0, 200);
    if (opts.message !== undefined && typeof opts.message !== "string") throw new GraftError(400, "message must be a string");
    const message = (opts.message || "").trim();
    if (!message) throw new GraftError(400, "commit message is required");
    if (!Array.isArray(opts.changes)) throw new GraftError(400, "changes must be an array");
    if (opts.changes.length > 100_000) throw new GraftError(413, "too many changes in one commit");
    for (const [i, ch] of opts.changes.entries()) {
      if (!ch || typeof ch !== "object") throw new GraftError(400, `changes[${i}] must be an object`);
      for (const k of ["content", "contentBase64", "blob", "from"] as const) {
        if (ch[k] !== undefined && typeof ch[k] !== "string") throw new GraftError(400, `changes[${i}].${k} must be a string`);
      }
      if (ch.edits !== undefined && !Array.isArray(ch.edits)) throw new GraftError(400, `changes[${i}].edits must be an array`);
    }
    const baseManifest = this.manifest(base);
    const out = new Map<string, string | null>();
    const claim = (p: string) => {
      if (out.has(p)) throw new GraftError(400, `path appears more than once in this commit: ${p}`);
    };
    const current = (p: string): Buffer | null => {
      if (out.has(p)) {
        const b = out.get(p);
        return b ? this.blobs.get(b) : null;
      }
      const h = baseManifest.get(p);
      return h ? this.blobs.get(h) : null;
    };
    for (const ch of opts.changes) {
      const path = normalizePath(ch.path);
      if (ch.from !== undefined) {
        const from = normalizePath(ch.from);
        if (from === path) throw new GraftError(400, `move source and destination are the same: ${path}`);
        if (out.has(from)) throw new GraftError(400, `move source ${from} is also changed elsewhere in this commit`);
        const srcBlob = baseManifest.get(from);
        if (!srcBlob) throw new GraftError(422, `cannot move ${from}: file does not exist at base`);
        claim(path);
        out.set(from, null);
        if (ch.content === undefined && ch.contentBase64 === undefined && ch.blob === undefined && !ch.edits) {
          out.set(path, srcBlob);
          continue;
        }
        if (ch.edits) {
          out.set(path, this.blobs.put(applyEdits(this.blobs.get(srcBlob)!.toString("utf8"), ch.edits, path)));
          continue;
        }
      } else {
        claim(path);
      }
      if (ch.delete) {
        if (!baseManifest.has(path) && !out.get(path)) throw new GraftError(422, `cannot delete ${path}: file does not exist at base`);
        out.set(path, null);
      } else if (ch.content !== undefined) {
        out.set(path, this.blobs.put(Buffer.from(ch.content, "utf8")));
      } else if (ch.contentBase64 !== undefined) {
        out.set(path, this.blobs.put(Buffer.from(ch.contentBase64, "base64")));
      } else if (ch.blob !== undefined) {
        if (!this.blobs.has(ch.blob)) throw new GraftError(422, `unknown blob ${ch.blob} for ${path}; upload it first`);
        out.set(path, ch.blob);
      } else if (ch.edits) {
        const cur = current(path);
        if (!cur) throw new GraftError(422, `cannot edit ${path}: file does not exist at base ${base.slice(0, 12)}`);
        out.set(path, this.blobs.put(applyEdits(cur.toString("utf8"), ch.edits, path)));
      } else {
        throw new GraftError(400, `change for ${path} needs one of content, contentBase64, blob, edits, delete, from`);
      }
    }
    // Drop no-op entries (new state equals base state).
    const changes: FileChange[] = [];
    for (const [path, blob] of out) {
      if ((baseManifest.get(path) ?? null) !== blob) changes.push({ path, blob });
    }
    if (!changes.length && !opts.allowEmpty) throw new GraftError(422, "commit has no effective changes against its base");
    const parents = [base];
    if (opts.mergeParent) parents.push(this.resolve(repo, opts.mergeParent));
    return this.writeChangeset(repo, parents, author, message, changes, null);
  }

  /**
   * Land a changeset on a branch. Fast-forwards when possible; otherwise rebases on the server
   * (per-file 3-way merge) and moves the ref with compare-and-swap. No global lock, no merge queue:
   * textual conflicts are rejected with structured detail so the agent can resolve and retry.
   */
  land(repo: string, changesetId: string, branch = DEFAULT_BRANCH, opts: { expectedHead?: string } = {}): LandResult {
    const id = this.resolve(repo, changesetId);
    validRefName(branch);
    let attempts = 0;
    while (attempts < 25) {
      attempts++;
      const head = this.getRef(repo, branch);
      if (!head) throw new GraftError(404, `no such branch: ${branch}`);
      if (opts.expectedHead && opts.expectedHead !== head) {
        throw new GraftError(409, `branch ${branch} is at ${head}, expected ${opts.expectedHead}`, { head });
      }
      if (head === id || this.isAncestor(id, head)) {
        return { status: "noop", branch, head, landed: id, rebased: false, attempts };
      }
      let target = id;
      let rebased = false;
      if (!this.isAncestor(head, id)) {
        const r = this.rebase(repo, id, head);
        if ("conflicts" in r) {
          return { status: "conflict", branch, head, rebased: false, conflicts: r.conflicts, attempts };
        }
        target = r.id;
        rebased = true;
        if (this.changeset(target).changes.length === 0 && this.changeset(id).changes.length > 0) {
          // Every change is already on the branch (e.g. it landed before as a rebased copy).
          return { status: "noop", branch, head, rebased: false, attempts };
        }
      }
      const res = this.st.casRef.run(target, new Date().toISOString(), repo, branch, head);
      if (res.changes === 1) return { status: "landed", branch, head: target, landed: target, rebased, attempts };
      // Lost the CAS race: someone else landed first. Loop and rebase onto the new head.
    }
    throw new GraftError(503, `could not land after ${attempts} attempts (branch is very hot); retry`);
  }

  /** added / modified / deleted for each path in a changeset, relative to its first parent (metadata only). */
  changeStatus(id: string): { path: string; status: "added" | "modified" | "deleted" }[] {
    const cs = this.changeset(id);
    const parent = cs.parents[0] ? this.manifest(cs.parents[0]) : new Map<string, string>();
    return cs.changes.map((c) => ({ path: c.path, status: !c.blob ? "deleted" : parent.has(c.path) ? "modified" : "added" }));
  }

  /** Rebase changeset `id` (and its draft ancestors back to `onto`'s history) onto `onto`. */
  private rebase(repo: string, id: string, onto: string): { id: string } | { conflicts: Conflict[] } {
    const cs = this.changeset(id);
    const base = cs.parents[0];
    if (!base) throw new GraftError(400, "cannot rebase a root changeset");
    // If the changeset's parent is itself an unlanded draft, rebase the parent first (stacked changes).
    let newBase = onto;
    if (!this.isAncestor(base, onto)) {
      const r = this.rebase(repo, base, onto);
      if ("conflicts" in r) return r;
      newBase = r.id;
    }
    const mBase = this.manifest(base);
    const mOnto = this.manifest(newBase);
    const conflicts: Conflict[] = [];
    const out: FileChange[] = [];
    for (const ch of cs.changes) {
      const b = mBase.get(ch.path) ?? null;
      const o = mOnto.get(ch.path) ?? null;
      const t = ch.blob;
      if (o === b) {
        if (t !== o) out.push(ch);
        continue;
      }
      if (o === t) continue; // same change already on the branch
      // Both sides changed this path.
      if (t === null) {
        conflicts.push({ path: ch.path, kind: "modify-delete", base: b, ours: o, theirs: null });
        continue;
      }
      if (o === null) {
        conflicts.push({ path: ch.path, kind: "delete-modify", base: b, ours: null, theirs: t });
        continue;
      }
      const ob = this.blobs.get(o)!;
      const tb = this.blobs.get(t)!;
      const bb = b ? this.blobs.get(b)! : Buffer.alloc(0);
      if (isBinary(ob) || isBinary(tb) || isBinary(bb)) {
        conflicts.push({ path: ch.path, kind: "binary", base: b, ours: o, theirs: t });
        continue;
      }
      const m = merge3(bb.toString("utf8"), ob.toString("utf8"), tb.toString("utf8"), {
        ours: `branch (${newBase.slice(0, 12)})`,
        theirs: `change (${id.slice(0, 12)})`,
      });
      if (m.clean) out.push({ path: ch.path, blob: this.blobs.put(Buffer.from(m.text, "utf8")) });
      else conflicts.push({ path: ch.path, kind: b === null ? "add-add" : "content", base: b, ours: o, theirs: t, merged: m.text });
    }
    if (conflicts.length) return { conflicts };
    const rebasedFrom = cs.rebasedFrom ?? cs.id;
    const parents = [newBase, ...cs.parents.slice(1)];
    return { id: this.writeChangeset(repo, parents, cs.author, cs.message, out, rebasedFrom).id };
  }

  /** Is `a` an ancestor of (or equal to) `b`? Generation numbers prune the walk. */
  isAncestor(a: string, b: string): boolean {
    if (a === b) return true;
    const ga = this.csRow(a).generation;
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === a) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      const row = this.csRow(x);
      if (row.generation <= ga) continue;
      if (row.parent1) stack.push(row.parent1);
      if (row.parent2) stack.push(row.parent2);
    }
    return false;
  }

  mergeBase(repo: string, revA: string, revB: string): string | null {
    const a = this.resolve(repo, revA);
    const b = this.resolve(repo, revB);
    // Paint walk ordered by generation (highest first).
    const flags = new Map<string, number>();
    const queue: { id: string; gen: number }[] = [];
    const push = (id: string, f: number) => {
      const prev = flags.get(id) ?? 0;
      if ((prev | f) === prev) return;
      flags.set(id, prev | f);
      queue.push({ id, gen: this.csRow(id).generation });
    };
    push(a, 1);
    push(b, 2);
    while (queue.length) {
      queue.sort((x, y) => y.gen - x.gen);
      const { id } = queue.shift()!;
      const f = flags.get(id)!;
      if (f === 3) return id;
      const row = this.csRow(id);
      if (row.parent1) push(row.parent1, f);
      if (row.parent2) push(row.parent2, f);
    }
    return null;
  }

  // ---------------------------------------------------------------- derived data: manifests & trees

  /** Full path→blob map for a changeset, derived recursively from first parents (with checkpoints + LRU). */
  manifest(id: string): Manifest {
    const hit = this.manifestCache.get(id);
    if (hit) {
      this.manifestCache.delete(id);
      this.manifestCache.set(id, hit);
      return hit;
    }
    const chain: string[] = [];
    let cur: string | null = id;
    let base: Manifest = new Map();
    while (cur) {
      const cached = this.manifestCache.get(cur);
      if (cached) {
        base = new Map(cached);
        break;
      }
      const cp = this.st.getDerived.get("manifest", cur) as any;
      if (cp) {
        const buf = this.blobs.get(cp.value);
        if (buf) {
          base = new Map(JSON.parse(buf.toString("utf8")));
          break;
        }
      }
      chain.push(cur);
      cur = this.csRow(cur).parent1;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const c of this.changeset(chain[i]).changes) {
        if (c.blob) base.set(c.path, c.blob);
        else base.delete(c.path);
      }
    }
    this.manifestCache.set(id, base);
    if (this.manifestCache.size > 48) this.manifestCache.delete(this.manifestCache.keys().next().value!);
    return base;
  }

  readFile(repo: string, rev: string | undefined, path: string): { changeset: string; blob: string; data: Buffer } {
    const id = this.resolve(repo, rev);
    const p = normalizePath(path);
    const blob = this.manifest(id).get(p);
    if (!blob) {
      const dir = this.tree(repo, id, p, true);
      if (dir.length) throw new GraftError(400, `${p} is a directory; use tree`);
      throw new GraftError(404, `no such file at ${id.slice(0, 12)}: ${p}`);
    }
    return { changeset: id, blob, data: this.blobs.get(blob)! };
  }

  tree(repo: string, rev: string | undefined, path = "", quiet = false): TreeEntry[] {
    const id = this.resolve(repo, rev);
    const prefix = path ? normalizePath(path) + "/" : "";
    const dirs = new Set<string>();
    const out: TreeEntry[] = [];
    for (const [p, blob] of this.manifest(id)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) out.push({ name: rest, path: p, type: "file", blob });
      else {
        const d = rest.slice(0, slash);
        if (!dirs.has(d)) {
          dirs.add(d);
          out.push({ name: d, path: prefix + d, type: "dir" });
        }
      }
    }
    if (!out.length && prefix && !quiet) {
      if (this.manifest(id).has(prefix.slice(0, -1))) throw new GraftError(400, `${prefix.slice(0, -1)} is a file; use read_file`);
      throw new GraftError(404, `no such directory: ${prefix.slice(0, -1)}`);
    }
    return out.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name < b.name ? -1 : 1));
  }

  /** Path→blob entries under optional prefixes (used by sparse clients). */
  manifestEntries(repo: string, rev: string | undefined, prefixes: string[] = []) {
    const id = this.resolve(repo, rev);
    const norm = prefixes.filter(Boolean).map((p) => normalizePath(p));
    const entries: [string, string][] = [];
    for (const [p, b] of this.manifest(id)) {
      if (!norm.length || norm.some((pre) => p === pre || p.startsWith(pre + "/"))) entries.push([p, b]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { changeset: id, entries };
  }

  findFiles(repo: string, rev: string | undefined, pattern: string, limit = 500) {
    const id = this.resolve(repo, rev);
    const re = globToRegex(pattern);
    const out: string[] = [];
    for (const p of this.manifest(id).keys()) {
      if (re.test(p)) out.push(p);
    }
    out.sort();
    return { changeset: id, files: out.slice(0, limit), truncated: out.length > limit };
  }

  // ---------------------------------------------------------------- derived data: history, diff, blame, search

  log(repo: string, rev?: string, opts: { path?: string; limit?: number; firstParentOnly?: boolean } = {}) {
    const start = this.resolve(repo, rev);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    let touching: Set<string> | null = null;
    if (opts.path) {
      const p = normalizePath(opts.path);
      touching = new Set((this.st.touching.all(repo, p, p + "/", p + "0") as any[]).map((r) => r.changeset_id));
    }
    const out: Omit<Changeset, "changes">[] & { changeCount?: number }[] = [];
    let cur: string | null = start;
    let scanned = 0;
    while (cur && out.length < limit && scanned < 200000) {
      scanned++;
      const row = this.csRow(cur);
      if (!touching || touching.has(cur)) {
        out.push({
          id: row.id,
          repo: row.repo,
          parents: [row.parent1, row.parent2].filter(Boolean) as string[],
          author: row.author,
          message: row.message,
          createdAt: row.created_at,
          generation: row.generation,
          rebasedFrom: row.rebased_from,
          changeCount: row.change_count,
        } as any);
      }
      cur = row.parent1;
    }
    return { start, changesets: out, more: !!cur };
  }

  diff(repo: string, toRev?: string, fromRev?: string, opts: { paths?: string[]; patch?: boolean; stat?: boolean; context?: number } = {}) {
    const to = this.resolve(repo, toRev);
    const toCs = this.changeset(to);
    const from = fromRev ? this.resolve(repo, fromRev) : (toCs.parents[0] ?? null);
    const mTo = this.manifest(to);
    const mFrom: Manifest = from ? this.manifest(from) : new Map();
    let paths: string[];
    if (from && from === toCs.parents[0]) paths = toCs.changes.map((c) => c.path);
    else {
      const s = new Set<string>();
      for (const [p, b] of mTo) if (mFrom.get(p) !== b) s.add(p);
      for (const p of mFrom.keys()) if (!mTo.has(p)) s.add(p);
      paths = [...s].sort();
    }
    if (opts.paths?.length) {
      const pre = opts.paths.map(normalizePath);
      paths = paths.filter((p) => pre.some((x) => p === x || p.startsWith(x + "/")));
    }
    const files: DiffFile[] = [];
    let added = 0;
    let removed = 0;
    for (const p of paths) {
      const oldBlob = mFrom.get(p) ?? null;
      const newBlob = mTo.get(p) ?? null;
      if (oldBlob === newBlob) continue;
      if (opts.stat === false && opts.patch === false) {
        // Path-level delta only (what sync clients need): no blob reads, no line diffing.
        files.push({ path: p, status: !oldBlob ? "added" : !newBlob ? "deleted" : "modified", oldBlob, newBlob, binary: false, added: 0, removed: 0 });
        continue;
      }
      const oldData = oldBlob ? this.blobs.get(oldBlob)! : Buffer.alloc(0);
      const newData = newBlob ? this.blobs.get(newBlob)! : Buffer.alloc(0);
      const binary = isBinary(oldData) || isBinary(newData);
      const f: DiffFile = {
        path: p,
        status: !oldBlob ? "added" : !newBlob ? "deleted" : "modified",
        oldBlob,
        newBlob,
        binary,
        added: 0,
        removed: 0,
      };
      if (!binary) {
        const u = unifiedDiff(
          oldData.toString("utf8"),
          newData.toString("utf8"),
          oldBlob ? `a/${p}` : "/dev/null",
          newBlob ? `b/${p}` : "/dev/null",
          opts.context ?? 3,
        );
        f.added = u.stat.added;
        f.removed = u.stat.removed;
        if (opts.patch !== false) f.patch = u.patch;
      }
      added += f.added;
      removed += f.removed;
      files.push(f);
    }
    return { from, to, files, stat: { files: files.length, added, removed } };
  }

  /** Line-level blame, derived recursively from the previous version of the file and cached. */
  blame(repo: string, rev: string | undefined, path: string) {
    const id = this.resolve(repo, rev);
    const p = normalizePath(path);
    const blob = this.manifest(id).get(p);
    if (!blob) throw new GraftError(404, `no such file: ${p}`);
    // Walk first-parent history collecting the versions of this file. The (repo, path) index tells us
    // which changesets touched it, so we only load change lists for those.
    const touching = new Set((this.st.touchingExact.all(repo, p) as any[]).map((r) => r.changeset_id as string));
    const versions: { cs: string; blob: string }[] = [];
    let cur: string | null = id;
    let cachedStart: string[] | null = null;
    while (cur) {
      if (touching.has(cur)) {
        const ch = this.changeset(cur).changes.find((c) => c.path === p);
        if (ch) {
          if (!ch.blob) break; // deleted here: earlier history is a different file
          versions.push({ cs: cur, blob: ch.blob });
          const cached = this.st.getDerived.get("blame", `${cur}:${p}`) as any;
          if (cached) {
            cachedStart = expandRuns(JSON.parse(cached.value));
            break;
          }
        }
      }
      cur = this.csRow(cur).parent1;
    }
    versions.reverse();
    let attr: string[] = [];
    let prevLines: string[] = [];
    versions.forEach((v, i) => {
      const lines = splitLines(this.blobs.get(v.blob)!.toString("utf8"));
      if (i === 0 && cachedStart) {
        attr = cachedStart;
      } else {
        const ops = diffOps(prevLines, lines);
        const next: string[] = [];
        let ai = 0;
        for (const op of ops) {
          if (op === "=") next.push(attr[ai++]);
          else if (op === "-") ai++;
          else next.push(v.cs);
        }
        attr = next;
        this.st.putDerived.run("blame", `${v.cs}:${p}`, JSON.stringify(compressRuns(attr)));
      }
      prevLines = lines;
    });
    const meta = new Map<string, { author: string; message: string; createdAt: string }>();
    const lines = prevLines.map((text, i) => {
      const cs = attr[i];
      if (!meta.has(cs)) {
        const c = this.csRow(cs);
        meta.set(cs, { author: c.author, message: c.message.split("\n")[0], createdAt: c.created_at });
      }
      return { line: i + 1, changeset: cs, text: text.replace(/\n$/, "") };
    });
    return { changeset: id, path: p, lines, changesets: Object.fromEntries(meta) };
  }

  search(
    repo: string,
    rev: string | undefined,
    query: string,
    opts: { regex?: boolean; ignoreCase?: boolean; prefix?: string; glob?: string; limit?: number } = {},
  ) {
    const id = this.resolve(repo, rev);
    if (!query || typeof query !== "string") throw new GraftError(400, "query is required");
    if (query.length > 1000) throw new GraftError(400, "query is too long (max 1000 chars)");
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 2000);
    let re: RegExp;
    try {
      re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.ignoreCase ? "i" : "");
    } catch (e: any) {
      throw new GraftError(400, `bad regex: ${e.message}`);
    }
    const prefix = opts.prefix ? normalizePath(opts.prefix) : "";
    const globRe = opts.glob ? globToRegex(opts.glob) : null;
    const matches: SearchMatch[] = [];
    let filesScanned = 0;
    const entries = [...this.manifest(id)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [p, blob] of entries) {
      if (prefix && !(p === prefix || p.startsWith(prefix + "/"))) continue;
      if (globRe && !globRe.test(p)) continue;
      const data = this.blobs.get(blob);
      if (!data || data.length > 2 * 1024 * 1024 || isBinary(data)) continue;
      filesScanned++;
      const lines = data.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Long minified lines make backtracking regexes very slow and block every other agent.
        if (opts.regex && lines[i].length > 20_000) continue;
        if (re.test(lines[i])) {
          matches.push({ path: p, line: i + 1, text: lines[i].length > 400 ? lines[i].slice(0, 400) + "…" : lines[i] });
          if (matches.length >= limit) return { changeset: id, matches, truncated: true, filesScanned };
        }
      }
    }
    return { changeset: id, matches, truncated: false, filesScanned };
  }

  private txDepth = 0;
  private tx(fn: () => void) {
    if (this.txDepth > 0) {
      // Already inside a transaction: join it.
      this.txDepth++;
      try {
        fn();
      } finally {
        this.txDepth--;
      }
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      // Rows written in the failed transaction may have been cached.
      this.csCache.clear();
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }
}

export function applyEdits(text: string, edits: { old: string; new: string; all?: boolean }[], path: string): Buffer {
  let s = text;
  edits.forEach((e, i) => {
    if (!e || typeof e !== "object") throw new GraftError(400, `edit ${i} on ${path} must be an object`);
    if (typeof e.old !== "string" || typeof e.new !== "string") throw new GraftError(400, `edit ${i} on ${path}: old and new must be strings`);
    if (e.old === "") throw new GraftError(400, `edit ${i} on ${path}: old must be non-empty (use content to write a whole file)`);
    const count = s.split(e.old).length - 1;
    if (count === 0) throw new GraftError(422, `edit ${i} on ${path}: old text not found`, { path, edit: i });
    if (count > 1 && !e.all) {
      throw new GraftError(422, `edit ${i} on ${path}: old text matches ${count} times; add more context or set all: true`, { path, edit: i, count });
    }
    s = e.all ? s.split(e.old).join(e.new) : s.replace(e.old, () => e.new);
  });
  return Buffer.from(s, "utf8");
}

function compressRuns(attr: string[]): [string, number][] {
  const out: [string, number][] = [];
  for (const a of attr) {
    const last = out[out.length - 1];
    if (last && last[0] === a) last[1]++;
    else out.push([a, 1]);
  }
  return out;
}

function expandRuns(runs: [string, number][]): string[] {
  const out: string[] = [];
  for (const [a, n] of runs) for (let i = 0; i < n; i++) out.push(a);
  return out;
}
