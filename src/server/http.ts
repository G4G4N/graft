import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "../core/store.js";
import { GraftError } from "../core/types.js";
import { isHash, sha256 } from "../core/hash.js";
import { isBinary } from "../core/diff.js";

export interface ServerOptions {
  store: Store;
  /** Optional bearer token required for every /api request. */
  token?: string;
  /** Optional read-only token (GET requests only). */
  readToken?: string;
  /** Directory with the static web viewer. */
  webRoot?: string;
  /** Max size of a raw blob upload (default 64 MiB). */
  maxBodyBytes?: number;
  /** Max size of a JSON request body (default 16 MiB). */
  maxJsonBytes?: number;
  /**
   * Host names the server answers to (DNS-rebinding protection). Default: loopback names only when no
   * token is configured, any host when a token is configured. Entries may include a port.
   */
  allowedHosts?: string[];
  /** Server version reported in /api/version and the x-graft-version header. */
  version?: string;
  log?: (line: string) => void;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** Headers every response carries. */
const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
};

/** The viewer runs only its own script; repository content is never executed. */
const VIEWER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** Repository bytes are served as inert downloads, never as documents in the viewer's origin. */
const RAW_HEADERS: Record<string, string> = {
  "content-type": "application/octet-stream",
  "content-disposition": "attachment",
  "content-security-policy": "sandbox; default-src 'none'",
};

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<any>;
  /** Raw binary body; requires content-type application/octet-stream. */
  binary: () => Promise<Buffer>;
  author: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function createGraftServer(opts: ServerOptions): Server {
  const { store } = opts;
  const maxBody = opts.maxBodyBytes ?? 64 * 1024 * 1024;
  const maxJson = opts.maxJsonBytes ?? 16 * 1024 * 1024;
  const version = opts.version ?? "0.0.0";
  const allowedHosts = (opts.allowedHosts ?? (opts.token || opts.readToken ? null : LOOPBACK_HOSTS))?.map((h) => h.toLowerCase());
  const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
  const route = (method: string, pattern: string, h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        pattern.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, re, keys, h });
  };
  const q = (ctx: Ctx, k: string) => ctx.query.get(k) ?? undefined;
  const qInt = (ctx: Ctx, k: string) => {
    const v = ctx.query.get(k);
    return v ? parseInt(v, 10) : undefined;
  };
  const qBool = (ctx: Ctx, k: string) => {
    const v = ctx.query.get(k);
    return v === null ? undefined : v === "1" || v === "true";
  };

  // ------------------------------------------------------------------ routes
  route("GET", "/api/health", () => ({ ok: true, service: "graft", version }));
  route("GET", "/api/version", () => ({ service: "graft", version, protocol: PROTOCOL_VERSION, minProtocol: MIN_PROTOCOL_VERSION }));

  route("GET", "/api/repos", () => ({ repos: store.listRepos() }));
  route("POST", "/api/repos", async (c) => {
    const b = await c.body();
    if (typeof b.name !== "string") throw new GraftError(400, "name must be a string");
    return store.createRepo(b.name, typeof b.description === "string" ? b.description : "", c.author);
  });
  route("GET", "/api/repos/:repo", (c) => store.getRepo(c.params.repo));

  route("GET", "/api/repos/:repo/refs", (c) => ({ refs: store.getRepo(c.params.repo).refs }));
  route("POST", "/api/repos/:repo/refs", async (c) => {
    const b = await c.body();
    if (typeof b.name !== "string") throw new GraftError(400, "name must be a string");
    if (b.target !== undefined && b.target !== null && typeof b.target !== "string") throw new GraftError(400, "target must be a string or null");
    return store.setRef(c.params.repo, b.name, b.target ?? null, b.expected);
  });

  route("GET", "/api/repos/:repo/resolve", (c) => ({ changeset: store.resolve(c.params.repo, q(c, "rev")) }));

  route("GET", "/api/repos/:repo/changesets/:id", (c) => {
    const id = store.resolve(c.params.repo, c.params.id);
    return store.changeset(id);
  });

  // The agent fast path: create a changeset on the server and (by default) land it, in one round trip.
  route("POST", "/api/repos/:repo/commit", async (c) => {
    const b = await c.body();
    const landBranch = typeof b.land === "string" ? b.land : typeof b.branch === "string" ? b.branch : undefined;
    const cs = store.commit(c.params.repo, {
      // Default base: the branch being landed on (so edits apply to what the agent will land onto).
      base: b.base ?? landBranch,
      changes: b.changes,
      message: b.message,
      author: b.author || c.author,
      mergeParent: b.mergeParent,
      allowEmpty: !!b.allowEmpty,
    });
    const files = store.changeStatus(cs.id);
    const landTo = b.land === false ? null : (landBranch ?? "main");
    if (!landTo) return { changeset: cs, files, land: null };
    const land = store.land(c.params.repo, cs.id, landTo, { expectedHead: b.expectedHead });
    return { changeset: cs, files, land };
  });

  route("POST", "/api/repos/:repo/land", async (c) => {
    const b = await c.body();
    if (typeof b.changeset !== "string") throw new GraftError(400, "changeset must be a string");
    return store.land(c.params.repo, b.changeset, typeof b.branch === "string" ? b.branch : "main", { expectedHead: b.expectedHead });
  });

  route("GET", "/api/repos/:repo/tree", (c) => {
    const id = store.resolve(c.params.repo, q(c, "rev"));
    return { changeset: id, path: q(c, "path") ?? "", entries: store.tree(c.params.repo, id, q(c, "path") ?? "") };
  });

  route("GET", "/api/repos/:repo/file", (c) => {
    const f = store.readFile(c.params.repo, q(c, "rev"), q(c, "path") ?? "");
    if (isBinary(f.data)) return { changeset: f.changeset, blob: f.blob, binary: true, size: f.data.length, contentBase64: f.data.toString("base64") };
    const text = f.data.toString("utf8");
    const offset = qInt(c, "offset");
    const limit = qInt(c, "limit");
    if (offset || limit) {
      const lines = text.split("\n");
      const start = Math.max((offset ?? 1) - 1, 0);
      const end = limit ? start + limit : lines.length;
      return {
        changeset: f.changeset,
        blob: f.blob,
        binary: false,
        size: f.data.length,
        totalLines: lines.length,
        offset: start + 1,
        content: lines.slice(start, end).join("\n"),
      };
    }
    return { changeset: f.changeset, blob: f.blob, binary: false, size: f.data.length, content: text };
  });

  route("GET", "/api/repos/:repo/raw", (c) => {
    const f = store.readFile(c.params.repo, q(c, "rev"), q(c, "path") ?? "");
    c.res.writeHead(200, { ...BASE_HEADERS, ...RAW_HEADERS, "x-graft-blob": f.blob, "x-graft-changeset": f.changeset });
    c.res.end(f.data);
    return SENT;
  });

  route("GET", "/api/repos/:repo/manifest", (c) => {
    const prefixes = c.query.getAll("prefix");
    return store.manifestEntries(c.params.repo, q(c, "rev"), prefixes);
  });

  route("GET", "/api/repos/:repo/files", (c) => store.findFiles(c.params.repo, q(c, "rev"), q(c, "pattern") ?? "**", qInt(c, "limit")));

  route("GET", "/api/repos/:repo/log", (c) =>
    store.log(c.params.repo, q(c, "rev"), { path: q(c, "path"), limit: qInt(c, "limit") }),
  );

  route("GET", "/api/repos/:repo/diff", (c) =>
    store.diff(c.params.repo, q(c, "to") ?? q(c, "rev"), q(c, "from"), {
      paths: c.query.getAll("path"),
      patch: qBool(c, "patch"),
      stat: qBool(c, "stat"),
      context: qInt(c, "context"),
    }),
  );

  route("GET", "/api/repos/:repo/blame", (c) => store.blame(c.params.repo, q(c, "rev"), q(c, "path") ?? ""));

  route("GET", "/api/repos/:repo/merge-base", (c) => ({
    mergeBase: store.mergeBase(c.params.repo, q(c, "a") ?? "main", q(c, "b") ?? "main"),
  }));

  route("GET", "/api/repos/:repo/search", (c) =>
    store.search(c.params.repo, q(c, "rev"), q(c, "q") ?? "", {
      regex: qBool(c, "regex"),
      ignoreCase: qBool(c, "ignoreCase"),
      prefix: q(c, "prefix"),
      glob: q(c, "glob"),
      limit: qInt(c, "limit"),
    }),
  );

  // ---- content-addressed blobs (immutable; any cache tier can serve them)
  route("POST", "/api/blobs/missing", async (c) => {
    const b = await c.body();
    const hashes: string[] = Array.isArray(b.hashes) ? b.hashes : [];
    return { missing: hashes.filter((h) => !isHash(h) || !store.blobs.has(h)) };
  });
  route("POST", "/api/blobs", async (c) => {
    const data = await c.binary();
    return { blob: store.blobs.put(data), size: data.length };
  });
  route("PUT", "/api/blobs/:hash", async (c) => {
    const data = await c.binary();
    if (sha256(data) !== c.params.hash) throw new GraftError(400, "blob content does not match hash");
    store.blobs.put(data);
    return { blob: c.params.hash, size: data.length };
  });
  route("POST", "/api/blobs/upload", async (c) => {
    // Batch upload: { blobs: [base64, ...] }
    const b = await c.body();
    const list: unknown[] = Array.isArray(b.blobs) ? b.blobs : [];
    if (list.some((x) => typeof x !== "string")) throw new GraftError(400, "blobs must be base64 strings");
    return { blobs: list.map((x) => store.blobs.put(Buffer.from(x as string, "base64"))) };
  });
  route("POST", "/api/blobs/get", async (c) => {
    const b = await c.body();
    const hashes: string[] = Array.isArray(b.hashes) ? b.hashes.slice(0, 5000) : [];
    const out: Record<string, string | null> = {};
    for (const h of hashes) {
      const d = isHash(h) ? store.blobs.get(h) : null;
      out[h] = d ? d.toString("base64") : null;
    }
    return { blobs: out };
  });
  route("GET", "/api/blobs/:hash", (c) => {
    const d = isHash(c.params.hash) ? store.blobs.get(c.params.hash) : null;
    if (!d) throw new GraftError(404, "no such blob");
    c.res.writeHead(200, {
      ...BASE_HEADERS,
      ...RAW_HEADERS,
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${c.params.hash}"`,
    });
    c.res.end(d);
    return SENT;
  });

  // ------------------------------------------------------------------ dispatch
  // Compare fixed-length digests so neither content nor length of the token leaks through timing.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const tokenOk = (given: string | undefined, expected: string | undefined) => {
    if (!expected || !given) return false;
    return timingSafeEqual(digest(given), digest(expected));
  };
  const hostOk = (hostHeader: string | undefined) => {
    if (!allowedHosts) return true;
    if (!hostHeader) return false;
    const h = hostHeader.toLowerCase();
    const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
    return allowedHosts.includes(h) || allowedHosts.includes(name);
  };

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    res.setHeader("x-graft-version", version);
    try {
      // DNS rebinding: a hostile page whose domain resolves to this machine must not reach the API.
      if (!hostOk(req.headers.host)) throw new GraftError(421, "host not allowed (set GRAFT_ALLOWED_HOSTS to serve this name)");
      if (!path.startsWith("/api/")) return serveStatic(opts.webRoot, path, res);
      // Cross-site requests: browsers can send "simple" POSTs to any origin without a preflight.
      // The API is for agents, CLIs and the same-origin viewer, so refuse anything a browser marks cross-site.
      const site = req.headers["sec-fetch-site"];
      if (site === "cross-site" || site === "same-site") throw new GraftError(403, "cross-site requests are not allowed");
      const origin = req.headers.origin;
      if (origin && origin !== "null") {
        let originHost = "";
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {}
        if (originHost !== String(req.headers.host ?? "").toLowerCase()) throw new GraftError(403, "cross-origin requests are not allowed");
      } else if (origin === "null") throw new GraftError(403, "cross-origin requests are not allowed");
      const proto = req.headers["x-graft-protocol"];
      if (proto !== undefined) {
        const p = parseInt(String(proto), 10);
        if (!(p >= MIN_PROTOCOL_VERSION && p <= PROTOCOL_VERSION)) {
          throw new GraftError(426, `client speaks protocol ${proto}; this server (v${version}) supports ${MIN_PROTOCOL_VERSION}..${PROTOCOL_VERSION}. Upgrade the older side.`);
        }
      }
      if (opts.token || opts.readToken) {
        const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        const full = tokenOk(auth, opts.token);
        const read = tokenOk(auth, opts.readToken) && req.method === "GET";
        // Health and version are public: probes and `graft version` need them, and they reveal nothing else.
        const open = path === "/api/health" || path === "/api/version";
        if (!full && !read && !open) throw new GraftError(401, "missing or invalid bearer token");
      }
      const m = routes.find((r) => r.method === req.method && r.re.test(path));
      if (!m) {
        const any = routes.some((r) => r.re.test(path));
        throw new GraftError(any ? 405 : 404, any ? "method not allowed" : `no route: ${req.method} ${path}`);
      }
      const match = m.re.exec(path)!;
      const params: Record<string, string> = {};
      try {
        m.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1])));
      } catch {
        throw new GraftError(400, "malformed URL encoding");
      }
      const ctype = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const ctx: Ctx = {
        req,
        res,
        params,
        query: url.searchParams,
        binary: async () => {
          if (ctype !== "application/octet-stream") throw new GraftError(415, "blob uploads must use content-type application/octet-stream");
          return readBody(req, maxBody);
        },
        body: async () => {
          const r = await readBody(req, maxJson);
          if (!r.length) return {};
          // Requiring application/json forces a CORS preflight in browsers, which this server never answers.
          if (ctype !== "application/json") throw new GraftError(415, "request body must use content-type application/json");
          let v: unknown;
          try {
            v = JSON.parse(r.toString("utf8"));
          } catch {
            throw new GraftError(400, "request body must be JSON");
          }
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new GraftError(400, "request body must be a JSON object");
          return v;
        },
        author: String(req.headers["x-graft-author"] ?? "agent").slice(0, 200),
      };
      const out = await m.h(ctx);
      if (out !== SENT) json(res, 200, out);
      opts.log?.(`${req.method} ${path} 200 ${Date.now() - started}ms`);
    } catch (e: any) {
      const status = e instanceof GraftError ? e.status : 500;
      if (status === 500) {
        // Never echo internal errors (paths, driver messages) to clients; log them with an id instead.
        const id = randomBytes(6).toString("hex");
        opts.log?.(`ERROR ${id} ${req.method} ${path}: ${e?.stack ?? e}`);
        if (!res.headersSent) json(res, 500, { error: `internal error (id ${id})`, status: 500 });
        else res.end();
      } else {
        opts.log?.(`${req.method} ${path} ${status} ${Date.now() - started}ms`);
        if (!res.headersSent) json(res, status, { error: e?.message ?? String(e), status, details: e?.details });
        else res.end();
      }
    }
  });
  // Agents and CI hold long-lived pooled connections; keep them open longer than typical client idle gaps.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  return server;
}

const SENT = Symbol("sent");

/** Wire protocol: bump PROTOCOL_VERSION for additive API changes, MIN_PROTOCOL_VERSION when dropping old behavior. */
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new GraftError(413, `request body exceeds ${max} bytes`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(root: string | undefined, path: string, res: ServerResponse) {
  if (!root) {
    json(res, 404, { error: "web viewer not configured" });
    return;
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {}
  let rel = normalize(decoded).replace(/^([/\\])+/, "");
  if (rel.startsWith("..")) rel = "";
  let file = join(root, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
  if (!file.startsWith(root)) file = join(root, "index.html");
  const data = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "content-security-policy": VIEWER_CSP,
  });
  res.end(data);
}
