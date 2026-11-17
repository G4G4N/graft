/**
 * The shared "build a web app together" workload. Every agent owns one page of the Field Guide app
 * and lands three changes:
 *   1. scaffold  — create pages/<slug>.js and append its CSS block to styles.css   (hot append file)
 *   2. register  — add an import + route to app.js and a nav link to index.html     (sorted inserts)
 *   3. changelog — add an entry under "## Unreleased" in CHANGELOG.md               (hot append file)
 * All transforms are idempotent so a conflicted step can simply be re-applied to fresh content.
 */
export interface Task {
  slug: string;
  label: string;
  summary: string;
  hue: number;
}

export interface Step {
  name: "scaffold" | "register" | "changelog";
  /** Existing files the step reads and rewrites. */
  reads: string[];
  /** Returns the new content of every file the step writes. */
  apply: (read: (path: string) => string) => Record<string, string>;
  message: string;
}

export const ident = (slug: string) => slug.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** Insert `line` between marker lines, keeping lines sorted by `key`. No-op if already present. */
export function insertSorted(text: string, start: string, end: string, line: string, key: (l: string) => string): string {
  const lines = text.split("\n");
  const s = lines.findIndex((l) => l.includes(start));
  const e = lines.findIndex((l, i) => i > s && l.includes(end));
  if (s < 0 || e < 0) throw new Error(`markers ${start}/${end} not found`);
  if (lines.slice(s + 1, e).some((l) => l.trim() === line.trim())) return text;
  let at = e;
  for (let i = s + 1; i < e; i++) {
    if (!lines[i].trim()) continue;
    if (key(lines[i]) > key(line)) {
      at = i;
      break;
    }
  }
  lines.splice(at, 0, line);
  return lines.join("\n");
}

/** Insert `block` right before the end marker (everyone appends at the same place). No-op if present. */
export function appendBefore(text: string, end: string, block: string, sentinel: string): string {
  if (text.includes(sentinel)) return text;
  const i = text.indexOf(end);
  if (i < 0) throw new Error(`marker ${end} not found`);
  return text.slice(0, i) + block + text.slice(i);
}

export function pageModule(t: Task): string {
  return `export const title = ${JSON.stringify(t.label)};
export const summary = ${JSON.stringify(t.summary)};

export function render() {
  return \`
    <article class="page-${t.slug}">
      <h1>${t.label}</h1>
      <p class="lede">${t.summary}</p>
      <dl class="facts">
        <dt>Section</dt><dd>${t.label.split(" ")[0]}</dd>
        <dt>Written by</dt><dd>agent ${t.slug}</dd>
      </dl>
      <p><a href="#/">← Back to the guide</a></p>
    </article>\`;
}
`;
}

export function cssBlock(t: Task): string {
  return `.page-${t.slug} h1 { color: hsl(${t.hue} 55% 35%); }
.page-${t.slug} .facts { border-left: 4px solid hsl(${t.hue} 55% 45%); padding-left: 12px; }
`;
}

export function stepsFor(t: Task): Step[] {
  const id = ident(t.slug);
  return [
    {
      name: "scaffold",
      reads: ["styles.css"],
      message: `${t.label}: add page`,
      apply: (read) => ({
        [`pages/${t.slug}.js`]: pageModule(t),
        "styles.css": appendBefore(read("styles.css"), "/* pages:end */", cssBlock(t), `.page-${t.slug} h1`),
      }),
    },
    {
      name: "register",
      reads: ["app.js", "index.html"],
      message: `${t.label}: register route and nav link`,
      apply: (read) => {
        let app = read("app.js");
        app = insertSorted(app, "imports:start", "imports:end", `import * as ${id} from "./pages/${t.slug}.js";`, (l) => l.trim());
        app = insertSorted(app, "routes:start", "routes:end", `  "/${t.slug}": ${id},`, (l) => l.trim());
        const nav = insertSorted(read("index.html"), "nav:start", "nav:end", `      <a href="#/${t.slug}">${t.label}</a>`, (l) =>
          l.replace(/<[^>]+>/g, "").trim().toLowerCase(),
        );
        return { "app.js": app, "index.html": nav };
      },
    },
    {
      name: "changelog",
      reads: ["CHANGELOG.md"],
      message: `${t.label}: changelog`,
      apply: (read) => {
        const text = read("CHANGELOG.md");
        const entry = `- Added the ${t.label} page.`;
        if (text.includes(entry)) return { "CHANGELOG.md": text };
        return { "CHANGELOG.md": text.replace("## Unreleased\n\n", `## Unreleased\n\n${entry}\n`) };
      },
    },
  ];
}

/** Check the finished app: every page must be fully present (no lost updates). */
export function verify(read: (p: string) => string | null, tasks: Task[]) {
  const app = read("app.js") ?? "";
  const nav = read("index.html") ?? "";
  const css = read("styles.css") ?? "";
  const log = read("CHANGELOG.md") ?? "";
  const missing: string[] = [];
  for (const t of tasks) {
    const id = ident(t.slug);
    if (!read(`pages/${t.slug}.js`)) missing.push(`${t.slug}: page file`);
    if (!app.includes(`import * as ${id} from "./pages/${t.slug}.js";`)) missing.push(`${t.slug}: import`);
    if (!app.includes(`"/${t.slug}": ${id},`)) missing.push(`${t.slug}: route`);
    if (!nav.includes(`href="#/${t.slug}"`)) missing.push(`${t.slug}: nav link`);
    // Any rule scoped to the page counts (real agents write their own selectors).
    if (!new RegExp(`\\.page-${t.slug}(?![\\w-])`).test(css)) missing.push(`${t.slug}: css`);
    if (!log.includes(`- Added the ${t.label} page.`)) missing.push(`${t.slug}: changelog`);
  }
  const markers = [app, nav, css, log].some((s) => /^(<<<<<<<|>>>>>>>)/m.test(s));
  return { ok: !missing.length && !markers, missing, conflictMarkers: markers };
}

/** Resolve git-style conflict markers by keeping the upstream ("theirs" in graft's local view) side. */
export function takeUpstream(text: string): string {
  return text.replace(/^<<<<<<< [^\n]*\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm, "$1");
}
