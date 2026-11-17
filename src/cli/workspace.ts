import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  rmdirSync,
  lstatSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { GraftClient } from "../client/api.js";
import { sha256 } from "../core/hash.js";
import { merge3 } from "../core/diff.js";
import { globToRegex } from "../core/glob.js";
import { normalizePath } from "../core/paths.js";
import { lstatSync as lstat, realpathSync } from "node:fs";

export interface WorkspaceConfig {
  server: string;
  repo: string;
  branch: string;
  base: string;
  sparse: string[];
}

export interface IndexEntry {
  blob: string;
  size: number;
  mtimeMs: number;
  /** When this entry was recorded. Used to detect "racily clean" files (edited within the mtime granularity). */
  at?: number;
}

/** A file whose mtime is this close to when we recorded it can't be trusted by stat alone; hash it. */
function racy(e: IndexEntry): boolean {
  if (e.at === undefined) return true;
  const coarse = e.mtimeMs % 1000 === 0; // 1s-granularity filesystems (HFS+, ext3, FAT-ish)
  return e.mtimeMs >= e.at - (coarse ? 2000 : 10);
}

export type FileStatus = { path: string; state: "modified" | "added" | "deleted"; blob?: string };

const DEFAULT_IGNORES = [".graft", ".git", "node_modules", ".DS_Store"];

/**
 * Node-local, content-addressed object cache shared by every workspace on the machine
 * (the analogue of a per-node daemon cache): a second clone of the same repo fetches nothing.
 */
export class ObjectCache {
  readonly root: string;
  constructor(root = process.env.GRAFT_CACHE ?? join(homedir(), ".graft", "cache", "objects")) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  path(hash: string) {
    return join(this.root, hash.slice(0, 2), hash);
  }
  has(hash: string) {
    return existsSync(this.path(hash));
  }
  get(hash: string): Buffer | null {
    const p = this.path(hash);
    return existsSync(p) ? readFileSync(p) : null;
  }
  put(hash: string, data: Buffer) {
    const p = this.path(hash);
    if (existsSync(p)) return;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, p);
  }
  /** Fetch any missing objects from the server in parallel batches. Returns how many were downloaded. */
  async ensure(client: GraftClient, hashes: string[]): Promise<number> {
    const missing = [...new Set(hashes)].filter((h) => !this.has(h));
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += 500) batches.push(missing.slice(i, i + 500));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const b = batches[next++];
        const got = await client.getBlobs(b);
        for (const h of b) {
          const d = got.get(h);
          if (!d) throw new Error(`server is missing blob ${h}`);
          if (sha256(d) !== h) throw new Error(`blob ${h} failed hash verification`);
          this.put(h, d);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, batches.length) }, worker));
    return missing.length;
  }
  /** Materialize an object at dest. Uses copy-on-write clones where the filesystem supports them (APFS, btrfs, XFS). */
  materialize(hash: string, dest: string) {
    mkdirSync(dirname(dest), { recursive: true });
    // Replace whatever is there (including a symlink) rather than writing through it.
    try {
      lstat(dest);
      unlinkSync(dest);
    } catch {}
    copyFileSync(this.path(hash), dest, constants.COPYFILE_FICLONE);
  }
}

export class Workspace {
  readonly meta: string;
  config: WorkspaceConfig;
  index: Record<string, IndexEntry>;
  readonly cache = new ObjectCache();
  /** Index entries were refreshed in memory and should be saved. */
  dirty = false;
  private ignore: RegExp[];

  constructor(readonly root: string) {
    this.meta = join(root, ".graft");
    this.config = JSON.parse(readFileSync(join(this.meta, "config.json"), "utf8"));
    this.index = JSON.parse(readFileSync(join(this.meta, "index.json"), "utf8"));
    const extra = existsSync(join(root, ".graftignore"))
      ? readFileSync(join(root, ".graftignore"), "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
      : [];
    this.ignore = [...DEFAULT_IGNORES, ...extra].map((g) => globToRegex(g.replace(/\/$/, "")));
  }

  static find(start = process.cwd()): Workspace | null {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, ".graft", "config.json"))) return new Workspace(dir);
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }

  static init(root: string, config: WorkspaceConfig): Workspace {
    mkdirSync(join(root, ".graft"), { recursive: true });
    writeFileSync(join(root, ".graft", "config.json"), JSON.stringify(config, null, 2));
    writeFileSync(join(root, ".graft", "index.json"), "{}");
    return new Workspace(root);
  }

  client(token = process.env.GRAFT_TOKEN, author = process.env.GRAFT_AUTHOR) {
    return new GraftClient({ url: process.env.GRAFT_URL ?? this.config.server, token, author });
  }

  save() {
    this.dirty = false;
    const tmp = join(this.meta, "index.json.tmp");
    writeFileSync(tmp, JSON.stringify(this.index));
    renameSync(tmp, join(this.meta, "index.json"));
    writeFileSync(join(this.meta, "config.json"), JSON.stringify(this.config, null, 2));
  }

  /**
   * Absolute location of a repository path inside this workspace. Paths come from the server, so they are
   * treated as untrusted: they must be canonical, and the resolved parent directory (after following any
   * symlinks already on disk) must still be inside the workspace.
   */
  abs(path: string) {
    let canonical: string;
    try {
      canonical = normalizePath(path);
    } catch (e: any) {
      throw new Error(`refusing unsafe path from server: ${JSON.stringify(path)} (${e?.message ?? e})`);
    }
    if (canonical !== path) throw new Error(`refusing non-canonical path from server: ${JSON.stringify(path)}`);
    const full = join(this.root, ...path.split("/"));
    if (!full.startsWith(this.root + sep)) throw new Error(`refusing path outside the workspace: ${JSON.stringify(path)}`);
    // Walk up to the nearest existing ancestor and make sure symlinks don't lead out of the workspace.
    let dir = dirname(full);
    while (!existsSync(dir) && dir.startsWith(this.root + sep)) dir = dirname(dir);
    const real = realpathSync(dir);
    if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) {
      throw new Error(`refusing path that leaves the workspace through a symlink: ${JSON.stringify(path)}`);
    }
    return full;
  }

  private _realRoot: string | null = null;
  get realRoot() {
    return (this._realRoot ??= realpathSync(this.root));
  }

  inSparse(path: string) {
    const s = this.config.sparse;
    return !s.length || s.some((p) => path === p || path.startsWith(p + "/"));
  }

  private ignored(rel: string) {
    return this.ignore.some((re) => re.test(rel) || rel.split("/").some((_, i, parts) => re.test(parts.slice(0, i + 1).join("/"))));
  }

  /** Walk the working tree (excluding ignores). */
  walk(): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = relative(this.root, full).split(sep).join("/");
        if (this.ignored(rel)) continue;
        const st = lstatSync(full);
        if (st.isDirectory()) visit(full);
        else if (st.isFile()) out.push(rel);
      }
    };
    visit(this.root);
    return out.sort();
  }

  /** Local changes relative to the workspace base (stat-first, hash only when needed). */
  status(): FileStatus[] {
    const out: FileStatus[] = [];
    const seen = new Set<string>();
    for (const [path, e] of Object.entries(this.index)) {
      seen.add(path);
      const p = this.abs(path);
      if (!existsSync(p)) {
        out.push({ path, state: "deleted" });
        continue;
      }
      const st = statSync(p);
      if (st.size === e.size && st.mtimeMs === e.mtimeMs && !racy(e)) continue;
      const data = readFileSync(p);
      const h = sha256(data);
      if (h !== e.blob) out.push({ path, state: "modified", blob: h });
      else {
        // Unchanged content (touched, or racily clean): refresh the stat cache so the next status is stat-only.
        this.index[path] = { blob: h, size: st.size, mtimeMs: st.mtimeMs, at: Date.now() };
        this.dirty = true;
      }
    }
    for (const path of this.walk()) {
      if (seen.has(path)) continue;
      out.push({ path, state: "added", blob: sha256(readFileSync(this.abs(path))) });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  private record(path: string, blob: string) {
    const st = statSync(this.abs(path));
    this.index[path] = { blob, size: st.size, mtimeMs: st.mtimeMs, at: Date.now() };
  }

  private removeFile(path: string) {
    const p = this.abs(path);
    if (existsSync(p)) unlinkSync(p);
    // prune empty parent dirs
    let d = dirname(p);
    while (d.startsWith(this.root) && d !== this.root) {
      try {
        if (readdirSync(d).length) break;
        rmdirSync(d);
      } catch {
        break;
      }
      d = dirname(d);
    }
  }

  /**
   * Move the workspace to `rev`, materializing only sparse paths. Local edits are carried over with a
   * 3-way merge (base = old workspace base, theirs = new revision). Returns conflicted paths.
   */
  async checkout(rev: string, opts: { onlyPrefixes?: string[] } = {}): Promise<{ head: string; written: number; fetched: number; conflicts: string[]; ms: number }> {
    const t0 = Date.now();
    const client = this.client();
    const prefixes = opts.onlyPrefixes ?? this.config.sparse;
    const man = await client.manifest(this.config.repo, rev, prefixes);
    const next = new Map(man.entries);
    const local = new Map(this.status().map((s) => [s.path, s]));
    const scope = (p: string) => (opts.onlyPrefixes ? opts.onlyPrefixes.some((x) => p === x || p.startsWith(x + "/")) : true);
    const oldPaths = Object.keys(this.index).filter(scope);
    const all = new Set<string>([...oldPaths, ...next.keys(), ...[...local.keys()].filter((p) => next.has(p))]);
    const need: string[] = [];
    for (const p of all) {
      const nb = next.get(p);
      if (nb) need.push(nb);
      const ob = this.index[p]?.blob;
      if (ob) need.push(ob);
    }
    const fetched = await this.cache.ensure(client, need);
    let written = 0;
    const conflicts: string[] = [];
    for (const p of [...all].sort()) {
      const oldBlob = this.index[p]?.blob ?? null;
      const newBlob = next.get(p) ?? null;
      const l = local.get(p);
      if (!l) {
        if (oldBlob === newBlob && newBlob && existsSync(this.abs(p))) continue;
        if (newBlob) {
          this.cache.materialize(newBlob, this.abs(p));
          this.record(p, newBlob);
          written++;
        } else {
          this.removeFile(p);
          delete this.index[p];
        }
        continue;
      }
      // Locally changed path.
      if (oldBlob === newBlob) continue; // upstream unchanged: keep local edit as is
      if (l.state === "deleted") {
        if (newBlob) {
          this.index[p] = { blob: newBlob, size: -1, mtimeMs: 0 };
          console.error(`warning: ${p} was deleted locally but changed upstream; keeping it deleted`);
        } else delete this.index[p];
        continue;
      }
      const mine = readFileSync(this.abs(p)).toString("utf8");
      const base = oldBlob ? this.cache.get(oldBlob)!.toString("utf8") : "";
      if (!newBlob) {
        // deleted upstream, edited locally: keep local file as an addition
        delete this.index[p];
        console.error(`warning: ${p} was deleted upstream but edited locally; kept as a new file`);
        continue;
      }
      const theirs = this.cache.get(newBlob)!.toString("utf8");
      const m = merge3(base, mine, theirs, { ours: "local", theirs: /^[0-9a-f]{64}$/.test(rev) ? rev.slice(0, 12) : rev });
      writeFileSync(this.abs(p), m.text);
      if (!m.clean) conflicts.push(p);
      this.index[p] = { blob: newBlob, size: -1, mtimeMs: 0 }; // base is now upstream; content is local
      written++;
    }
    this.config.base = man.changeset;
    this.save();
    return { head: man.changeset, written, fetched, conflicts, ms: Date.now() - t0 };
  }

  /** Upload changed blobs and create (and optionally land) a changeset. */
  async commit(message: string, opts: { land: boolean; paths?: string[]; force?: boolean }) {
    let changes = this.status();
    if (opts.paths?.length) changes = changes.filter((c) => opts.paths!.some((p) => c.path === p || c.path.startsWith(p.replace(/\/$/, "") + "/")));
    if (!changes.length) return { status: "nothing" as const };
    if (!opts.force) {
      const marked = changes.filter((c) => c.state !== "deleted" && /^(<<<<<<< |>>>>>>> )/m.test(readFileSync(this.abs(c.path), "utf8")));
      if (marked.length) throw new Error(`conflict markers in ${marked.map((m) => m.path).join(", ")} — resolve them or pass --force`);
    }
    const client = this.client();
    // In a sparse workspace, a "new" file outside the sparse paths may already exist upstream
    // (it just was never materialized). Committing it would silently overwrite a file nobody looked at.
    const outside = changes.filter((c) => c.state === "added" && !this.inSparse(c.path));
    if (outside.length && !opts.force) {
      const existing = await client.manifest(this.config.repo, this.config.base, outside.map((c) => c.path));
      const hit = existing.entries.map(([p]) => p).filter((p) => outside.some((c) => c.path === p));
      if (hit.length) {
        throw new Error(
          `${hit.join(", ")} already exist${hit.length === 1 ? "s" : ""} upstream outside your sparse paths; ` +
            `run graft add-sparse ${hit.join(" ")} first to merge with it (or --force to overwrite)`,
        );
      }
    }
    // Small changes travel inline with the commit (one round trip). Large ones upload missing blobs first.
    const live = changes.filter((c) => c.state !== "deleted");
    const datas = new Map(live.map((c) => [c.path, readFileSync(this.abs(c.path))]));
    const total = [...datas.values()].reduce((n, d) => n + d.length, 0);
    let uploaded = 0;
    let wire: any[];
    if (total <= 2 * 1024 * 1024) {
      wire = changes.map((c) => (c.state === "deleted" ? { path: c.path, delete: true } : { path: c.path, contentBase64: datas.get(c.path)!.toString("base64") }));
      uploaded = live.length;
    } else {
      const { missing } = await client.missingBlobs(live.map((c) => c.blob!));
      const want = new Set(missing);
      const upload = live.filter((c) => want.has(c.blob!));
      for (let i = 0; i < upload.length; i += 200) {
        const batch = upload.slice(i, i + 200);
        await client.uploadBlobs(batch.map((c) => datas.get(c.path)!));
      }
      uploaded = upload.length;
      wire = changes.map((c) => (c.state === "deleted" ? { path: c.path, delete: true } : { path: c.path, blob: c.blob }));
    }
    for (const c of live) this.cache.put(c.blob!, datas.get(c.path)!);
    const res = await client.commit(this.config.repo, {
      base: this.config.base,
      message,
      changes: wire,
      land: opts.land ? this.config.branch : false,
    });
    const land = res.land;
    if (!land || land.status === "landed" || land.status === "noop") {
      // Committed paths are now clean relative to the draft changeset.
      for (const c of changes) {
        if (c.state === "deleted") delete this.index[c.path];
        else this.record(c.path, c.blob!);
      }
      this.config.base = res.changeset.id;
      this.save();
      if (!land) return { status: "draft", changeset: res.changeset, land, uploaded };
      if (land.head === res.changeset.id) {
        // Fast-forward: the workspace already is the new head. Nothing to fetch.
        return { status: land.status, changeset: res.changeset, land, uploaded, sync: { head: land.head, written: 0, fetched: 0, conflicts: [], ms: 0 } };
      }
      // Rebased (or noop): pull in only the paths that differ between our draft and the new head.
      const committed = new Set(changes.map((c) => c.path));
      const dirty = this.status().filter((c) => !committed.has(c.path));
      const sync = await this.fastForwardFrom(res.changeset.id, land.head, new Set(dirty.map((d) => d.path)));
      return { status: land.status, changeset: res.changeset, land, uploaded, sync };
    }
    // Conflict: rebase the workspace onto the new head so conflicts appear as markers locally.
    const sync = await this.checkout(land.head);
    return { status: "conflict" as const, changeset: res.changeset, land, uploaded, sync };
  }

  /**
   * Move a clean-at-`from` workspace to `to` by applying only the server-computed path delta.
   * Falls back to a full checkout if any changed path has uncommitted local edits.
   */
  private async fastForwardFrom(from: string, to: string, dirty: Set<string>) {
    const t0 = Date.now();
    const client = this.client();
    const d = await client.request("GET", `${client.r(this.config.repo)}/diff`, { query: { from, to, patch: false, stat: false } });
    const files: { path: string; newBlob: string | null }[] = d.files.filter((f: any) => this.inSparse(f.path));
    if (files.some((f) => dirty.has(f.path))) return this.checkout(to);
    const fetched = await this.cache.ensure(client, files.filter((f) => f.newBlob).map((f) => f.newBlob!));
    for (const f of files) {
      if (f.newBlob) {
        this.cache.materialize(f.newBlob, this.abs(f.path));
        this.record(f.path, f.newBlob);
      } else {
        this.removeFile(f.path);
        delete this.index[f.path];
      }
    }
    this.config.base = to;
    this.save();
    return { head: to, written: files.length, fetched, conflicts: [] as string[], ms: Date.now() - t0 };
  }

  readBase(path: string): string {
    return this.readBaseBuffer(path).toString("utf8");
  }

  readBaseBuffer(path: string): Buffer {
    const e = this.index[path];
    if (!e) return Buffer.alloc(0);
    return this.cache.get(e.blob) ?? Buffer.alloc(0);
  }
}
