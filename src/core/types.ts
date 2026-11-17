/** A file entry inside a changeset: the new state of `path` relative to the first parent. */
export interface FileChange {
  path: string;
  /** Content hash of the new blob, or null when the file is deleted. */
  blob: string | null;
}

export interface Changeset {
  id: string;
  repo: string;
  parents: string[];
  author: string;
  message: string;
  createdAt: string;
  generation: number;
  /** If this changeset was produced by a server-side rebase, the original changeset id. */
  rebasedFrom: string | null;
  changes: FileChange[];
}

/** Input change formats accepted by commit. Exactly one payload form per entry. */
export interface ChangeInput {
  path: string;
  /** Full UTF-8 content. */
  content?: string;
  /** Full content as base64 (binary files). */
  contentBase64?: string;
  /** Hash of a blob already uploaded via the blob API. */
  blob?: string;
  /** Delete the file. */
  delete?: boolean;
  /** String-replace edits applied against the file at the commit's base. */
  edits?: { old: string; new: string; all?: boolean }[];
  /** Rename/move: path is the destination, `from` the source (content carried over unless content given). */
  from?: string;
}

export interface Conflict {
  path: string;
  kind: "content" | "modify-delete" | "delete-modify" | "add-add" | "binary";
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** Text with <<<<<<< / ======= / >>>>>>> markers when a text merge was attempted. */
  merged?: string;
}

export interface LandResult {
  status: "landed" | "conflict" | "noop";
  branch: string;
  /** The changeset now at the tip of the branch (on success), or the current tip (on conflict). */
  head: string;
  /** The changeset that landed (may differ from the input if it was rebased). */
  landed?: string;
  rebased: boolean;
  conflicts?: Conflict[];
  attempts: number;
}

export class GraftError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
