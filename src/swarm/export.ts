/**
 * Collect swarm results into one JSON document for the report:
 *   - scale: summary per (mode, agents) for the newest "scale" runs
 *   - timelines: compact event lanes for a chosen agent count, per mode
 *   - real: per-agent timing from real-agent traces (git trace2 / GRAFT_TRACE)
 * node dist/src/swarm/export.js [--runs swarm/runs] [--timeline-agents 16] [--out docs/data/results.json]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const runsDir = resolve(flag("runs", join(root, "swarm/runs")));
const out = resolve(flag("out", join(root, "docs/data/results.json")));
const timelineAgents = parseInt(flag("timeline-agents", "16"), 10);

const metas = readdirSync(runsDir)
  .filter((d) => existsSync(join(runsDir, d, "meta.json")))
  .map((d) => JSON.parse(readFileSync(join(runsDir, d, "meta.json"), "utf8")))
  .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

// newest done scale run per (mode, agents)
const scale = new Map<string, any>();
for (const m of metas) {
  if (m.kind !== "sim" || m.status !== "done" || m.label !== "scale") continue;
  const k = `${m.mode}:${m.agents}`;
  if (!scale.has(k)) scale.set(k, m);
}

const events = (id: string) =>
  readFileSync(join(runsDir, id, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const timelines: Record<string, any> = {};
for (const mode of ["graft", "graft-cli", "git"]) {
  const m = scale.get(`${mode}:${timelineAgents}`);
  if (!m) continue;
  // [t, ms, agent, kindCode, op] — compact rows
  // kind codes: 0 think, 1 op, 2 conflict, 4 land (landing time = t + ms)
  const kinds: Record<string, number> = { think: 0, op: 1, conflict: 2, land: 4 };
  const rows = events(m.id)
    .filter((e) => e.agent !== undefined && e.kind in kinds)
    .map((e) => [e.t, e.ms ?? 0, e.agent, kinds[e.kind], e.op ?? ""]);
  timelines[mode] = { id: m.id, agents: m.agents, wallMs: m.summary.wallMs, rows };
}

// Per-op latency breakdown for each mode at the timeline agent count.
const opBreakdown: Record<string, any> = {};
for (const mode of ["graft", "graft-cli", "git"]) {
  const m = scale.get(`${mode}:${timelineAgents}`);
  if (!m) continue;
  const by = new Map<string, number[]>();
  for (const e of events(m.id)) if (e.kind === "op") (by.get(e.op) ?? by.set(e.op, []).get(e.op)!).push(e.ms);
  opBreakdown[mode] = [...by].map(([op, xs]) => {
    xs.sort((a, b) => a - b);
    return { op, count: xs.length, p50: xs[Math.floor((xs.length - 1) / 2)], total: xs.reduce((s, x) => s + x, 0) };
  });
}

// Real agents: aggregate traces per agent.
const real: Record<string, any> = {};
// Both real teams share one time origin: the first command either team ran.
let realT0 = Infinity;
for (const m of metas.filter((x) => x.kind === "real")) {
  for (const src of m.sources ?? []) {
    if (src.system === "graft" && existsSync(src.file)) {
      for (const l of readFileSync(src.file, "utf8").split("\n").filter(Boolean)) realT0 = Math.min(realT0, JSON.parse(l).start);
    }
    if (src.system === "git" && existsSync(src.dir)) {
      for (const f of readdirSync(src.dir)) {
        for (const l of readFileSync(join(src.dir, f), "utf8").split("\n").filter(Boolean)) {
          const e = JSON.parse(l);
          if (e.event === "start") realT0 = Math.min(realT0, Date.parse(e.time));
        }
      }
    }
  }
}
for (const m of metas.filter((x) => x.kind === "real")) {
  if (real[m.mode]) continue; // newest only
  const t0 = Number.isFinite(realT0) ? realT0 : Date.parse(m.startedAt);
  const ops: any[] = [];
  for (const src of m.sources ?? []) {
    if (src.system === "graft" && existsSync(src.file)) {
      for (const l of readFileSync(src.file, "utf8").split("\n").filter(Boolean)) {
        const e = JSON.parse(l);
        ops.push({ agent: e.agent, op: e.cmd, t: e.start - t0, ms: e.ms, ok: e.ok && !e.exit, exit: e.exit });
      }
    }
    if (src.system === "git" && existsSync(src.dir)) {
      for (const f of readdirSync(src.dir)) {
        const agent = f.replace(/\.trace$/, "");
        const starts = new Map<string, any>();
        for (const l of readFileSync(join(src.dir, f), "utf8").split("\n").filter(Boolean)) {
          const e = JSON.parse(l);
          if (String(e.sid).includes("/")) continue;
          if (e.event === "start") starts.set(e.sid, { time: Date.parse(e.time), argv: e.argv ?? [] });
          if (e.event === "exit" && starts.has(e.sid)) {
            const s = starts.get(e.sid);
            const sub = s.argv.slice(1).find((a: string) => !a.startsWith("-")) ?? "git";
            ops.push({ agent, op: sub, t: s.time - t0, ms: Math.round(e.t_abs * 1000), ok: e.code === 0, exit: e.code });
          }
        }
      }
    }
  }
  ops.sort((a, b) => a.t - b.t);
  const agents = [...new Set([...(m.agentsList ?? []), ...ops.map((o) => o.agent)])];
  const perAgent = agents.map((a) => {
    const mine = ops.filter((o) => o.agent === a);
    const landing = mine.filter((o) => (m.mode === "git" ? o.op === "push" && o.ok : o.op === "commit" && o.ok));
    return {
      agent: a,
      ops: mine.length,
      vcsMs: mine.reduce((s, o) => s + o.ms, 0),
      landed: landing.length,
      failed: mine.filter((o) => !o.ok).length,
      pushRejected: mine.filter((o) => o.op === "push" && !o.ok).length,
      conflicts: m.mode === "git" ? mine.filter((o) => (o.op === "pull" || o.op === "rebase") && !o.ok).length : mine.filter((o) => o.op === "commit" && o.exit === 2).length,
      first: mine[0]?.t ?? null,
      last: mine.length ? mine[mine.length - 1].t + mine[mine.length - 1].ms : null,
    };
  });
  const byOp = new Map<string, number[]>();
  for (const o of ops) (byOp.get(o.op) ?? byOp.set(o.op, []).get(o.op)!).push(o.ms);
  real[m.mode] = {
    id: m.id,
    startedAt: m.startedAt,
    setup: m.setup,
    agents: perAgent,
    ops: ops.map((o) => [o.t, o.ms, agents.indexOf(o.agent), o.ok ? 1 : 0, o.op]),
    agentNames: agents,
    byOp: [...byOp].map(([op, xs]) => {
      xs.sort((a, b) => a - b);
      return { op, count: xs.length, p50: xs[Math.floor((xs.length - 1) / 2)], total: xs.reduce((s, x) => s + x, 0) };
    }),
    finishedAt: m.finishedAt ?? null,
    verify: m.verify ?? null,
  };
}

const doc = {
  generatedAt: new Date().toISOString(),
  host: metas[0]?.host ?? null,
  timelineAgents,
  scale: [...scale.values()]
    .map((m) => ({ id: m.id, mode: m.mode, agents: m.agents, think: m.think, commits: m.commits, ...m.summary }))
    .sort((a, b) => a.agents - b.agents || a.mode.localeCompare(b.mode)),
  timelines,
  opBreakdown,
  real,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc));
console.log(`wrote ${out}: ${doc.scale.length} scale runs, timelines: ${Object.keys(timelines).join(", ")}, real: ${Object.keys(real).join(", ") || "none"}`);
