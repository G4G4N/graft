---
name: graft
description: How to work with code stored in a Graft source-control server (graft_* MCP tools or the `graft` CLI) — reading, searching, committing, landing, and resolving conflicts. Use whenever a task involves a Graft repository.
---

# Working with Graft

Graft is server-side source control built for agents. History, rebases and merges live on the
server; you do not clone, pull or push.

## Default loop (no checkout)

1. **Orient** — `graft_tree` / `graft_find_files` / `graft_search` on `main`. Note the changeset id
   printed after `@` — that is the revision you read.
2. **Read** — `graft_read_file` (use `offset`/`limit` for big files). Copy `old` strings for edits
   exactly from this output.
3. **Commit + land in one call** — `graft_commit` with:
   - `base`: the changeset id you read from (lets the server merge safely if others landed meanwhile)
   - `changes`: prefer `edits` (exact string replacements) for small changes; `content` for new
     files or rewrites; `delete: true`; `from` to move/rename.
   - a clear `message`.
4. **Check the result**
   - `Landed on main …` → done. `(auto-rebased …)` means others landed first and your change was
     merged on top automatically — nothing to do.
   - `CONFLICT` → nothing landed. Re-read the conflicting file(s) at `main`, reapply your intent
     against the new content, and `graft_commit` again with `base` set to the head it reported.
   - An edit error such as "old text matches 2 times" or "not found" → re-read the file and include
     more surrounding context in `old`.

## Running tests or builds

Tools that need real files should use the CLI workspace (fast, sparse, on-demand):

```bash
graft clone <repo> work --sparse src/ --sparse package.json   # only what you need
cd work && graft add-sparse tests/                              # pull more paths later
# edit files, run tests …
graft status && graft diff
graft commit -m "Fix X" --land                                  # uploads only changed blobs
graft sync                                                      # move to latest main (3-way merges local edits)
```

## Rules of thumb

- Land small changes directly on `main`. Branches are for release lines, not per-task work.
- One logical change per commit; several files per commit is fine.
- Always pass `base` when you read before writing. Without it the server assumes you edited the
  current `main`, which can silently overwrite a concurrent change to the same file.
- Use `graft_log path=…` and `graft_blame` to understand why code is the way it is before
  changing it.
