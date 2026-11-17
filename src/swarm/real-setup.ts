/**
 * Prepare a real-agent experiment: two teams (git, graft) with one workspace per agent,
 * passive timing instrumentation (git trace2 / GRAFT_TRACE), and dashboard run metadata.
 *
 * node dist/src/swarm/real-setup.js --base /tmp/real --graft-url http://127.0.0.1:7400 --slugs a,b,c [--runs swarm/runs]
 * node dist/src/swarm/real-setup.js --base /tmp/real --start      (stamp start time right before launching agents)
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GraftClient } from "../client/api.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const base = resolve(flag("base") ?? "/tmp/graft-real");
const runsDir = resolve(flag("runs") ?? join(root, "swarm/runs"));
const stateFile = join(base, "state.json");

if (argv.includes("--start")) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const startedAt = new Date().toISOString();
  for (const team of ["git", "graft"]) {
    const id = `${state.id}-real-${team}`;
    mkdirSync(join(runsDir, id), { recursive: true });
    writeFileSync(
      join(runsDir, id, "meta.json"),
      JSON.stringify(
        {
          id,
          kind: "real",
          mode: team,
          agents: state.slugs.length,
          agentsList: state.slugs.map((s: string) => `agent-${s}`),
          label: "real agents",
          startedAt,
          status: "running",
          setup: state.setup[team],
          sources: team === "git" ? [{ system: "git", dir: join(base, "git-team/trace2") }] : [{ system: "graft", file: join(base, "graft-team/trace.jsonl") }],
        },
        null,
        2,
      ),
    );
  }
  console.log(`started ${state.id} at ${startedAt}`);
  process.exit(0);
}

const graftUrl = flag("graft-url") ?? "http://127.0.0.1:7400";
const slugs = (flag("slugs") ?? "").split(",").filter(Boolean);
if (!slugs.length) throw new Error("--slugs required");
const node = process.execPath;
const cli = join(root, "dist/src/cli/graft.js");
const time = (fn: () => void) => {
  const t = Date.now();
  fn();
  return Date.now() - t;
};
const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const setup: Record<string, Record<string, number>> = { git: {}, graft: {} };

// ---------------- git team
const gitTeam = join(base, "git-team");
mkdirSync(join(gitTeam, "trace2"), { recursive: true });
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const seed = join(gitTeam, "seed");
cpSync(join(root, "swarm/seed"), seed, { recursive: true });
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: gitEnv, stdio: "pipe" });
g(seed, "init", "-q", "-b", "main");
g(seed, "add", "-A");
g(seed, "-c", "user.name=seed", "-c", "user.email=seed@swarm", "commit", "-qm", "Seed Field Guide");
g(gitTeam, "clone", "-q", "--bare", seed, "origin.git");
for (const s of slugs) {
  const dir = join(gitTeam, `agent-${s}`);
  setup.git[s] = time(() => g(gitTeam, "clone", "-q", join(gitTeam, "origin.git"), dir));
  // Repo-local config overrides the user's global config (e.g. commit signing) and turns on
  // trace2 timing for every git command the agent runs, without the agent doing anything.
  for (const [k, v] of [
    ["user.name", `agent-${s}`],
    ["user.email", `${s}@swarm.local`],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
    ["core.editor", "true"],
    ["trace2.eventTarget", join(gitTeam, "trace2", `agent-${s}.trace`)],
  ]) {
    execFileSync("git", ["config", k, v], { cwd: dir });
  }
}

// ---------------- graft team
const graftTeam = join(base, "graft-team");
mkdirSync(join(graftTeam, "bin"), { recursive: true });
const c = new GraftClient({ url: graftUrl, author: "seed" });
await c.createRepo("field-guide", "Built by real agents");
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
const wrapper = join(graftTeam, "bin", "graft");
writeFileSync(
  wrapper,
  `#!/bin/sh
# graft for the agent team: derives the agent name from the workspace directory and traces timings.
case "$PWD" in
  */agent-*) A="agent-\${PWD##*/agent-}"; A="\${A%%/*}" ;;
  *) A="\${GRAFT_AUTHOR:-unknown}" ;;
esac
exec env GRAFT_URL="${graftUrl}" GRAFT_TRACE="${join(graftTeam, "trace.jsonl")}" GRAFT_AUTHOR="$A" GRAFT_CACHE="${join(graftTeam, "node-cache")}" "${node}" "${cli}" "$@"
`,
);
chmodSync(wrapper, 0o755);
for (const s of slugs) {
  const dir = join(graftTeam, `agent-${s}`);
  setup.graft[s] = time(() => execFileSync(node, [cli, "clone", "field-guide", dir], { env: { ...process.env, GRAFT_URL: graftUrl, GRAFT_CACHE: join(graftTeam, "node-cache") }, stdio: "pipe" }));
}

writeFileSync(stateFile, JSON.stringify({ id, slugs, graftUrl, setup, gitRemote: join(gitTeam, "origin.git"), wrapper }, null, 2));
console.log(JSON.stringify({ id, base, wrapper, setup }, null, 2));
void existsSync;
