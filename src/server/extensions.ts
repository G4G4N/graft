/**
 * Extension API: lets add-ons plug identity, access control and event handling into the server
 * without changing core files. Load them with GRAFT_EXTENSIONS=path/to/a.js,path/to/b.js.
 *
 * Order of operations for every API request (except /api/health and /api/version):
 *   1. authenticate  — the first extension that returns an Identity wins. If none does, the built-in
 *                      GRAFT_TOKEN / GRAFT_READ_TOKEN check applies (when configured).
 *   2. authorize     — every extension that implements it must return true, or the request gets 403.
 *   3. the request runs; then onEvent is called for each write it made (and for denied requests).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingHttpHeaders } from "node:http";

export interface Identity {
  /** Recorded as the author of every changeset this caller creates (the x-graft-author header is ignored). */
  name: string;
  /** Extension-defined, e.g. ["admin"] or ["write"]. */
  roles?: string[];
  /** Anything else the extension wants to carry from authenticate to authorize. */
  claims?: Record<string, unknown>;
}

/** read: GET requests. write: commits, lands, refs, blobs. admin: creating repositories. */
export type Action = "read" | "write" | "admin";

export interface RequestInfo {
  method: string;
  path: string;
  /** Repository name for /api/repos/:repo/... routes. */
  repo?: string;
  ip?: string;
  headers: IncomingHttpHeaders;
}

export type GraftEventType = "repo.created" | "changeset.created" | "branch.landed" | "ref.updated" | "access.denied";

export interface GraftEvent {
  type: GraftEventType;
  at: string;
  actor: string;
  repo?: string;
  ip?: string;
  data: Record<string, unknown>;
}

export interface GraftExtension {
  name: string;
  /**
   * Identify the caller. Return an Identity to accept, null to let the next extension (or the built-in
   * token check) decide, or throw a GraftError(401) to reject outright.
   */
  authenticate?(req: RequestInfo): Identity | null | Promise<Identity | null>;
  /** Return false to deny with 403. `identity` is null for anonymous callers. */
  authorize?(identity: Identity | null, action: Action, req: RequestInfo): boolean | Promise<boolean>;
  /** Observe writes and denials (audit logs, webhooks, metrics). Errors are logged and never fail the request. */
  onEvent?(event: GraftEvent): void | Promise<void>;
}

/** Import extension modules. Each must default-export a GraftExtension, or a function returning one. */
export async function loadExtensions(specs: string[]): Promise<GraftExtension[]> {
  const out: GraftExtension[] = [];
  for (const spec of specs.map((s) => s.trim()).filter(Boolean)) {
    const mod = await import(pathToFileURL(resolve(spec)).href);
    let ext = mod.default ?? mod.extension;
    if (typeof ext === "function") ext = await ext();
    if (!ext || typeof ext !== "object" || typeof ext.name !== "string") {
      throw new Error(`${spec} does not export a Graft extension (a default export with a "name")`);
    }
    out.push(ext as GraftExtension);
  }
  return out;
}
