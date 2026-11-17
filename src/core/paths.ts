import { GraftError } from "./types.js";

/**
 * Canonical repository path: forward slashes, no leading slash, no empty / "." / ".." segments,
 * no control characters, no .git segment, not under .graft/. Used by the server on every write and by
 * the CLI on every path it receives, so a malicious server cannot make a client write outside its workspace.
 */
export function normalizePath(p: string): string {
  if (typeof p !== "string") throw new GraftError(400, `path must be a string, got ${typeof p}`);
  if (/[\x00-\x1f\x7f]/.test(p)) throw new GraftError(400, `path contains control characters: ${JSON.stringify(p)}`);
  if (p.length > 4096) throw new GraftError(400, "path is too long");
  let s = p.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  if (!s) throw new GraftError(400, `invalid path: ${JSON.stringify(p)}`);
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === ".")) throw new GraftError(400, `path may not contain . or .. segments: ${p}`);
  if (parts[0] === ".graft") throw new GraftError(400, `.graft/ is reserved for workspace metadata: ${p}`);
  // Like git, never accept a .git directory anywhere: checking one out could plant hooks that run code.
  if (parts.some((x) => x.toLowerCase() === ".git")) throw new GraftError(400, `paths may not contain a .git segment: ${p}`);
  if (/^[a-zA-Z]:/.test(parts[0])) throw new GraftError(400, `paths may not start with a drive letter: ${p}`);
  return s;
}

