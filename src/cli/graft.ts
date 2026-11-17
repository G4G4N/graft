import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { GraftClient, GraftApiError } from "../client/api.js";
import { Workspace } from "./workspace.js";
import { isBinary, unifiedDiff } from "../core/diff.js";
import { VERSION } from "../version.js";

const HELP = `graft — agent-first source control client

Workspace commands (sparse, on-demand checkouts sharing a machine-wide object cache):
  graft clone <repo> [dir] [--sparse <path>]... [--rev <rev>] [--branch <b>]
  graft status                      Local changes vs workspace base
  graft diff [path...]              Unified diff of local changes
  graft commit -m <msg> [--no-land] [--force] [path...]
                                    Upload changed blobs, commit on the server, land (auto-rebase)
  graft sync [rev]                  Move to latest branch head (3-way merges local edits)
  graft add-sparse <path>...        Materialize more paths on demand
  graft sparse                      Show sparse paths
  graft info                        Workspace info

Info:
  graft --version                   Client version
  graft version                     Client and server versions, protocol compatibility

Server commands (work anywhere; --repo or the current workspace's repo):
  graft repos                       List repositories
  graft create <name> [desc]        Create a repository
  graft log [path] [-n N] [--rev r] History (first-parent)
  graft show <rev>                  Changeset + patch
  graft cat <path> [--rev r]        Print a file at a revision
  graft ls [path] [--rev r]         List a directory
  graft blame <path> [--rev r]
  graft search <query> [--regex] [-i] [--glob g] [--rev r]
  graft land <changeset> [--branch b]
  graft branch <name> [target] | graft branch -d <name>

Env: GRAFT_URL (default http://localhost:7070), GRAFT_TOKEN, GRAFT_AUTHOR, GRAFT_CACHE
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  const multi = new Set(["sparse"]);
  const bool = new Set(["no-land", "force", "regex", "i", "d", "json", "help", "h"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(a);
    if (m && a !== "-") {
      const k = m[1];
      let v: string | boolean;
      if (m[2] !== undefined) v = m[2];
      else if (bool.has(k)) v = true;
      else v = argv[++i] ?? "";
      if (multi.has(k)) out.flags[k] = [...((out.flags[k] as string[]) ?? []), String(v)];
      else out.flags[k] = v;
    } else out._.push(a);
  }
  return out;
}

const short = (id?: string | null) => (id ? id.slice(0, 12) : "(none)");
const flag = (a: Args, ...names: string[]) => {
  for (const n of names) if (a.flags[n] !== undefined) return a.flags[n] as string;
  return undefined;
};

function relToWs(ws: Workspace, p: string) {
  return relative(ws.root, resolve(p)).split(sep).join("/");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parse(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  const ws = Workspace.find();
  const client = ws ? ws.client() : GraftClient.fromEnv();
  const repoName = () => {
    const r = flag(a, "repo") ?? ws?.config.repo ?? process.env.GRAFT_REPO;
    if (!r) throw new Error("no repo: pass --repo <name> or run inside a graft workspace");
    return r;
  };
  const needWs = () => {
    if (!ws) throw new Error("not inside a graft workspace (run graft clone first)");
    return ws;
  };

  switch (cmd) {
    case "version": {
      console.log(`graft client ${VERSION} (protocol 1)`);
      try {
        const v = await client.version();
        const ok = 1 >= v.minProtocol && 1 <= v.protocol;
        console.log(`graft server ${v.version} at ${client.url} (protocols ${v.minProtocol}..${v.protocol}) ${ok ? "— compatible" : "— INCOMPATIBLE: upgrade the older side"}`);
      } catch (e: any) {
        console.log(`graft server: unreachable at ${client.url} (${e?.message ?? e})`);
      }
      return;
    }
    case "repos": {
      const r = await client.listRepos();
      for (const x of r.repos) console.log(`${x.name.padEnd(24)} main=${short(x.head)}  ${x.description ?? ""}`);
      if (!r.repos.length) console.log("(no repositories)");
      return;
    }
    case "create": {
      const r = await client.createRepo(a._[0], a._.slice(1).join(" "));
      console.log(`created ${r.name} (main=${short(r.head)})`);
      return;
    }
    case "clone": {
      const repo = a._[0];
      if (!repo) throw new Error("usage: graft clone <repo> [dir]");
      const dir = resolve(a._[1] ?? repo);
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
      mkdirSync(dir, { recursive: true });
      const sparse = ((a.flags.sparse as string[]) ?? []).map((s) => s.replace(/^\.?\/+/, "").replace(/\/+$/, "")).filter(Boolean);
      const branch = flag(a, "branch") ?? "main";
      const url = process.env.GRAFT_URL ?? client.url;
      const w = Workspace.init(dir, { server: url, repo, branch, base: "", sparse });
      const r = await w.checkout(flag(a, "rev") ?? branch);
      console.log(
        `cloned ${repo}@${short(r.head)} into ${relative(process.cwd(), dir) || "."}: ${r.written} file(s)` +
          `${sparse.length ? ` under ${sparse.join(", ")}` : ""}, ${r.fetched} object(s) fetched, ${r.ms} ms`,
      );
      return;
    }
    case "status":
    case "st": {
      const w = needWs();
      const s = w.status();
      if (w.dirty) w.save();
      console.log(`on ${w.config.repo}/${w.config.branch} @ ${short(w.config.base)}${w.config.sparse.length ? ` (sparse: ${w.config.sparse.join(", ")})` : ""}`);
      if (!s.length) console.log("clean");
      for (const f of s) console.log(`${f.state === "modified" ? "M" : f.state === "added" ? "A" : "D"} ${f.path}`);
      return;
    }
    case "diff": {
      const w = needWs();
      const only = a._.map((p) => relToWs(w, p));
      for (const f of w.status()) {
        if (only.length && !only.some((p) => f.path === p || f.path.startsWith(p + "/"))) continue;
        const beforeBuf = f.state === "added" ? Buffer.alloc(0) : w.readBaseBuffer(f.path);
        const afterBuf = f.state === "deleted" ? Buffer.alloc(0) : readFileSync(w.abs(f.path));
        if (isBinary(beforeBuf) || isBinary(afterBuf)) {
          console.log(`Binary file ${f.path} ${f.state === "added" ? "added" : f.state === "deleted" ? "deleted" : "differs"}`);
          continue;
        }
        const before = beforeBuf.toString("utf8");
        const after = afterBuf.toString("utf8");
        const d = unifiedDiff(before, after, f.state === "added" ? "/dev/null" : `a/${f.path}`, f.state === "deleted" ? "/dev/null" : `b/${f.path}`);
        process.stdout.write(d.patch);
      }
      return;
    }
    case "commit":
    case "ci": {
      const w = needWs();
      const msg = flag(a, "m", "message");
      if (!msg) throw new Error('usage: graft commit -m "message"');
      const r: any = await w.commit(msg, { land: !a.flags["no-land"], paths: a._.map((p) => relToWs(w, p)), force: !!a.flags.force });
      if (r.status === "nothing") return console.log("nothing to commit");
      const files = r.changeset.changes.length;
      if (r.status === "draft") return console.log(`draft ${r.changeset.id} (${files} file(s), not landed) — graft land ${short(r.changeset.id)}`);
      if (r.status === "landed") {
        console.log(
          `landed ${short(r.land.landed)} on ${r.land.branch} (${files} file(s), ${r.uploaded} blob(s) uploaded${r.land.rebased ? ", auto-rebased" : ""})`,
        );
        if (r.sync?.written) console.log(`synced ${r.sync.written} file(s) changed by others`);
        return;
      }
      if (r.status === "noop") return console.log("already landed");
      console.log(`CONFLICT — not landed. ${r.land.branch} is at ${short(r.land.head)}.`);
      console.log(`Workspace moved to ${short(r.land.head)}; resolve markers then commit again:`);
      for (const p of r.sync.conflicts) console.log(`  C ${p}`);
      process.exitCode = 2;
      return;
    }
    case "sync":
    case "pull": {
      const w = needWs();
      const r = await w.checkout(a._[0] ?? w.config.branch);
      console.log(`at ${short(r.head)}: ${r.written} file(s) updated, ${r.fetched} object(s) fetched, ${r.ms} ms`);
      for (const p of r.conflicts) console.log(`  C ${p}`);
      if (r.conflicts.length) process.exitCode = 2;
      return;
    }
    case "add-sparse": {
      const w = needWs();
      const add = a._.map((p) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "")).filter(Boolean);
      if (!add.length) throw new Error("usage: graft add-sparse <path>...");
      if (!w.config.sparse.length) return console.log("workspace is not sparse; everything is already materialized");
      w.config.sparse = [...new Set([...w.config.sparse, ...add])];
      const r = await w.checkout(w.config.base, { onlyPrefixes: add });
      console.log(`materialized ${r.written} file(s) under ${add.join(", ")} (${r.fetched} fetched, ${r.ms} ms)`);
      return;
    }
    case "sparse": {
      const w = needWs();
      console.log(w.config.sparse.length ? w.config.sparse.join("\n") : "(full checkout)");
      return;
    }
    case "info": {
      const w = needWs();
      console.log(JSON.stringify({ root: w.root, ...w.config, files: Object.keys(w.index).length, cache: w.cache.root }, null, 2));
      return;
    }
    case "log": {
      const r = await client.log(repoName(), flag(a, "rev"), a._[0] ? (ws ? relToWs(ws, a._[0]) : a._[0]) : undefined, Number(flag(a, "n") ?? 20));
      for (const c of r.changesets) {
        console.log(`${short(c.id)} ${c.createdAt.slice(0, 19).replace("T", " ")} ${c.author.padEnd(14)} ${c.message.split("\n")[0]}${c.rebasedFrom ? "  (rebased)" : ""}`);
      }
      return;
    }
    case "show": {
      const repo = repoName();
      const cs = await client.changeset(repo, a._[0] ?? "main");
      const d = await client.diff(repo, cs.id);
      console.log(`changeset ${cs.id}\nauthor    ${cs.author}\ndate      ${cs.createdAt}\nparents   ${cs.parents.map(short).join(" ")}\n\n    ${cs.message.replace(/\n/g, "\n    ")}\n`);
      for (const f of d.files) process.stdout.write(f.patch ?? `${f.status} ${f.path} (binary)\n`);
      return;
    }
    case "cat": {
      const r = await client.request("GET", `${client.r(repoName())}/raw`, { query: { path: a._[0], rev: flag(a, "rev") } });
      process.stdout.write(r as Buffer);
      return;
    }
    case "ls": {
      const r = await client.tree(repoName(), flag(a, "rev"), a._[0]);
      for (const e of r.entries) console.log(e.type === "dir" ? e.path + "/" : e.path);
      return;
    }
    case "blame": {
      const r = await client.blame(repoName(), ws ? relToWs(ws, a._[0]) : a._[0], flag(a, "rev"));
      for (const l of r.lines) console.log(`${short(l.changeset)} ${(r.changesets[l.changeset]?.author ?? "").padEnd(14).slice(0, 14)} ${String(l.line).padStart(5)}| ${l.text}`);
      return;
    }
    case "search":
    case "grep": {
      const r = await client.search(repoName(), a._.join(" "), {
        rev: flag(a, "rev"),
        regex: !!a.flags.regex,
        ignoreCase: !!a.flags.i,
        glob: flag(a, "glob"),
        prefix: flag(a, "prefix"),
      });
      for (const m of r.matches) console.log(`${m.path}:${m.line}: ${m.text}`);
      if (r.truncated) console.log("… (truncated)");
      return;
    }
    case "land": {
      const r = await client.land(repoName(), a._[0], flag(a, "branch") ?? "main");
      console.log(r.status === "landed" ? `landed ${short(r.landed)}${r.rebased ? " (auto-rebased)" : ""}` : r.status);
      if (r.status === "conflict") {
        for (const c of r.conflicts) console.log(`  C ${c.path} (${c.kind})`);
        process.exitCode = 2;
      }
      return;
    }
    case "branch": {
      const repo = repoName();
      if (a.flags.d) {
        await client.setRef(repo, a._[0], null);
        return console.log(`deleted ${a._[0]}`);
      }
      if (!a._[0]) {
        const r = await client.repo(repo);
        for (const ref of r.refs) console.log(`${ref.name.padEnd(24)} ${short(ref.target)}`);
        return;
      }
      const r = await client.setRef(repo, a._[0], a._[1] ?? "main");
      console.log(`${r.name} -> ${short(r.target)}`);
      return;
    }
    default:
      throw new Error(`unknown command: ${cmd} (graft help)`);
  }
}

// Optional per-command tracing for measurement: GRAFT_TRACE=/path/to/trace.jsonl
const traceStart = Date.now();
function trace(ok: boolean, error?: string) {
  const file = process.env.GRAFT_TRACE;
  if (!file) return;
  try {
    const [cmd, ...args] = process.argv.slice(2);
    appendFileSync(
      file,
      JSON.stringify({
        system: "graft",
        agent: process.env.GRAFT_AUTHOR ?? null,
        cmd: cmd ?? "",
        args: args.filter((a) => !a.startsWith("-")).slice(0, 4).map((a) => a.slice(0, 80)),
        start: traceStart,
        ms: Date.now() - traceStart,
        ok,
        exit: process.exitCode ?? (ok ? 0 : 1),
        error: error?.slice(0, 200),
      }) + "\n",
    );
  } catch {}
}

main()
  .then(() => trace(!process.exitCode))
  .catch((e) => {
    const msg = e instanceof GraftApiError ? `${e.message}${e.body?.details ? " " + JSON.stringify(e.body.details) : ""}` : `${e?.message ?? e}`;
    console.error(`graft: ${msg}`);
    trace(false, msg);
    process.exit(1);
  });
