/**
 * Finish a real-agent experiment: verify each team's final app (no lost work, no conflict markers),
 * export it for viewing, and mark the dashboard runs done.
 * node dist/src/swarm/real-finish.js --base /tmp/real [--runs swarm/runs]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GraftClient } from "../client/api.js";
import { verify, type Task } from "./workload.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const base = resolve(flag("base", "/tmp/graft-real"));
const runsDir = resolve(flag("runs", join(root, "swarm/runs")));
const state = JSON.parse(readFileSync(join(base, "state.json"), "utf8"));
const allTasks: Task[] = JSON.parse(readFileSync(join(root, "swarm/tasks.json"), "utf8"));
const tasks = state.slugs.map((s: string) => allTasks.find((t) => t.slug === s)!);
const out: Record<string, unknown> = {};

// git team
{
  const dir = mkdtempSync(join(tmpdir(), "real-git-final-"));
  execFileSync("git", ["clone", "-q", state.gitRemote, dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null);
  const v = verify(read, tasks);
  const commits = parseInt(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir }).toString(), 10);
  const id = `${state.id}-real-git`;
  cpSync(dir, join(runsDir, id, "app"), { recursive: true, filter: (s) => !s.includes("/.git") });
  finish(id, { ...v, commits });
  out.git = { ...v, commits };
}

// graft team
{
  const c = new GraftClient({ url: state.graftUrl });
  const man = await c.manifest("field-guide", "main");
  const blobs = await c.getBlobs(man.entries.map(([, h]) => h));
  const files = new Map(man.entries.map(([p, h]) => [p, blobs.get(h)!.toString("utf8")]));
  const v = verify((p) => files.get(p) ?? null, tasks);
  const commits = (await c.log("field-guide", "main", undefined, 1000)).changesets.length;
  const id = `${state.id}-real-graft`;
  for (const [p, content] of files) {
    const f = join(runsDir, id, "app", p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  finish(id, { ...v, commits });
  out.graft = { ...v, commits };
}

function finish(id: string, verifyResult: Record<string, unknown>) {
  const f = join(runsDir, id, "meta.json");
  const meta = JSON.parse(readFileSync(f, "utf8"));
  meta.status = "done";
  meta.finishedAt = new Date().toISOString();
  meta.verify = verifyResult;
  meta.summary = { ...(meta.summary ?? {}), verified: verifyResult.ok };
  writeFileSync(f, JSON.stringify(meta, null, 2));
}

console.log(JSON.stringify(out, null, 2));
