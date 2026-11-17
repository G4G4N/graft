/**
 * Line diffing (Myers O(ND)), unified diff rendering and 3-way merge.
 * Lines keep their trailing "\n" so join("") reproduces the exact text.
 */

export type Op = "=" | "-" | "+";

export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/);
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Returns an edit script: for each step, "=" (line in both), "-" (only in a), "+" (only in b). */
export function diffOps(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix — the common case for agent edits.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid = myers(A, B);
  return [...Array(pre).fill("="), ...mid, ...Array(suf).fill("=")];
}

/** Upper bound on trace entries kept for backtracking (~4 bytes each). Bounds memory at ~80 MB worst case. */
const TRACE_BUDGET = 20_000_000;

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array(m).fill("+");
  if (m === 0) return Array(n).fill("-");
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Each step d only needs diagonals -d..d, so store compact slices: total trace size is O(D^2),
  // not O(D * (N+M)). If the edit distance blows the budget, fall back to replace-all.
  const trace: Int32Array[] = [];
  let used = 0;
  let found = -1;
  for (let d = 0; d <= max; d++) {
    const width = 2 * d + 3;
    if (used + width > TRACE_BUDGET) break;
    used += width;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [...Array(n).fill("-"), ...Array(m).fill("+")];
  // Backtrack
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vp = trace[d];
    const at = (kk: number) => vp[kk + d + 1]; // compact slice covers diagonals -d-1..d+1
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("+");
      y--;
    } else {
      ops.push("-");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}

/** A changed region: a[aStart, aEnd) was replaced by b[bStart, bEnd). */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export function hunks(a: string[], b: string[]): Hunk[] {
  const ops = diffOps(a, b);
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op === "=") {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      i++;
      j++;
    } else {
      if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j };
      if (op === "-") {
        i++;
        cur.aEnd = i;
      } else {
        j++;
        cur.bEnd = j;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  oldName: string,
  newName: string,
  context = 3,
): { patch: string; stat: DiffStat } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const hs = hunks(a, b);
  let added = 0;
  let removed = 0;
  if (hs.length === 0) return { patch: "", stat: { added, removed } };
  const lines: string[] = [`--- ${oldName}\n`, `+++ ${newName}\n`];
  const nl = (s: string) => (s.endsWith("\n") ? s : s + "\n\\ No newline at end of file\n");
  // Group hunks whose context windows overlap.
  let g = 0;
  while (g < hs.length) {
    let end = g;
    while (end + 1 < hs.length && hs[end + 1].aStart - hs[end].aEnd <= context * 2) end++;
    const aLo = Math.max(0, hs[g].aStart - context);
    const aHi = Math.min(a.length, hs[end].aEnd + context);
    const bLo = Math.max(0, hs[g].bStart - (hs[g].aStart - aLo));
    const bHi = Math.min(b.length, hs[end].bEnd + (aHi - hs[end].aEnd));
    const range = (lo: number, n: number) => `${n === 0 ? lo : lo + 1},${n}`;
    lines.push(`@@ -${range(aLo, aHi - aLo)} +${range(bLo, bHi - bLo)} @@\n`);
    let ai = aLo;
    for (let h = g; h <= end; h++) {
      const hk = hs[h];
      while (ai < hk.aStart) lines.push(" " + nl(a[ai++]));
      for (let x = hk.aStart; x < hk.aEnd; x++) {
        lines.push("-" + nl(a[x]));
        removed++;
      }
      for (let y = hk.bStart; y < hk.bEnd; y++) {
        lines.push("+" + nl(b[y]));
        added++;
      }
      ai = hk.aEnd;
    }
    while (ai < aHi) lines.push(" " + nl(a[ai++]));
    g = end + 1;
  }
  return { patch: lines.join(""), stat: { added, removed } };
}

export interface MergeResult {
  clean: boolean;
  text: string;
  conflictCount: number;
}

/**
 * Three-way line merge. Non-overlapping edits from both sides combine cleanly;
 * identical edits on both sides are taken once; anything else is a conflict
 * rendered with git-style markers.
 */
export function merge3(base: string, ours: string, theirs: string, labels = { ours: "ours", theirs: "theirs" }): MergeResult {
  if (ours === theirs) return { clean: true, text: ours, conflictCount: 0 };
  if (base === ours) return { clean: true, text: theirs, conflictCount: 0 };
  if (base === theirs) return { clean: true, text: ours, conflictCount: 0 };
  const B = splitLines(base);
  const O = splitLines(ours);
  const T = splitLines(theirs);
  type Tagged = Hunk & { side: 0 | 1 };
  const all: Tagged[] = [
    ...hunks(B, O).map((h) => ({ ...h, side: 0 as const })),
    ...hunks(B, T).map((h) => ({ ...h, side: 1 as const })),
  ].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd);

  const out: string[] = [];
  let pos = 0;
  let conflicts = 0;
  let i = 0;
  const sideText = (group: Tagged[], side: 0 | 1, lo: number, hi: number) => {
    const src = side === 0 ? O : T;
    const res: string[] = [];
    let p = lo;
    for (const h of group.filter((g) => g.side === side)) {
      res.push(...B.slice(p, h.aStart), ...src.slice(h.bStart, h.bEnd));
      p = h.aEnd;
    }
    res.push(...B.slice(p, hi));
    return res;
  };
  while (i < all.length) {
    const group = [all[i]];
    let lo = all[i].aStart;
    let hi = all[i].aEnd;
    i++;
    while (i < all.length && (all[i].aStart < hi || all[i].aStart === lo)) {
      group.push(all[i]);
      hi = Math.max(hi, all[i].aEnd);
      i++;
    }
    out.push(...B.slice(pos, lo));
    const sides = new Set(group.map((g) => g.side));
    if (sides.size === 1) {
      const s = group[0].side;
      out.push(...sideText(group, s, lo, hi));
    } else {
      const o = sideText(group, 0, lo, hi);
      const t = sideText(group, 1, lo, hi);
      if (o.join("") === t.join("")) out.push(...o);
      else {
        conflicts++;
        const end = (arr: string[]) => (arr.length && !arr[arr.length - 1].endsWith("\n") ? "\n" : "");
        out.push(`<<<<<<< ${labels.ours}\n`, ...o, end(o), "=======\n", ...t, end(t), `>>>>>>> ${labels.theirs}\n`);
      }
    }
    pos = hi;
  }
  out.push(...B.slice(pos));
  return { clean: conflicts === 0, text: out.join(""), conflictCount: conflicts };
}
