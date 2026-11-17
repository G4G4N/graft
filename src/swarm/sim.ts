/**
 * Scripted agent swarm: N agents build the Field Guide web app together, through one of
 *   git        — per-agent clone, commit, push; on rejection pull --rebase; on conflict re-apply
 *   graft      — Graft API (what MCP agents do): read at a changeset, commit+land in one call
 *   graft-cli  — Graft CLI workspaces: clone, edit files, `graft commit`
 * Every operation is written to an events.jsonl the live dashboard tails.
 *
 * node --experimental-sqlite dist/src/swarm/sim.js --mode graft --agents 24 [--think 300-1500] [--runs swarm/runs]
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GraftClient } from "../client/api.js";
import { stepsFor, takeUpstream, verify, type Step, type Task } from "./workload.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
type Mode = "git" | "graft" | "graft-cli";
const mode = (args.mode ?? "graft") as Mode;
const N = parseInt(args.agents ?? "16", 10);
const [thinkMin, thinkMax] = (args.think ?? "300-1500").split("-").map(Number);
const runsDir = resolve(args.runs ?? join(root, "swarm/runs"));
const label = args.label ?? "";
const allTasks: Task[] = JSON.parse(readFileSync(join(root, "swarm/tasks.json"), "utf8"));
if (N > allTasks.length) throw new Error(`at most ${allTasks.length} agents (one page each)`);
const tasks = allTasks.slice(0, N);

const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${mode}-${N}`;
const runDir = join(runsDir, runId);
mkdirSync(runDir, { recursive: true });
const eventsFile = join(runDir, "events.jsonl");
const T0 = Date.now();
const now = () => Date.now() - T0;
const work = mkdtempSync(join(tmpdir(), `swarm-${mode}-`));
const node = process.execPath;
const cliPath = join(root, "dist/src/cli/graft.js");

const meta: any = {
  id: runId,
  kind: "sim",
  mode,
  agents: N,
  think: [thinkMin, thinkMax],
  label,
  startedAt: new Date(T0).toISOString(),
  status: "running",
  host: { platform: process.platform, node: process.version },
};
const saveMeta = () => writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
saveMeta();

function emit(e: Record<string, unknown>) {
  appendFileSync(eventsFile, JSON.stringify(e) + "\n");
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", // hermetic: ignore the user's global config (signing, hooks, aliases)
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

interface Res {
  ok: boolean;
  out: string;
}
function run(cmd: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Res> {
  return new Promise((resolve) => {
    execFile(cmd, argv, { cwd: opts.cwd, env: opts.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}` }),
    );
  });
}

/** Run one timed VCS operation and record it. */
async function op<T>(agent: number, step: string, name: string, fn: () => Promise<T>, ok: (r: T) => boolean = () => true): Promise<T> {
  const start = now();
  const r = await fn();
  emit({ t: start, ms: now() - start, agent, step, kind: "op", op: name, ok: ok(r) });
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const think = () => thinkMin + Math.random() * (thinkMax - thinkMin);

// ------------------------------------------------------------------ backends

interface Agent {
  setup(): Promise<void>;
  /** Land one step; returns retries and conflicts it needed. */
  land(step: Step): Promise<{ retries: number; conflicts: number }>;
}

let gitRemote = "";
let graftUrl = "";
let server: ChildProcess | null = null;

async function prepare() {
  if (mode === "git") {
    const seed = join(work, "seed");
    cpSync(join(root, "swarm/seed"), seed, { recursive: true });
    const g = (...a: string[]) => run("git", a, { cwd: seed, env: gitEnv });
    await g("init", "-q", "-b", "main");
    await g("-c", "user.name=seed", "-c", "user.email=seed@swarm", "add", "-A");
    await g("-c", "user.name=seed", "-c", "user.email=seed@swarm", "commit", "-qm", "Seed Field Guide");
    gitRemote = join(work, "origin.git");
    await run("git", ["clone", "-q", "--bare", seed, gitRemote], { env: gitEnv });
    meta.remote = "local bare repository (no network)";
  } else {
    const data = join(work, "server");
    const port = 20000 + Math.floor(Math.random() * 20000);
    server = spawn(node, ["--experimental-sqlite", "--no-warnings", join(root, "dist/src/server/main.js")], {
      env: { ...process.env, GRAFT_DATA: data, PORT: String(port), GRAFT_HOST: "127.0.0.1", GRAFT_QUIET: "1" },
      stdio: "ignore",
    });
    graftUrl = `http://127.0.0.1:${port}`;
    const c = new GraftClient({ url: graftUrl, author: "seed" });
    for (let i = 0; i < 100; i++) {
      try {
        await c.health();
        break;
      } catch {
        await sleep(50);
      }
    }
    await c.createRepo("field-guide", "Built by a swarm");
    const files: { path: string; content: string }[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push({ path: relative(join(root, "swarm/seed"), p), content: readFileSync(p, "utf8") });
      }
    };
    walk(join(root, "swarm/seed"));
    await c.commit("field-guide", { message: "Seed Field Guide", changes: files });
    meta.remote = "graft server process on localhost";
  }
}

function gitAgent(i: number, t: Task): Agent {
  const dir = join(work, `agent-${i}`);
  const env = { ...gitEnv, GIT_AUTHOR_NAME: `agent-${t.slug}`, GIT_AUTHOR_EMAIL: `${t.slug}@swarm`, GIT_COMMITTER_NAME: `agent-${t.slug}`, GIT_COMMITTER_EMAIL: `${t.slug}@swarm` };
  const git = (step: string, name: string, ...a: string[]) => op(i, step, name, () => run("git", a, { cwd: dir, env }), (r) => r.ok);
  const applyLocal = (step: Step) => {
    const files = step.apply((p) => readFileSync(join(dir, p), "utf8"));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
  };
  return {
    async setup() {
      await op(i, "setup", "clone", () => run("git", ["clone", "-q", gitRemote, dir], { env }), (r) => r.ok);
    },
    async land(step) {
      let retries = 0;
      let conflicts = 0;
      // Good agent hygiene: start each change from the latest main.
      await git(step.name, "pull --rebase", "pull", "-q", "--rebase", "origin", "main");
      applyLocal(step);
      await git(step.name, "add", "add", "-A");
      await git(step.name, "commit", "commit", "-qm", step.message);
      for (;;) {
        const push = await git(step.name, "push", "push", "-q", "origin", "HEAD:main");
        if (push.ok) return { retries, conflicts };
        retries++;
        const pull = await git(step.name, "pull --rebase", "pull", "-q", "--rebase", "origin", "main");
        if (pull.ok) continue;
        // Rebase conflict: what an agent does — abandon the rebase, take upstream, re-apply its intent.
        conflicts++;
        emit({ t: now(), agent: i, step: step.name, kind: "conflict" });
        await git(step.name, "rebase --abort", "rebase", "--abort");
        await git(step.name, "reset --hard", "reset", "-q", "--hard", "origin/main");
        applyLocal(step);
        await git(step.name, "add", "add", "-A");
        await git(step.name, "commit", "commit", "-qm", step.message);
      }
    },
  };
}

function graftAgent(i: number, t: Task): Agent {
  const c = new GraftClient({ url: graftUrl, author: `agent-${t.slug}` });
  return {
    async setup() {
      // MCP agents need no workspace at all.
    },
    async land(step) {
      let retries = 0;
      let conflicts = 0;
      for (;;) {
        const base = (await op(i, step.name, "resolve", () => c.resolve("field-guide", "main"))).changeset;
        const contents: Record<string, string> = {};
        for (const p of step.reads) contents[p] = (await op(i, step.name, "read", () => c.file("field-guide", p, base))).content;
        const files = step.apply((p) => contents[p]);
        const r = await op(
          i,
          step.name,
          "commit+land",
          () => c.commit("field-guide", { base, message: step.message, changes: Object.entries(files).map(([path, content]) => ({ path, content })) }),
          (r: any) => r.land.status !== "conflict",
        );
        if (r.land.status !== "conflict") {
          if (r.land.rebased) emit({ t: now(), agent: i, step: step.name, kind: "auto-rebase" });
          return { retries, conflicts };
        }
        conflicts++;
        retries++;
        emit({ t: now(), agent: i, step: step.name, kind: "conflict" });
      }
    },
  };
}

function graftCliAgent(i: number, t: Task): Agent {
  const dir = join(work, `agent-${i}`);
  const env = { ...process.env, GRAFT_URL: graftUrl, GRAFT_AUTHOR: `agent-${t.slug}`, GRAFT_CACHE: join(work, "node-cache") };
  const graft = (step: string, name: string, ...a: string[]) =>
    op(i, step, name, () => run(node, [cliPath, ...a], { cwd: dir, env }), (r) => r.ok && !/CONFLICT/.test(r.out));
  const applyLocal = (step: Step) => {
    const files = step.apply((p) => takeUpstream(readFileSync(join(dir, p), "utf8")));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
  };
  return {
    async setup() {
      await op(i, "setup", "clone", () => run(node, [cliPath, "clone", "field-guide", dir], { env }), (r) => r.ok);
    },
    async land(step) {
      let retries = 0;
      let conflicts = 0;
      // Good agent hygiene: start each change from the latest main.
      await graft(step.name, "sync", "sync");
      applyLocal(step);
      for (;;) {
        const r = await graft(step.name, "commit", "commit", "-m", step.message);
        if (r.ok && !/CONFLICT/.test(r.out)) {
          if (/auto-rebased/.test(r.out)) emit({ t: now(), agent: i, step: step.name, kind: "auto-rebase" });
          return { retries, conflicts };
        }
        if (!/CONFLICT/.test(r.out)) throw new Error(`agent ${i}: graft commit failed: ${r.out}`);
        conflicts++;
        retries++;
        emit({ t: now(), agent: i, step: step.name, kind: "conflict" });
        // The workspace was moved to the new head with markers; keep upstream and re-apply intent.
        applyLocal(step);
      }
    },
  };
}

// ------------------------------------------------------------------ run

async function main() {
  await prepare();
  emit({ t: now(), kind: "start", agents: N, mode });
  const make = mode === "git" ? gitAgent : mode === "graft" ? graftAgent : graftCliAgent;
  const results = await Promise.all(
    tasks.map(async (t, i) => {
      const a = make(i, t);
      const s0 = now();
      await a.setup();
      emit({ t: s0, ms: now() - s0, agent: i, kind: "setup" });
      let retries = 0;
      let conflicts = 0;
      for (const step of stepsFor(t)) {
        const th = think();
        emit({ t: now(), ms: Math.round(th), agent: i, step: step.name, kind: "think" });
        await sleep(th);
        const l0 = now();
        const r = await a.land(step);
        retries += r.retries;
        conflicts += r.conflicts;
        emit({ t: l0, ms: now() - l0, agent: i, step: step.name, kind: "land", retries: r.retries, conflicts: r.conflicts });
      }
      emit({ t: now(), agent: i, kind: "done" });
      return { retries, conflicts };
    }),
  );
  const wall = now();

  // Verify the finished app (no lost updates) and export it for viewing.
  const appDir = join(runDir, "app");
  let read: (p: string) => string | null;
  if (mode === "git") {
    const final = join(work, "final");
    await run("git", ["clone", "-q", gitRemote, final], { env: gitEnv });
    read = (p) => (existsSync(join(final, p)) ? readFileSync(join(final, p), "utf8") : null);
    cpSync(final, appDir, { recursive: true, filter: (s) => !s.includes(`${final}/.git`) });
    const count = await run("git", ["rev-list", "--count", "HEAD"], { cwd: final, env: gitEnv });
    meta.commits = parseInt(count.out, 10);
  } else {
    const c = new GraftClient({ url: graftUrl });
    const man = await c.manifest("field-guide", "main");
    const blobs = await c.getBlobs(man.entries.map(([, h]) => h));
    const files = new Map(man.entries.map(([p, h]) => [p, blobs.get(h)!.toString("utf8")]));
    read = (p) => files.get(p) ?? null;
    for (const [p, content] of files) {
      mkdirSync(dirname(join(appDir, p)), { recursive: true });
      writeFileSync(join(appDir, p), content);
    }
    meta.commits = (await c.log("field-guide", "main", undefined, 1000)).changesets.length;
  }
  const v = verify(read, tasks);

  // Summaries from the event log.
  const events = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lands = events.filter((e) => e.kind === "land").map((e) => e.ms as number).sort((a, b) => a - b);
  const setups = events.filter((e) => e.kind === "setup").map((e) => e.ms as number).sort((a, b) => a - b);
  const ops = events.filter((e) => e.kind === "op");
  const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : 0);
  meta.status = "done";
  meta.finishedAt = new Date().toISOString();
  meta.summary = {
    wallMs: wall,
    landed: lands.length,
    landP50: pct(lands, 0.5),
    landP90: pct(lands, 0.9),
    landP99: pct(lands, 0.99),
    landMax: lands[lands.length - 1] ?? 0,
    setupP50: pct(setups, 0.5),
    setupMax: setups[setups.length - 1] ?? 0,
    vcsMs: ops.reduce((s, e) => s + e.ms, 0),
    vcsMsPerAgent: Math.round(ops.reduce((s, e) => s + e.ms, 0) / N),
    ops: ops.length,
    failedOps: ops.filter((e) => !e.ok).length,
    retries: results.reduce((s, r) => s + r.retries, 0),
    conflicts: results.reduce((s, r) => s + r.conflicts, 0),
    autoRebases: events.filter((e) => e.kind === "auto-rebase").length,
    verified: v.ok,
    missing: v.missing.slice(0, 20),
  };
  saveMeta();
  emit({ t: now(), kind: "end" });
  console.log(JSON.stringify({ run: runId, ...meta.summary }, null, 2));
}

main()
  .catch((e) => {
    meta.status = "failed";
    meta.error = String(e?.stack ?? e);
    saveMeta();
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    server?.kill();
    rmSync(work, { recursive: true, force: true });
  });
