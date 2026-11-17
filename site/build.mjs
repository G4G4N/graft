#!/usr/bin/env node
/**
 * Build the static site → site/dist
 *   /                      landing page (numbers filled in from the results at build time)
 *   /report/               full swarm report
 *   /docs/  /docs/deploy/  README.md, DEPLOY.md
 *   /changelog/            CHANGELOG.md
 *   /apps/…                the Field Guide apps the agents built
 *   /data/…                raw results (JSON), version.json
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(here, "dist");
const read = (p) => readFileSync(join(root, p), "utf8");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (ms) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s` : `${(ms / 60000).toFixed(1)} min`);

/** Round step for a linear axis: 1, 2, 2.5 or 5 × 10^k. */
const niceStep = (raw) => {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((st) => st >= raw);
};
/** Tick label for a millisecond value on a linear axis (0, 500 ms, 5 s, 2 min …). */
const timeTick = (v) => (v === 0 ? "0" : v < 1000 ? `${v} ms` : v < 120000 || v % 60000 ? `${+(v / 1000).toFixed(1)} s` : `${v / 60000} min`);
const VERSION = /VERSION = "([^"]+)"/.exec(read("src/version.ts"))[1];
const PROTOCOL = /PROTOCOL_VERSION = (\d+)/.exec(read("src/server/http.ts"))[1];
const SCHEMA = /SCHEMA_VERSION = (\d+)/.exec(read("src/core/db.ts"))[1];

// Fresh report from the latest data.
execFileSync(process.execPath, [join(root, "docs/build-report.mjs")], { stdio: "inherit" });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(here, "public"), dist, { recursive: true, filter: (s) => !s.endsWith("index.html") || s !== join(here, "public/index.html") });

// ---------------------------------------------------------------- data
const R = JSON.parse(read("docs/data/results.json"));
const BUGS = JSON.parse(read("docs/data/bugs.json"));
const RUNS = JSON.parse(read("docs/data/agent-runs.json"));
const by = (mode, n) => R.scale.find((r) => r.mode === mode && r.agents === n);
const agentsList = [...new Set(R.scale.map((r) => r.agents))].sort((a, b) => a - b);
const maxN = agentsList.at(-1);
const g = by("graft", maxN), x = by("git", maxN);
const realG = R.real.graft, realX = R.real.git;
const sum = (t, k) => t.agents.reduce((s, a) => s + a[k], 0);
const mean = (k) => RUNS[k].reduce((s, r) => s + r[1], 0) / RUNS[k].length;

// ---------------------------------------------------------------- chart (built as static SVG)
function chartP50() {
  const W = 560, H = 280, L = 58, Rr = 78, T = 12, B = 34;
  const series = [
    ["graft", "--graft", "graft"],
    ["graft-cli", "--cli", "graft CLI"],
    ["git", "--git", "git"],
  ];
  // Linear time axis from 0. Milliseconds really are a thousand times smaller than seconds, so Graft's
  // line sits on the floor next to Git's — that gap is the result, and a log axis would hide it.
  const vals = R.scale.map((r) => r.landP50).filter((v) => v > 0);
  const yStep = niceStep(Math.max(...vals) / 4);
  const hi = Math.ceil(Math.max(...vals) / yStep) * yStep;
  // Linear agents axis from 0: position follows the agent count, not its place in the list.
  const xMax = maxN;
  const xStep = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 50, 64, 100].find((st) => st >= xMax / 7) ?? Math.ceil(xMax / 6);
  const X = (n) => L + (n / xMax) * (W - L - Rr);
  const Y = (v) => T + (1 - v / hi) * (H - T - B);
  const axis = timeTick;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Median time to land versus number of agents. Graft stays at ${fmt(g.landP50)}, flat on the floor; git grows to ${fmt(x.landP50)}.">`;
  s += `<g class="grid">`;
  for (let v = 0; v <= hi + 1e-9; v += yStep) s += `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${axis(v)}</text>`;
  s += `</g>`;
  for (let n = 0; n <= xMax; n += xStep) {
    s += `<line x1="${X(n)}" x2="${X(n)}" y1="${H - B}" y2="${H - B + 5}" stroke="var(--faint)"/>`;
    s += `<text x="${X(n)}" y="${H - B + 20}" text-anchor="middle">${n}</text>`;
  }
  s += `<line x1="${L}" x2="${W - Rr}" y1="${H - B}" y2="${H - B}" stroke="var(--faint)"/>`;
  s += `<text x="${(L + W - Rr) / 2}" y="${H - 2}" text-anchor="middle">agents</text>`;
  for (const [mode, color, name] of series) {
    const pts = agentsList.map((n) => [n, by(mode, n)?.landP50]).filter(([, v]) => v != null);
    s += `<polyline fill="none" stroke="var(${color})" stroke-width="2.2" stroke-linejoin="round" points="${pts.map(([n, v]) => `${X(n)},${Y(v)}`).join(" ")}"/>`;
    for (const [n, v] of pts) {
      const r = by(mode, n);
      s += `<circle cx="${X(n)}" cy="${Y(v)}" r="5" fill="var(${color})" stroke="var(--surface)" stroke-width="2" data-tip="${esc(`${name} · ${n} agents|median ${fmt(v)} · p90 ${fmt(r.landP90)}|finished app in ${fmt(r.wallMs)}`)}"/>`;
    }
    const [ln, lv] = pts.at(-1);
    s += `<text class="lbl" x="${X(ln) + 10}" y="${Y(lv) + 4}">${fmt(lv)}</text>`;
  }
  return s + `</svg>`;
}

// ---------------------------------------------------------------- shared chrome
const nav = (current) => `<header class="site-head"><div class="wrap">
  <a class="logo" href="/"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="7" r="4" fill="currentColor"/><circle cx="8" cy="25" r="4" fill="currentColor"/><circle cx="24" cy="25" r="4" fill="currentColor"/><path d="M16 11v6M16 17l-6.5 5M16 17l6.5 5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>Graft</a>
  <nav class="site-nav" aria-label="Site">
    <a class="opt" href="/#how">How it works</a>
    <a href="/report/"${current === "report" ? ' aria-current="page"' : ""}>Results</a>
    <a href="/docs/deploy/"${current === "docs" ? ' aria-current="page"' : ""}>Docs</a>
    <a class="opt" href="https://github.com/G4G4N/graft" rel="noopener">Source</a>
    <a class="ver" href="/changelog/" title="Changelog">v${VERSION}</a>
  </nav>
</div></header>`;
const footer = `<footer class="site-foot"><div class="wrap">
  <p>Graft v${VERSION} · protocol ${PROTOCOL} · schema ${SCHEMA}. An independent, MIT-licensed implementation of ideas Anthropic described in <a href="https://www.anthropic.com/engineering/redesigning-source-control" rel="noopener">Redesigning source control at Anthropic</a>; not affiliated with Anthropic.</p>
  <nav aria-label="Footer"><a href="https://github.com/G4G4N/graft" rel="noopener">GitHub</a><a href="/docs/">Overview</a><a href="/docs/deploy/">Deploy</a><a href="/changelog/">Changelog</a><a href="/data/results.json">Data</a></nav>
</div></footer>`;

const fill = (tpl, vars) => tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`template variable ${k} has no value`);
  return vars[k];
});
const write = (p, s) => {
  mkdirSync(dirname(join(dist, p)), { recursive: true });
  writeFileSync(join(dist, p), s);
};

// ---------------------------------------------------------------- landing
const resultsJson = JSON.stringify(R);
write(
  "index.html",
  fill(readFileSync(join(here, "public/index.html"), "utf8"), {
    VERSION,
    HEADER: nav("home"),
    FOOTER: footer,
    MAX_AGENTS: String(maxN),
    G_P50: fmt(g.landP50),
    G_P50_RANGE: (() => {
      const v = R.scale.filter((r) => r.mode === "graft").map((r) => r.landP50);
      return `${Math.round(Math.min(...v))}–${fmt(Math.max(...v))}`;
    })(),
    X_P50: fmt(x.landP50),
    G_WALL: fmt(g.wallMs),
    X_WALL: fmt(x.wallMs),
    WALL_RATIO: String(Math.round(x.wallMs / g.wallMs)),
    CMD_RATIO: (sum(realX, "ops") / sum(realG, "ops")).toFixed(1),
    VERIFIED: String(R.scale.filter((r) => r.verified).length + Object.values(R.real).filter((t) => t.verify?.ok).length),
    TL_AGENTS: String(R.timelineAgents),
    TL_COMMITS: String(R.timelineAgents * 3),
    REAL_AGENTS: String(realG.agents.length + realX.agents.length),
    REAL_PER_TEAM: String(realG.agents.length),
    R_X_OPS: String(sum(realX, "ops")),
    R_G_OPS: String(sum(realG, "ops")),
    R_X_VCS: fmt(sum(realX, "vcsMs")),
    R_G_VCS: fmt(sum(realG, "vcsMs")),
    R_X_RUN: fmt(mean("git")),
    R_G_RUN: fmt(mean("graft")),
    R_X_REJ: String(sum(realX, "pushRejected")),
    DATA_SIZE: `${Math.round(resultsJson.length / 1024)} KB`,
    CHART_P50: chartP50(),
  }),
);

// ---------------------------------------------------------------- markdown docs
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
const LINKS = { "DEPLOY.md": "/docs/deploy/", "CHANGELOG.md": "/changelog/", "README.md": "/docs/", "docs/graft-swarm-report.html": "/report/" };
function renderDoc(file, outPath, { section, current, description }) {
  const toc = [];
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slug(text);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: text.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        let h = href;
        for (const [k, v] of Object.entries(LINKS)) if (h === k || h.startsWith(k + "#")) h = v + h.slice(k.length);
        const ext = /^https?:/.test(h);
        return `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' rel="noopener"' : ""}>${text}</a>`;
      },
      html() {
        return ""; // docs never need raw HTML; drop it rather than trust it
      },
    },
  });
  let src = read(file);
  // Inline-code mentions of other docs become links too.
  src = src.replace(/`(DEPLOY\.md|CHANGELOG\.md)`/g, (m, f) => `[\`${f}\`](${f})`);
  const body = md.parse(src);
  const title = /^# (.+)$/m.exec(src)?.[1] ?? section;
  const tocHtml = toc.map((t) => `<a class="l${t.depth}" href="#${t.id}">${esc(t.text)}</a>`).join("");
  write(
    outPath,
    fill(readFileSync(join(here, "templates/doc.html"), "utf8"), {
      TITLE: esc(title),
      DESCRIPTION: esc(description),
      VERSION,
      HEADER: nav(current),
      FOOTER: footer,
      SECTION: esc(section),
      TOC: tocHtml,
      BODY: body,
    }),
  );
}
renderDoc("DEPLOY.md", "docs/deploy/index.html", { section: "Deploy", current: "docs", description: "Deploy the Graft server, connect agents, publish the site and cut releases." });
renderDoc("README.md", "docs/index.html", { section: "Overview", current: "docs", description: "What Graft is, how it is built and how to use it." });
renderDoc("CHANGELOG.md", "changelog/index.html", { section: "Changelog", current: "docs", description: "Every Graft release." });

// ---------------------------------------------------------------- report (self-contained page → full document)
{
  let rep = read("docs/graft-swarm-report.html");
  // Move the executable inline script to a file so the site CSP can stay script-src 'self'.
  const m = /<script>\n([\s\S]*?)<\/script>\s*$/.exec(rep);
  if (!m) throw new Error("report script not found");
  write("report/report.js", m[1]);
  rep = rep.slice(0, m.index) + `<script src="/report/report.js?v=${VERSION}"></script>\n`;
  const titleEnd = rep.indexOf("</title>") + "</title>".length;
  const headPart = rep.slice(0, rep.indexOf("<header"));
  const bodyPart = rep.slice(rep.indexOf("<header"));
  const bar = `<div style="background:var(--surface);border-bottom:1px solid var(--line);font:14px/1.4 var(--body)"><div class="wrap" style="display:flex;gap:16px;align-items:center;padding-block:10px;flex-wrap:wrap"><a href="/" style="font-weight:700;color:var(--ink);text-decoration:none">← Graft</a><span style="color:var(--muted)">v${VERSION}</span><a href="/data/results.json" style="margin-left:auto">Raw data</a><a href="/docs/deploy/">Deploy</a></div></div>`;
  write(
    "report/index.html",
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">\n${headPart.slice(0, titleEnd)}\n<meta name="description" content="Graft vs Git under an agent swarm: timings from scripted swarms and real Claude agents.">\n${headPart.slice(titleEnd)}</head>\n<body>\n${bar}\n${bodyPart}</body>\n</html>\n`,
  );
}

// ---------------------------------------------------------------- data
write("data/results.json", resultsJson);
write("data/bugs.json", JSON.stringify(BUGS, null, 1));
write("data/agent-runs.json", JSON.stringify(RUNS, null, 1));
write("data/version.json", JSON.stringify({ version: VERSION, protocol: Number(PROTOCOL), schema: Number(SCHEMA), builtAt: new Date().toISOString() }, null, 1));
write(
  "data/race.json",
  JSON.stringify({
    graft: { wallMs: R.timelines.graft.wallMs, agents: R.timelines.graft.agents, rows: R.timelines.graft.rows },
    git: { wallMs: R.timelines.git.wallMs, agents: R.timelines.git.agents, rows: R.timelines.git.rows },
  }),
);

// ---------------------------------------------------------------- the apps the agents built
const runs = join(root, "swarm/runs");
const newest = (suffix) =>
  existsSync(runs) ? readdirSync(runs).filter((d) => d.endsWith(suffix) && existsSync(join(runs, d, "app/index.html"))).sort().at(-1) : undefined;
for (const [suffix, out] of [["-real-graft", "agents-graft"], ["-real-git", "agents-git"], [`-graft-${maxN}`, `swarm-${maxN}`]]) {
  const d = newest(suffix);
  if (d) cpSync(join(runs, d, "app"), join(dist, "apps", out), { recursive: true });
  else console.warn(`warning: no run directory ending in ${suffix}; /apps/${out} skipped`);
}

// ---------------------------------------------------------------- 404 + privacy check
write("404.html", fill(readFileSync(join(here, "templates/doc.html"), "utf8"), {
  TITLE: "Not found", DESCRIPTION: "Page not found", VERSION, HEADER: nav(""), FOOTER: footer, SECTION: "404", TOC: "",
  BODY: `<h1>Not found</h1><p>That page does not exist. Try the <a href="/">home page</a> or the <a href="/docs/deploy/">docs</a>.</p>`,
}));

const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk(dist);
const leaks = files.filter((f) => /\/Users\/|\/home\/[a-z]|\/private\/(tmp|var)\/|@gmail\.com|scratch-workspaces/.test(readFileSync(f, "utf8")));
if (leaks.length) throw new Error(`refusing to publish: local paths or personal data found in ${leaks.map((f) => relative(dist, f)).join(", ")}`);
const bytes = files.reduce((s, f) => s + statSync(f).size, 0);
console.log(`site/dist: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB, v${VERSION}`);
