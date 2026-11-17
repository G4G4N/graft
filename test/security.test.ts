// Security behavior: each test pins one defense described in SECURITY.md (threat model).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { MemoryBlobStore } from "../src/core/blobstore.js";
import { Store } from "../src/core/store.js";
import { createGraftServer } from "../src/server/http.js";
import { GraftClient } from "../src/client/api.js";
import { Workspace } from "../src/cli/workspace.js";
import { sha256 } from "../src/core/hash.js";

let open: Server; // no token: loopback-only rules apply
let authed: Server; // token configured
let openUrl: string;
let authedUrl: string;
let dir: string;
const TOKEN = "s3cret-token-0123456789abcdef";

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

/** Raw request with full control over headers (fetch forbids setting Host / Sec-Fetch-*). */
function raw(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  const u = new URL(base + path);
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const r = httpRequest({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "graft-sec-"));
  const s1 = new Store(openDb(":memory:"), new MemoryBlobStore());
  s1.createRepo("r");
  s1.land("r", s1.commit("r", { message: "seed", changes: [{ path: "evil.html", content: "<script>alert(1)</script>" }] }).id);
  open = createGraftServer({ store: s1, webRoot: join(process.cwd(), "web") });
  openUrl = await listen(open);
  const s2 = new Store(openDb(":memory:"), new MemoryBlobStore());
  s2.createRepo("r");
  authed = createGraftServer({ store: s2, token: TOKEN });
  authedUrl = await listen(authed);
});
after(() => {
  open.close();
  authed.close();
  rmSync(dir, { recursive: true, force: true });
});

const commitBody = JSON.stringify({ message: "pwn", changes: [{ path: "x.txt", content: "x" }] });

test("cross-site writes are refused (content-type, Origin, Sec-Fetch-Site)", async () => {
  // A browser form / fetch with text/plain needs no preflight: must not be accepted as JSON.
  assert.equal((await raw(openUrl, "POST", "/api/repos/r/commit", { "content-type": "text/plain" }, commitBody)).status, 415);
  const host = new URL(openUrl).host;
  assert.equal((await raw(openUrl, "POST", "/api/repos/r/commit", { "content-type": "application/json", origin: "https://evil.example" }, commitBody)).status, 403);
  assert.equal((await raw(openUrl, "POST", "/api/repos/r/commit", { "content-type": "application/json", origin: "null" }, commitBody)).status, 403);
  assert.equal((await raw(openUrl, "GET", "/api/repos", { "sec-fetch-site": "cross-site" })).status, 403);
  // Same-origin (the viewer) and non-browser clients still work.
  assert.equal((await raw(openUrl, "POST", "/api/repos/r/commit", { "content-type": "application/json", origin: `http://${host}` }, commitBody)).status, 200);
  assert.equal((await raw(openUrl, "POST", "/api/blobs", { "content-type": "text/plain" }, "abc")).status, 415);
});

test("without a token, only loopback host names are served", async () => {
  assert.equal((await raw(openUrl, "GET", "/api/repos", { host: "evil.example:7070" })).status, 421);
  assert.equal((await raw(openUrl, "GET", "/", { host: "evil.example" })).status, 421);
  assert.equal((await raw(openUrl, "GET", "/api/repos", { host: "localhost:7070" })).status, 200);
  // With a token, any host name is fine (reverse proxies, custom domains) but auth is required.
  assert.equal((await raw(authedUrl, "GET", "/api/repos", { host: "graft.example.com" })).status, 401);
  // Probes work without the token; nothing else does.
  assert.equal((await raw(authedUrl, "GET", "/api/health")).status, 200);
  assert.equal((await raw(authedUrl, "GET", "/api/version")).status, 200);
  assert.equal((await raw(authedUrl, "GET", "/api/repos", { host: "graft.example.com", authorization: `Bearer ${TOKEN}` })).status, 200);
});

test("the server refuses to listen beyond loopback without a token", async () => {
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/src/server/main.js"], {
        env: { ...process.env, GRAFT_DATA: join(dir, "srv"), PORT: "0", GRAFT_QUIET: "1", ...env },
      });
      let out = "";
      p.stderr.on("data", (d) => (out += d));
      const t = setTimeout(() => p.kill(), 4000);
      p.on("exit", (code) => {
        clearTimeout(t);
        resolve({ code, out });
      });
    });
  const a = await run({ GRAFT_HOST: "0.0.0.0", GRAFT_TOKEN: "" });
  assert.equal(a.code, 2);
  assert.match(a.out, /refusing to listen/);
  const b = await run({ GRAFT_HOST: "0.0.0.0", GRAFT_TOKEN: "short" });
  assert.equal(b.code, 2);
  assert.match(b.out, /at least 16/);
});

test("the CLI refuses server paths that escape the workspace", async () => {
  const content = Buffer.from("owned\n");
  const h = sha256(content);
  for (const badPath of ["../escaped.txt", "a/../../escaped.txt", "/etc/escaped.txt", ".git/hooks/post-checkout"]) {
    // A malicious server returning a hostile manifest.
    const evil = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/api/repos/r/manifest")) res.end(JSON.stringify({ changeset: "c".repeat(64), entries: [[badPath, h]] }));
      else if (req.url!.startsWith("/api/blobs/get")) res.end(JSON.stringify({ blobs: { [h]: content.toString("base64") } }));
      else res.end("{}");
    });
    const url = await listen(evil);
    const ws = join(dir, `ws-${Math.random().toString(36).slice(2)}`);
    const out = await new Promise<string>((resolve) =>
      execFile(process.execPath, ["dist/src/cli/graft.js", "clone", "r", ws], { env: { ...process.env, GRAFT_URL: url, GRAFT_CACHE: join(dir, "cache") } }, (err, so, se) =>
        resolve(`${err ? "EXIT" : "OK"} ${so}${se}`),
      ),
    );
    evil.close();
    assert.match(out, /^EXIT .*refusing/s, `${badPath}: ${out}`);
    assert.ok(!existsSync(join(dir, "escaped.txt")) && !existsSync("/etc/escaped.txt"));
    assert.ok(!existsSync(join(ws, ".git", "hooks", "post-checkout")));
  }
});

test("the CLI refuses to write through a symlink that leaves the workspace", () => {
  const root = join(dir, "ws-symlink");
  mkdirSync(root);
  const ws = Workspace.init(root, { server: "http://127.0.0.1:1", repo: "r", branch: "main", base: "", sparse: [] });
  const outside = join(dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(root, "link"));
  assert.throws(() => ws.abs("link/x.txt"), /symlink/);
  assert.equal(ws.abs("ok/x.txt"), join(root, "ok", "x.txt"));
});

test("the server rejects .git paths so repositories cannot carry hooks", async () => {
  const c = new GraftClient({ url: openUrl });
  await assert.rejects(c.commit("r", { message: "m", changes: [{ path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }] }), /\.git segment/);
  await assert.rejects(c.commit("r", { message: "m", changes: [{ path: "sub/.GIT/config", content: "x" }] }), /\.git segment/);
});

test("repository content is served as an inert download; the viewer has a strict CSP", async () => {
  const r = await raw(openUrl, "GET", "/api/repos/r/raw?path=evil.html");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.equal(r.headers["content-disposition"], "attachment");
  assert.match(r.headers["content-security-policy"], /sandbox/);
  const page = await raw(openUrl, "GET", "/");
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
});

test("internal errors are not echoed to clients", async () => {
  const boom = new Proxy({} as Store, {
    get: () => () => {
      throw new Error("ENOENT: /secret/internal/path/graft.db");
    },
  });
  const s = createGraftServer({ store: boom });
  const url = await listen(s);
  const r = await raw(url, "GET", "/api/repos");
  s.close();
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.body, /secret|ENOENT/);
  assert.match(r.body, /internal error \(id [0-9a-f]+\)/);
});

test("versioning: /api/version, x-graft-version header and protocol negotiation", async () => {
  const v = await new GraftClient({ url: openUrl }).version();
  assert.equal(v.service, "graft");
  assert.equal(v.protocol, 1);
  const r = await raw(openUrl, "GET", "/api/health");
  assert.ok(r.headers["x-graft-version"]);
  const bad = await raw(openUrl, "GET", "/api/repos", { "x-graft-protocol": "99" });
  assert.equal(bad.status, 426);
  assert.match(bad.body, /Upgrade the older side/);
});

test("dashboard: no traversal through encoded dot segments, loopback host only", async () => {
  const runs = join(dir, "runs");
  mkdirSync(join(runs, "run1", "app"), { recursive: true });
  writeFileSync(join(runs, "run1", "app", "index.html"), "ok");
  writeFileSync(join(dir, "secret.txt"), "TOP SECRET");
  const port = 21000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, ["dist/src/swarm/dashboard.js", "--port", String(port), "--runs", runs], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await raw(base, "GET", "/api/runs");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    assert.equal((await raw(base, "GET", "/app/run1/index.html")).body, "ok");
    for (const evil of ["/app/run1/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt", "/app/%2e%2e/secret.txt", "/app/run1/..%2f..%2f..%2fsecret.txt", "/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt"]) {
      const r = await raw(base, "GET", evil);
      assert.ok(!r.body.includes("TOP SECRET"), evil);
    }
    assert.equal((await raw(base, "GET", "/api/runs", { host: "evil.example" })).status, 421);
  } finally {
    p.kill();
  }
  void readFileSync;
});
