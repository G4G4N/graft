# Graft

**Site:** https://graft-vcs.pages.dev · **License:** MIT · **Deploy:** [DEPLOY.md](DEPLOY.md) · **Changes:** [CHANGELOG.md](CHANGELOG.md) · **Results:** https://graft-vcs.pages.dev/report/

Agent-first source control. History, commits, rebases and merges live on the server.
Agents never clone, pull or push: they read and search over an API and **commit + land in one call**.
When the branch moved underneath them, the server rebases automatically; only true textual
conflicts come back, as structured results.

Inspired by the ideas Anthropic published about its in-house system (Scion) in
["Redesigning source control at Anthropic"](https://www.anthropic.com/engineering/redesigning-source-control),
and by the Bonsai data model from Meta's open-source Mononoke. Graft is an independent, original implementation
sized for small-to-medium repos and many concurrent agents. It shares no code with either.

```
                ┌────────────── graft server (one container) ───────────────┐
 MCP agents ──► │ JSON API  ─►  Store                                       │
 (no checkout)  │                ├─ changesets  (immutable WAL, SQLite)     │
                │                ├─ refs        (compare-and-swap rows)     │
 graft CLI  ──► │                ├─ derived     (manifests, blame — lazy)   │
 (sparse WS)    │                └─ blobs       (content-addressed, gzip)   │
                │ web viewer                                                 │
 humans     ──► └────────────────────────────────────────────────────────────┘
```

## Design

| Idea | How Graft does it |
| --- | --- |
| Clients are always online | No offline clones. Everything is an API call; the CLI fetches objects on demand. |
| Server does the work | `commit`, `land`, rebase, 3-way merge, diff, blame, log, search all run server-side. |
| Small changesets | A changeset lists only paths changed vs its first parent (`path → blob hash` or delete). Commit cost ∝ change size. |
| Derived data | Full manifests, trees, blame and path history are derived recursively from parents and cached; manifest checkpoints every 64 generations. |
| Lock-free landing | Refs move by compare-and-swap. On a lost race the server re-rebases and retries. No merge queue, no global lock. |
| Conflicts are data | Non-overlapping edits (even in the same file) merge cleanly. Overlaps return `{path, kind, merged-with-markers}` and nothing lands. |
| Sparse, on-demand workspaces | `graft clone --sparse src/` materializes only what you ask for; `add-sparse` pulls more later. |
| Node-local object cache | All workspaces on a machine share `~/.graft/cache`; files are materialized with copy-on-write clones (APFS/btrfs/XFS). |

## Quick start

```bash
git clone https://github.com/G4G4N/graft && cd graft
npm install && npm run build
npm start                         # http://127.0.0.1:7070 (web viewer at /); loopback-only until GRAFT_TOKEN is set
```

Or with Docker:

```bash
GRAFT_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

### Use it from Claude Code (MCP plugin)

```bash
claude plugin marketplace add ./graft        # from the directory you cloned into
claude plugin install graft@graft
export GRAFT_URL=https://graft.example.com GRAFT_TOKEN=...   # optional: GRAFT_REPO=my-repo
```

Tools: `graft_list_repos`, `graft_create_repo`, `graft_tree`, `graft_find_files`, `graft_read_file`,
`graft_search`, `graft_commit`, `graft_land`, `graft_log`, `graft_diff`, `graft_show`, `graft_blame`,
`graft_branch`. The bundled skill (`plugin/skills/graft`) teaches the agent the read → commit → handle-conflict loop.

Any other MCP client can run `node plugin/dist/graft-mcp.js` (stdio, single file, no install needed).

### CLI

```bash
graft create my-repo
graft clone my-repo work --sparse src --sparse package.json
cd work && $EDITOR src/x.ts
graft status && graft diff
graft commit -m "Fix x"           # uploads only new blobs, lands, auto-rebases, syncs
graft sync                        # move to latest main; local edits 3-way merged
graft log src/x.ts | graft blame src/x.ts | graft search "TODO" --glob '*.ts'
```

On a conflict the workspace is moved to the new head with `<<<<<<<` markers in the affected files.
Fix them and `graft commit` again (commits containing markers are refused unless `--force`).

## HTTP API (abridged)

All under `/api`, JSON, `Authorization: Bearer $GRAFT_TOKEN` when configured.

| | |
| --- | --- |
| `POST /repos` `{name}` | create repo (root changeset + `main`) |
| `POST /repos/:r/commit` | `{base?, message, changes[], land?: true\|false\|"branch", expectedHead?}` → changeset + land result |
| `POST /repos/:r/land` | `{changeset, branch?}` |
| `GET /repos/:r/tree?rev&path` · `/file?rev&path&offset&limit` · `/raw` | read without checkout |
| `GET /repos/:r/log?rev&path&limit` · `/diff?to&from&path` · `/blame?rev&path` | history |
| `GET /repos/:r/search?q&regex&glob&prefix` · `/files?pattern` | code search / glob |
| `GET /repos/:r/manifest?rev&prefix` · `POST /blobs/get` · `POST /blobs/missing` · `POST /blobs/upload` | client fetch protocol |
| `POST /repos/:r/refs` `{name, target\|null, expected?}` | CAS branch create/move/delete |

Change entries: `{path, content}` · `{path, contentBase64}` · `{path, blob}` · `{path, edits:[{old,new,all?}]}` ·
`{path, delete:true}` · `{path, from}` (move, optionally with `edits`/`content`).
Revisions: branch name, changeset id or unique prefix, `rev~N`.

## Configuration

| Env | Default | |
| --- | --- | --- |
| `PORT` | `7070` | server port |
| `GRAFT_DATA` | `./graft-data` | SQLite DB + blobs |
| `GRAFT_TOKEN` | — | bearer token for all API calls (**set this for anything non-local**) |
| `GRAFT_READ_TOKEN` | — | read-only token (GET only) |
| `GRAFT_URL` / `GRAFT_AUTHOR` / `GRAFT_REPO` | | client + MCP settings |
| `GRAFT_CACHE` | `~/.graft/cache/objects` | CLI node-local object cache |

## Development

```bash
npm test          # 30 tests: core, HTTP (50 concurrent agents), CLI end-to-end, regressions, security, versioning
npm run bench     # graft vs git on a synthetic repo (files=3000 iters=15)
```

Set `GRAFT_TRACE=/path/trace.jsonl` to make the CLI append one timing record per command.

## Swarm experiment

Many agents build one small web app (the Field Guide in `swarm/seed/`) in the same repository at
the same time. Each agent lands three changes, two of them in shared hot files. The same workload
runs through git (clone, pull --rebase, push), the Graft API (what MCP agents use) and the Graft CLI.

```bash
node dist/src/swarm/dashboard.js                 # live dashboard: http://localhost:7300
swarm/run-matrix.sh 8 16 32 48                   # scripted swarms, every backend
node --experimental-sqlite dist/src/swarm/sim.js --mode graft --agents 24   # one run
node dist/src/swarm/export.js && node docs/build-report.mjs                 # → docs/graft-swarm-report.html
```

`src/swarm/real-setup.ts` / `real-finish.ts` prepare and verify a run with real Claude agents
(traced through git trace2 and `GRAFT_TRACE`). Every finished app is checked for lost work.

Headline results on one Mac, no network (full report in `docs/graft-swarm-report.html`):

| 48 agents | median land | p90 land | finish the app |
| --- | --- | --- | --- |
| Graft API (MCP) | 5 ms | 11 ms | 4.9 s |
| Graft CLI | 4.3 s | 48.5 s | 64.5 s |
| git | 15.5 s | 3.3 min | 4.5 min |

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). The MCP bundle runs on Node ≥ 18.

## Limitations / next steps

- Single server process. The CAS design allows several processes on one DB file, but there is no
  regional cache tier or object store backend yet (an S3 `BlobStore` is the natural next step).
- No virtual filesystem: sparse paths are materialized as real files (copy-on-write where supported).
- Blame and history follow first parents and don't track renames.
- No Git import/export bridge yet.
- Two insertions at the same line conflict (as in git). A union merge for append-only files
  (changelogs, CSS) would remove most swarm conflicts and is the obvious next feature.
- The CLI pays ~100 ms of Node.js startup per command, which widens its race window under heavy
  contention; agents that don't need files should use the MCP tools.
- Per-repo or per-directory permissions are not implemented. Tokens are global, and commit authors are
  self-declared.
