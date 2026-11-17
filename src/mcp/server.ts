#!/usr/bin/env node
/**
 * Graft MCP server (stdio). Lets agents use source control without a local checkout:
 * read/search the tree, then commit + land in a single call. Rebase and merge happen on the server.
 *
 * Env: GRAFT_URL (default http://localhost:7070), GRAFT_TOKEN, GRAFT_AUTHOR, GRAFT_REPO (default repo).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GraftClient, GraftApiError } from "../client/api.js";
import { VERSION } from "../version.js";

const client = GraftClient.fromEnv({ author: process.env.GRAFT_AUTHOR || "claude-agent" });
const defaultRepo = process.env.GRAFT_REPO || undefined;

const server = new McpServer({ name: "graft", version: VERSION });

const repoArg = defaultRepo
  ? z.string().optional().describe(`Repository name (default: ${defaultRepo})`)
  : z.string().describe("Repository name");
const revArg = z.string().optional().describe("Revision: branch name, changeset id/prefix, or rev~N. Default: main");

function repoOf(a: { repo?: string }): string {
  const r = a.repo || defaultRepo;
  if (!r) throw new Error("repo is required (or set GRAFT_REPO)");
  return r;
}
const short = (id: string | null | undefined) => (id ? id.slice(0, 12) : "(none)");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
function wrap<A>(fn: (a: A) => Promise<string>): (a: A) => Promise<ToolResult> {
  return async (a: A) => {
    try {
      return { content: [{ type: "text", text: await fn(a) }] };
    } catch (e: any) {
      const msg = e instanceof GraftApiError ? `graft error (${e.status}): ${e.message}${e.body?.details ? "\n" + JSON.stringify(e.body.details) : ""}` : String(e?.message ?? e);
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  };
}

server.registerTool(
  "graft_list_repos",
  { description: "List repositories on the Graft server with their main-branch heads.", inputSchema: {} },
  wrap(async () => {
    const r = await client.listRepos();
    if (!r.repos.length) return "No repositories yet. Create one with graft_create_repo.";
    return r.repos.map((x: any) => `${x.name}\tmain=${short(x.head)}\t${x.description ?? ""}`).join("\n");
  }),
);

server.registerTool(
  "graft_create_repo",
  {
    description: "Create a new repository (starts with an empty root changeset on branch main).",
    inputSchema: { name: z.string().describe("Repo name: letters, digits, . _ -"), description: z.string().optional() },
  },
  wrap(async (a: { name: string; description?: string }) => {
    const r = await client.createRepo(a.name, a.description);
    return `Created repo ${r.name}; main=${short(r.head)}`;
  }),
);

server.registerTool(
  "graft_tree",
  {
    description: "List a directory at a revision (no checkout needed). Directories end with '/'.",
    inputSchema: { repo: repoArg, path: z.string().optional().describe("Directory path; empty for root"), rev: revArg },
  },
  wrap(async (a: { repo?: string; path?: string; rev?: string }) => {
    const r = await client.tree(repoOf(a), a.rev, a.path);
    const lines = r.entries.map((e: any) => (e.type === "dir" ? e.path + "/" : e.path));
    return `@ ${short(r.changeset)} ${a.path || "/"}\n` + (lines.join("\n") || "(empty)");
  }),
);

server.registerTool(
  "graft_find_files",
  {
    description: "Find file paths by glob (e.g. '**/*.ts', 'src/**/test_*.py', '*.md'). Patterns without '/' match basenames anywhere.",
    inputSchema: { repo: repoArg, pattern: z.string(), rev: revArg, limit: z.number().int().optional() },
  },
  wrap(async (a: { repo?: string; pattern: string; rev?: string; limit?: number }) => {
    const r = await client.files(repoOf(a), a.pattern, a.rev, a.limit);
    return `@ ${short(r.changeset)} ${r.files.length} file(s)${r.truncated ? " (truncated)" : ""}\n` + r.files.join("\n");
  }),
);

server.registerTool(
  "graft_read_file",
  {
    description:
      "Read a file at a revision. Returns exact content (use it verbatim for edit 'old' strings). Optional 1-based line offset/limit for large files.",
    inputSchema: {
      repo: repoArg,
      path: z.string(),
      rev: revArg,
      offset: z.number().int().optional().describe("1-based first line"),
      limit: z.number().int().optional().describe("Number of lines"),
    },
  },
  wrap(async (a: { repo?: string; path: string; rev?: string; offset?: number; limit?: number }) => {
    const r = await client.file(repoOf(a), a.path, a.rev, a.offset, a.limit);
    if (r.binary) return `@ ${short(r.changeset)} ${a.path}: binary file, ${r.size} bytes`;
    const range = r.totalLines ? ` lines ${r.offset}-${r.offset + r.content.split("\n").length - 1} of ${r.totalLines}` : "";
    return `@ ${short(r.changeset)} ${a.path}${range}\n${r.content}`;
  }),
);

server.registerTool(
  "graft_search",
  {
    description: "Search file contents at a revision on the server (like grep). Returns path:line: text.",
    inputSchema: {
      repo: repoArg,
      query: z.string(),
      regex: z.boolean().optional(),
      ignore_case: z.boolean().optional(),
      path_prefix: z.string().optional().describe("Only search under this directory"),
      glob: z.string().optional().describe("Only search files matching this glob"),
      rev: revArg,
      limit: z.number().int().optional(),
    },
  },
  wrap(async (a: any) => {
    const r = await client.search(repoOf(a), a.query, {
      rev: a.rev,
      regex: a.regex,
      ignoreCase: a.ignore_case,
      prefix: a.path_prefix,
      glob: a.glob,
      limit: a.limit,
    });
    const head = `@ ${short(r.changeset)} ${r.matches.length} match(es) in ${r.filesScanned} file(s)${r.truncated ? " (truncated)" : ""}`;
    return [head, ...r.matches.map((m: any) => `${m.path}:${m.line}: ${m.text}`)].join("\n");
  }),
);

const changeSchema = z
  .object({
    path: z.string().describe("File path (destination path for moves)"),
    content: z.string().optional().describe("Full new UTF-8 content (create or overwrite)"),
    content_base64: z.string().optional().describe("Full new content, base64 (binary)"),
    edits: z
      .array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() }))
      .optional()
      .describe("Exact string replacements applied to the file at the base revision; 'old' must match exactly once unless all=true"),
    delete: z.boolean().optional().describe("Delete the file"),
    from: z.string().optional().describe("Move/rename: source path (combine with edits/content to also change it)"),
  })
  .describe("One file change");

server.registerTool(
  "graft_commit",
  {
    description:
      "Create a commit on the server and land it on a branch in ONE call (default). No checkout or push needed. " +
      "If others landed changes meanwhile, the server rebases automatically; non-overlapping edits merge cleanly. " +
      "On a textual conflict nothing lands and you get the conflicting files with markers: re-read the file at main and commit again.",
    inputSchema: {
      repo: repoArg,
      message: z.string().describe("Commit message"),
      changes: z.array(changeSchema).min(1),
      base: z.string().optional().describe("Revision your edits were made against (default: current main). Pass the changeset you read from for safe auto-merge."),
      branch: z.string().optional().describe("Branch to land on (default main)"),
      land: z.boolean().optional().describe("Set false to create a draft changeset without landing"),
    },
  },
  wrap(async (a: any) => {
    const repo = repoOf(a);
    const changes = a.changes.map((c: any) => ({
      path: c.path,
      content: c.content,
      contentBase64: c.content_base64,
      edits: c.edits,
      delete: c.delete,
      from: c.from,
    }));
    const r = await client.commit(repo, { base: a.base ?? a.branch, branch: a.branch, message: a.message, changes, land: a.land === false ? false : (a.branch ?? "main") });
    const cs = r.changeset;
    const tag = { added: "A", modified: "M", deleted: "D" } as Record<string, string>;
    const files = (r.files ?? cs.changes.map((c: any) => ({ path: c.path, status: c.blob ? "modified" : "deleted" })))
      .map((f: any) => `  ${tag[f.status] ?? "M"} ${f.path}`)
      .join("\n");
    if (!r.land) return `Draft changeset ${cs.id} (not landed)\n${files}\nLand it with graft_land.`;
    return formatLand(r.land, cs.id, files);
  }),
);

function formatLand(l: any, original: string, files = ""): string {
  if (l.status === "landed") {
    return `Landed on ${l.branch}: ${l.landed}${l.rebased ? ` (auto-rebased from ${short(original)})` : ""}\n${files}`.trimEnd();
  }
  if (l.status === "noop") return `Nothing to land: changes are already on ${l.branch} (head ${short(l.head)}).`;
  const parts = [`CONFLICT: not landed. ${l.branch} is at ${l.head}. Draft ${original} kept.`];
  for (const c of l.conflicts ?? []) {
    parts.push(`\n--- ${c.path} (${c.kind})`);
    if (c.merged) parts.push(c.merged.length > 6000 ? c.merged.slice(0, 6000) + "\n…(truncated)" : c.merged);
  }
  parts.push(`\nResolve: read the file(s) at ${l.branch}, then graft_commit again with base=${short(l.head)}.`);
  return parts.join("\n");
}

server.registerTool(
  "graft_land",
  {
    description: "Land an existing draft changeset onto a branch (server-side rebase, compare-and-swap ref update).",
    inputSchema: { repo: repoArg, changeset: z.string(), branch: z.string().optional() },
  },
  wrap(async (a: any) => formatLand(await client.land(repoOf(a), a.changeset, a.branch ?? "main"), a.changeset)),
);

server.registerTool(
  "graft_log",
  {
    description: "Show history (first-parent) for a revision, optionally only changesets touching a path.",
    inputSchema: { repo: repoArg, rev: revArg, path: z.string().optional(), limit: z.number().int().optional() },
  },
  wrap(async (a: any) => {
    const r = await client.log(repoOf(a), a.rev, a.path, a.limit ?? 20);
    return r.changesets
      .map((c: any) => `${short(c.id)} ${c.createdAt.slice(0, 19)} ${c.author}: ${c.message.split("\n")[0]} [${c.changeCount} file(s)]${c.rebasedFrom ? " (rebased)" : ""}`)
      .join("\n") + (r.more ? "\n…" : "");
  }),
);

server.registerTool(
  "graft_diff",
  {
    description: "Unified diff between two revisions (default: a changeset vs its parent). Computed on the server.",
    inputSchema: {
      repo: repoArg,
      to: z.string().optional().describe("Revision to diff (default main)"),
      from: z.string().optional().describe("Base revision (default: parent of 'to')"),
      paths: z.array(z.string()).optional(),
      stat_only: z.boolean().optional(),
    },
  },
  wrap(async (a: any) => {
    const r = await client.diff(repoOf(a), a.to, a.from, a.paths, a.stat_only ? false : undefined);
    const head = `${short(r.from)}..${short(r.to)}: ${r.stat.files} file(s), +${r.stat.added} -${r.stat.removed}`;
    const body = r.files
      .map((f: any) => (a.stat_only || f.binary ? `${f.status[0].toUpperCase()} ${f.path} +${f.added} -${f.removed}${f.binary ? " (binary)" : ""}` : f.patch))
      .join(a.stat_only ? "\n" : "");
    return `${head}\n${body}`;
  }),
);

server.registerTool(
  "graft_show",
  {
    description: "Show a changeset: metadata, files and patch.",
    inputSchema: { repo: repoArg, changeset: z.string() },
  },
  wrap(async (a: any) => {
    const repo = repoOf(a);
    const cs = await client.changeset(repo, a.changeset);
    const d = await client.diff(repo, cs.id);
    return [
      `changeset ${cs.id}`,
      `parents ${cs.parents.map(short).join(" ")}`,
      `author ${cs.author}  ${cs.createdAt}`,
      cs.rebasedFrom ? `rebased-from ${cs.rebasedFrom}` : "",
      "",
      cs.message,
      "",
      d.files.map((f: any) => f.patch ?? `${f.status} ${f.path} (binary)`).join(""),
    ]
      .filter((x, i) => x !== "" || i > 3)
      .join("\n");
  }),
);

server.registerTool(
  "graft_blame",
  {
    description: "Line-by-line blame for a file (which changeset last changed each line).",
    inputSchema: { repo: repoArg, path: z.string(), rev: revArg },
  },
  wrap(async (a: any) => {
    const r = await client.blame(repoOf(a), a.path, a.rev);
    return r.lines
      .map((l: any) => `${short(l.changeset)} ${(r.changesets[l.changeset]?.author ?? "").padEnd(14).slice(0, 14)} ${String(l.line).padStart(5)}| ${l.text}`)
      .join("\n");
  }),
);

server.registerTool(
  "graft_branch",
  {
    description: "Create, move or delete a branch (refs are compare-and-swap). Prefer landing straight on main; use branches for long-lived or release lines.",
    inputSchema: {
      repo: repoArg,
      name: z.string(),
      target: z.string().optional().describe("Revision to point at (default main). Omit with delete=true to delete."),
      delete: z.boolean().optional(),
    },
  },
  wrap(async (a: any) => {
    const r = await client.setRef(repoOf(a), a.name, a.delete ? null : (a.target ?? "main"));
    return r.target ? `${r.name} -> ${r.target}` : `deleted ${r.name}`;
  }),
);

await server.connect(new StdioServerTransport());
