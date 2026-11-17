/**
 * Live swarm dashboard. Serves swarm/dashboard/ and tails run directories:
 *   - sim runs:  <runs>/<id>/meta.json + events.jsonl (written by sim.ts)
 *   - real runs: <runs>/<id>/meta.json with kind "real" and trace sources:
 *       { system: "graft", file: ".../graft-trace.jsonl" }         (graft CLI GRAFT_TRACE)
 *       { system: "git",   dir:  ".../git-trace2/" }               (git trace2 event files)
 * node dist/src/swarm/dashboard.js [--port 7300] [--runs swarm/runs]
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const port = parseInt(flag("port", "7300"), 10);
const runsDir = resolve(flag("runs", join(root, "swarm/runs")));
const web = join(root, "swarm/dashboard");

function listRuns() {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((d) => existsSync(join(runsDir, d, "meta.json")))
    .map((d) => {
      try {
        return JSON.parse(readFileSync(join(runsDir, d, "meta.json"), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => (a.startedAt < b.startedAt ? 1 : -1));
}

function simEvents(id: string, since: number) {
  const f = join(runsDir, id, "events.jsonl");
  if (!existsSync(f)) return { events: [], next: since };
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const events: any[] = [];
  for (const l of lines.slice(since)) {
    try {
      events.push(JSON.parse(l));
    } catch {
      break; // partially written line; pick it up next poll
    }
  }
  return { events, next: since + events.length };
}

/** Convert real-agent traces into the same event shape as sim runs. */
function realEvents(meta: any) {
  const t0 = Date.parse(meta.startedAt);
  const agentIndex = new Map<string, number>((meta.agentsList ?? []).map((a: string, i: number) => [a, i]));
  const idx = (name: string) => {
    if (!agentIndex.has(name)) agentIndex.set(name, agentIndex.size);
    return agentIndex.get(name)!;
  };
  const events: any[] = [];
  for (const src of meta.sources ?? []) {
    if (src.system === "graft" && existsSync(src.file)) {
      for (const l of readFileSync(src.file, "utf8").split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(l);
          events.push({ t: e.start - t0, ms: e.ms, agent: idx(e.agent ?? "?"), kind: "op", op: e.cmd, ok: e.ok && !e.exit, system: "graft" });
        } catch {}
      }
    }
    if (src.system === "git" && existsSync(src.dir)) {
      for (const f of readdirSync(src.dir)) {
        const agent = f.replace(/\.trace$/, "");
        const starts = new Map<string, { time: number; argv: string[] }>();
        for (const l of readFileSync(join(src.dir, f), "utf8").split("\n").filter(Boolean)) {
          try {
            const e = JSON.parse(l);
            if (String(e.sid).includes("/")) continue; // child git processes are part of their parent
            if (e.event === "start") starts.set(e.sid, { time: Date.parse(e.time), argv: e.argv ?? [] });
            else if (e.event === "exit") {
              const s = starts.get(e.sid);
              if (!s) continue;
              const sub = s.argv.slice(1).find((a: string) => !a.startsWith("-")) ?? "git";
              events.push({ t: s.time - t0, ms: Math.round(e.t_abs * 1000), agent: idx(agent), kind: "op", op: sub, ok: e.code === 0, system: "git" });
            }
          } catch {}
        }
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, agents: [...agentIndex.keys()] };
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/** Resolve `rel` under `base`, or null if it would escape (checked after decoding). */
function within(base: string, ...rel: string[]): string | null {
  const full = resolve(base, ...rel);
  return full === base || full.startsWith(base + sep) ? full : null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  // Loopback-only tool: refuse other Host names (DNS rebinding).
  const hostName = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostName)) {
    res.writeHead(421).end("host not allowed");
    return;
  }
  const json = (v: unknown) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(v));
  };
  try {
    if (url.pathname === "/api/runs") return json({ runs: listRuns() });
    const m = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const dir = within(runsDir, id);
      if (!dir || id.includes("/") || id.includes("\\")) throw new Error("bad id");
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      if (meta.kind === "real") return json({ ...realEvents(meta), next: 0, replace: true });
      return json(simEvents(id, parseInt(url.searchParams.get("since") ?? "0", 10)));
    }
    const appMatch = /^\/app\/([^/]+)\/(.*)$/.exec(url.pathname);
    let file: string | null;
    if (appMatch) {
      // Serve the web app a finished run produced, so you can click through what the agents built.
      // Decode first, then confine: checking for ".." before decoding let %2e%2e%2f through.
      const runDir = within(runsDir, decodeURIComponent(appMatch[1]));
      file = runDir ? within(join(runDir, "app"), decodeURIComponent(appMatch[2]) || "index.html") : null;
    } else {
      file = within(web, decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    }
    if (!file || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (e: any) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e?.message ?? e));
  }
}).listen(port, "127.0.0.1", () => console.log(`swarm dashboard: http://localhost:${port}/  (runs: ${runsDir})`));
