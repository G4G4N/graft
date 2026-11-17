/** Minimal typed client for the Graft HTTP API (uses global fetch; Node 18+). */
import { VERSION } from "../version.js";

/** Wire protocol this client speaks (see PROTOCOL_VERSION in server/http.ts). */
export const CLIENT_PROTOCOL = 1;
let warnedInsecure = false;
export interface ClientOptions {
  url: string;
  token?: string;
  author?: string;
}

export class GraftApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

export class GraftClient {
  readonly url: string;
  constructor(private opts: ClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    if (opts.token && !warnedInsecure) {
      try {
        const u = new URL(this.url);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        if (u.protocol === "http:" && !local) {
          warnedInsecure = true;
          process.stderr.write(`graft: warning: sending GRAFT_TOKEN over plain http to ${u.host}; use https (see DEPLOY.md)\n`);
        }
      } catch {}
    }
  }

  static fromEnv(overrides: Partial<ClientOptions> = {}): GraftClient {
    return new GraftClient({
      url: overrides.url ?? process.env.GRAFT_URL ?? "http://localhost:7070",
      token: overrides.token ?? process.env.GRAFT_TOKEN,
      author: overrides.author ?? process.env.GRAFT_AUTHOR,
    });
  }

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...extra, "x-graft-protocol": String(CLIENT_PROTOCOL), "user-agent": `graft-client/${VERSION}` };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    if (this.opts.author) h["x-graft-author"] = this.opts.author;
    return h;
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown; raw?: Buffer } = {}): Promise<T> {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
    let body: any;
    const headers = this.headers();
    if (opts.raw) {
      body = opts.raw;
      headers["content-type"] = "application/octet-stream";
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetch(u, { method, headers, body });
    } catch (e: any) {
      // A pooled keep-alive socket the server already closed fails before the request is processed:
      // retry once on a fresh connection.
      const code = e?.cause?.code;
      if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") {
        try {
          res = await fetch(u, { method, headers, body });
        } catch (e2: any) {
          throw new GraftApiError(0, `cannot reach graft server at ${this.url}: ${e2?.cause?.code ?? e2?.message ?? e2}`, null);
        }
      } else throw new GraftApiError(0, `cannot reach graft server at ${this.url}: ${code ?? e?.message ?? e}`, null);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      if (!res.ok) throw new GraftApiError(res.status, `HTTP ${res.status}`, null);
      return Buffer.from(await res.arrayBuffer()) as any;
    }
    const data = await res.json();
    if (!res.ok) throw new GraftApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
    return data as T;
  }

  r(repo: string) {
    return `/api/repos/${encodeURIComponent(repo)}`;
  }

  health() {
    return this.request("GET", "/api/health");
  }
  version(): Promise<{ service: string; version: string; protocol: number; minProtocol: number }> {
    return this.request("GET", "/api/version");
  }
  listRepos() {
    return this.request("GET", "/api/repos");
  }
  createRepo(name: string, description?: string) {
    return this.request("POST", "/api/repos", { body: { name, description } });
  }
  repo(repo: string) {
    return this.request("GET", this.r(repo));
  }
  resolve(repo: string, rev?: string): Promise<{ changeset: string }> {
    return this.request("GET", `${this.r(repo)}/resolve`, { query: { rev } });
  }
  changeset(repo: string, id: string) {
    return this.request("GET", `${this.r(repo)}/changesets/${encodeURIComponent(id)}`);
  }
  commit(repo: string, body: { base?: string; branch?: string; changes: any[]; message: string; author?: string; land?: boolean | string; expectedHead?: string; allowEmpty?: boolean }) {
    return this.request("POST", `${this.r(repo)}/commit`, { body });
  }
  land(repo: string, changeset: string, branch = "main") {
    return this.request("POST", `${this.r(repo)}/land`, { body: { changeset, branch } });
  }
  setRef(repo: string, name: string, target: string | null, expected?: string | null) {
    return this.request("POST", `${this.r(repo)}/refs`, { body: { name, target, expected } });
  }
  tree(repo: string, rev?: string, path?: string) {
    return this.request("GET", `${this.r(repo)}/tree`, { query: { rev, path } });
  }
  file(repo: string, path: string, rev?: string, offset?: number, limit?: number) {
    return this.request("GET", `${this.r(repo)}/file`, { query: { rev, path, offset, limit } });
  }
  manifest(repo: string, rev?: string, prefixes: string[] = []): Promise<{ changeset: string; entries: [string, string][] }> {
    return this.request("GET", `${this.r(repo)}/manifest`, { query: { rev, prefix: prefixes } });
  }
  files(repo: string, pattern: string, rev?: string, limit?: number) {
    return this.request("GET", `${this.r(repo)}/files`, { query: { rev, pattern, limit } });
  }
  log(repo: string, rev?: string, path?: string, limit?: number) {
    return this.request("GET", `${this.r(repo)}/log`, { query: { rev, path, limit } });
  }
  diff(repo: string, to?: string, from?: string, paths?: string[], patch?: boolean) {
    return this.request("GET", `${this.r(repo)}/diff`, { query: { to, from, path: paths, patch } });
  }
  blame(repo: string, path: string, rev?: string) {
    return this.request("GET", `${this.r(repo)}/blame`, { query: { rev, path } });
  }
  mergeBase(repo: string, a: string, b: string) {
    return this.request("GET", `${this.r(repo)}/merge-base`, { query: { a, b } });
  }
  search(repo: string, q: string, o: { rev?: string; regex?: boolean; ignoreCase?: boolean; prefix?: string; glob?: string; limit?: number } = {}) {
    return this.request("GET", `${this.r(repo)}/search`, { query: { q, ...o } });
  }
  missingBlobs(hashes: string[]): Promise<{ missing: string[] }> {
    return this.request("POST", "/api/blobs/missing", { body: { hashes } });
  }
  uploadBlobs(blobs: Buffer[]): Promise<{ blobs: string[] }> {
    return this.request("POST", "/api/blobs/upload", { body: { blobs: blobs.map((b) => b.toString("base64")) } });
  }
  async getBlobs(hashes: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    for (let i = 0; i < hashes.length; i += 1000) {
      const r = await this.request<{ blobs: Record<string, string | null> }>("POST", "/api/blobs/get", { body: { hashes: hashes.slice(i, i + 1000) } });
      for (const [h, b64] of Object.entries(r.blobs)) if (b64 !== null) out.set(h, Buffer.from(b64, "base64"));
    }
    return out;
  }
}
