/**
 * Rough benchmark of the agent loop: Graft vs git on the same synthetic repo.
 *   - workspace creation (graft clone vs git clone of a local bare repo)
 *   - commit-and-land of a one-line edit while the branch keeps moving
 * Usage: npm run build && npm run bench [-- files=5000 iters=20]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.js";
import { FsBlobStore } from "../src/core/blobstore.js";
import { Store } from "../src/core/store.js";
import { createGraftServer } from "../src/server/http.js";
import { GraftClient } from "../src/client/api.js";

if (!isMainThread) {
  // Server runs in a worker thread so the CLI's child processes never contend with a blocked loop.
  const { dir } = workerData as { dir: string };
  const store = new Store(openDb(join(dir, "db.sqlite")), new FsBlobStore(join(dir, "blobs")));
  const server = createGraftServer({ store });
  server.listen(0, "127.0.0.1", () => parentPort!.postMessage((server.address() as AddressInfo).port));
} else {
  await main();
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
  const FILES = parseInt(args.files ?? "3000", 10);
  const ITERS = parseInt(args.iters ?? "15", 10);
  const dir = mkdtempSync(join(tmpdir(), "graft-bench-"));
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { dir }, execArgv: ["--experimental-sqlite", "--no-warnings"] });
  const port: number = await new Promise((r) => worker.once("message", r));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, GRAFT_URL: url, GRAFT_CACHE: join(dir, "cache"), GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@x", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@x",
    // isolate from the user's global git config (e.g. commit signing) for a fair, hermetic comparison
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null" };
  const cli = join(process.cwd(), "dist/src/cli/graft.js");
  const graft = (cwd: string, ...a: string[]) => execFileSync(process.execPath, [cli, ...a], { cwd, env, encoding: "utf8" });
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const time = (fn: () => void) => {
    const t = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const pathFor = (n: number) => `pkg${n % 50}/mod${n}.ts`;
  const uniqueLine = (n: number) => `export const v${n}_1 = ${n};\n`;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  // ---- seed both systems with the same tree
  console.log(`seeding ${FILES} files…`);
  const seed = join(dir, "seed");
  mkdirSync(seed);
  const changes = [];
  for (let i = 0; i < FILES; i++) {
    const path = pathFor(i);
    const content = Array.from({ length: 40 }, (_, j) => `export const v${i}_${j} = ${i * j};\n`).join("");
    changes.push({ path, content });
    mkdirSync(join(seed, `pkg${i % 50}`), { recursive: true });
    writeFileSync(join(seed, path), content);
  }
  const c = new GraftClient({ url, author: "bench" });
  await c.createRepo("bench");
  await c.commit("bench", { message: "seed", changes });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  git(dir, "clone", "-q", "--bare", seed, "origin.git");

  // ---- workspace creation
  const gClone = time(() => git(dir, "clone", "-q", join(dir, "origin.git"), "g1"));
  const fCold = time(() => graft(dir, "clone", "bench", "f1"));
  const fWarm = time(() => graft(dir, "clone", "bench", "f2"));
  const fSparse = time(() => graft(dir, "clone", "bench", "f3", "--sparse", "pkg7"));
  git(dir, "clone", "-q", join(dir, "origin.git"), "g2");

  // ---- commit + land a one-line edit while another agent keeps landing (branch always moved)
  const gT: number[] = [];
  const fT: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    // another agent lands first
    const other = pathFor((i * 2) % FILES);
    writeFileSync(join(dir, "g2", other), readFileSync(join(dir, "g2", other), "utf8") + `// other ${i}\n`);
    git(join(dir, "g2"), "commit", "-qam", `other ${i}`);
    git(join(dir, "g2"), "pull", "-q", "--rebase");
    git(join(dir, "g2"), "push", "-q", "origin", "main");
    await c.commit("bench", { message: `other ${i}`, changes: [{ path: other, edits: [{ old: uniqueLine((i * 2) % FILES), new: uniqueLine((i * 2) % FILES) + `// other ${i}\n` }] }] });

    const mine = pathFor((i * 2 + 1) % FILES);
    gT.push(
      time(() => {
        const p = join(dir, "g1", mine);
        writeFileSync(p, readFileSync(p, "utf8") + `// mine ${i}\n`);
        git(join(dir, "g1"), "commit", "-qam", `mine ${i}`);
        git(join(dir, "g1"), "pull", "-q", "--rebase");
        git(join(dir, "g1"), "push", "-q", "origin", "main");
      }),
    );
    fT.push(
      time(() => {
        const p = join(dir, "f1", mine);
        writeFileSync(p, readFileSync(p, "utf8") + `// mine ${i}\n`);
        graft(join(dir, "f1"), "commit", "-m", `mine ${i}`);
      }),
    );
  }

  const row = (k: string, g: number, f: number) => console.log(`${k.padEnd(44)} ${g.toFixed(0).padStart(7)} ms ${f.toFixed(0).padStart(7)} ms   ${(g / f).toFixed(1)}x`);
  console.log(`\n${FILES} files, ${ITERS} iterations (local machine; git uses a local bare remote — no network)\n`);
  console.log(`${"".padEnd(44)} ${"git".padStart(10)} ${"graft".padStart(10)}`);
  row("new workspace (cold cache)", gClone, fCold);
  row("new workspace (warm node cache)", gClone, fWarm);
  row("new sparse workspace (1/50 of tree)", gClone, fSparse);
  row("edit + commit + land on moving branch (p50)", median(gT), median(fT));
  console.log(`\nMCP agents skip the workspace entirely: one graft_commit call = one HTTP round trip.`);
  const t = process.hrtime.bigint();
  await c.commit("bench", { message: "api", changes: [{ path: pathFor(3), edits: [{ old: uniqueLine(3), new: uniqueLine(3) + "// api\n" }] }] });
  console.log(`API commit+land (in-process client):          ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms`);
  await worker.terminate();
  rmSync(dir, { recursive: true, force: true });
}
