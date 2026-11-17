// Graft web viewer: repos, live history, changesets with diffs, file browser with blame.
const $app = document.getElementById("app");
const $crumbs = document.getElementById("crumbs");
const $live = document.getElementById("live");
let pollTimer = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (id) => (id ? id.slice(0, 12) : "");
const enc = encodeURIComponent;

function token() {
  try { return localStorage.getItem("graft-token") || ""; } catch { return ""; }
}
function setToken(t) {
  try { localStorage.setItem("graft-token", t); } catch {}
}

async function api(path, query = {}) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  const headers = {};
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(u, { headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("auth"), { auth: true });
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(1, Math.floor(s))}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function crumbs(parts) {
  $crumbs.innerHTML = parts.map((p) => (p.href ? `<a href="${p.href}">${esc(p.label)}</a>` : `<span>${esc(p.label)}</span>`)).join("<span>/</span>");
}

function live(on) {
  $live.className = on ? "live on" : "live";
  $live.textContent = on ? "live" : "";
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  live(false);
}

// ------------------------------------------------------------------ views

async function viewRepos() {
  crumbs([]);
  const { repos } = await api("/api/repos");
  $app.innerHTML = `
    <h1>Repositories</h1>
    <p class="muted">Agent-first source control. Commits, rebases and merges happen on the server.</p>
    <div class="card" style="margin-top:16px">
      ${repos.length ? repos.map((r) => `
        <a class="row" href="#/r/${enc(r.name)}" style="color:inherit;text-decoration:none">
          <strong>${esc(r.name)}</strong>
          <span class="grow muted">${esc(r.description)}</span>
          <span class="id">main ${short(r.head)}</span>
        </a>`).join("") : `<div class="empty">No repositories yet.<br><code>graft create my-repo</code> or the <code>graft_create_repo</code> MCP tool.</div>`}
    </div>`;
}

function repoHeader(repo, info, tab) {
  crumbs([{ label: repo, href: `#/r/${enc(repo)}` }]);
  const main = info.refs.find((r) => r.name === "main");
  return `
    <h1>${esc(repo)}</h1>
    <div class="stats">
      <span><b>${info.changesets.toLocaleString()}</b> changesets</span>
      <span><b>${info.refs.length}</b> ref${info.refs.length === 1 ? "" : "s"}</span>
      <span>main <code>${short(main?.target)}</code> · updated ${main ? ago(main.updatedAt) : "never"}</span>
    </div>
    <nav class="tabs">
      <a href="#/r/${enc(repo)}" class="${tab === "log" ? "active" : ""}">History</a>
      <a href="#/r/${enc(repo)}/tree/main/" class="${tab === "tree" ? "active" : ""}">Files</a>
      <a href="#/r/${enc(repo)}/search" class="${tab === "search" ? "active" : ""}">Search</a>
      <a href="#/r/${enc(repo)}/refs" class="${tab === "refs" ? "active" : ""}">Branches</a>
    </nav>`;
}

function logRows(repo, list) {
  return list.map((c) => `
    <a class="row" href="#/r/${enc(repo)}/c/${c.id}" style="color:inherit;text-decoration:none">
      <span class="id">${short(c.id)}</span>
      <span class="grow">${esc(c.message.split("\n")[0])}</span>
      ${c.rebasedFrom ? `<span class="pill hide-sm" title="Landed via server-side rebase">auto-rebased</span>` : ""}
      <span class="muted hide-sm">${esc(c.author)}</span>
      <span class="muted hide-sm">${c.changeCount} file${c.changeCount === 1 ? "" : "s"}</span>
      <span class="muted" style="min-width:64px;text-align:right">${ago(c.createdAt)}</span>
    </a>`).join("");
}

async function viewLog(repo, path) {
  const [info, log] = await Promise.all([api(`/api/repos/${enc(repo)}`), api(`/api/repos/${enc(repo)}/log`, { limit: 100, path })]);
  $app.innerHTML = repoHeader(repo, info, "log") +
    (path ? `<p class="muted">History of <code>${esc(path)}</code> · <a href="#/r/${enc(repo)}">all</a></p>` : "") +
    `<div class="card" id="log">${logRows(repo, log.changesets) || `<div class="empty">No history.</div>`}</div>`;
  if (!path) {
    let head = log.start;
    live(true);
    pollTimer = setInterval(async () => {
      try {
        const l = await api(`/api/repos/${enc(repo)}/log`, { limit: 100 });
        if (l.start !== head) {
          head = l.start;
          document.getElementById("log").innerHTML = logRows(repo, l.changesets);
        }
      } catch {}
    }, 3000);
  }
}

function renderPatch(patch) {
  const rows = [];
  let a = 0, b = 0;
  let inHunk = false;
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    // Only the file header (before the first @@) is skipped. A removed line "-- comment" renders as
    // "--- comment" inside a hunk and must still be shown.
    if (!inHunk && (line.startsWith("---") || line.startsWith("+++"))) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      const m = /-(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      a = +m[1]; b = +m[2];
      rows.push(`<tr class="hunk"><td class="ln"></td><td class="ln"></td><td>${esc(line)}</td></tr>`);
    } else if (line.startsWith("+")) {
      rows.push(`<tr class="add"><td class="ln"></td><td class="ln">${b++}</td><td>${esc(line)}</td></tr>`);
    } else if (line.startsWith("-")) {
      rows.push(`<tr class="del"><td class="ln">${a++}</td><td class="ln"></td><td>${esc(line)}</td></tr>`);
    } else if (line.startsWith("\\")) {
      rows.push(`<tr><td class="ln"></td><td class="ln"></td><td class="muted">${esc(line)}</td></tr>`);
    } else {
      rows.push(`<tr><td class="ln">${a++}</td><td class="ln">${b++}</td><td>${esc(line)}</td></tr>`);
    }
  }
  return `<div class="code"><table>${rows.join("")}</table></div>`;
}

async function viewChangeset(repo, id) {
  const [info, cs] = await Promise.all([api(`/api/repos/${enc(repo)}`), api(`/api/repos/${enc(repo)}/changesets/${enc(id)}`)]);
  const d = await api(`/api/repos/${enc(repo)}/diff`, { to: cs.id });
  const header = repoHeader(repo, info, "log"); // sets the repo crumb; refine it below
  crumbs([{ label: repo, href: `#/r/${enc(repo)}` }, { label: short(cs.id) }]);
  $app.innerHTML = `
    ${header}
    <div class="card" style="padding:16px 18px">
      <h1 style="font-size:17px;white-space:pre-wrap">${esc(cs.message)}</h1>
      <div class="stats">
        <span><b>${esc(cs.author)}</b> · ${new Date(cs.createdAt).toLocaleString()}</span>
        <span>changeset <code>${short(cs.id)}</code></span>
        <span>parent${cs.parents.length > 1 ? "s" : ""} ${cs.parents.map((p) => `<a href="#/r/${enc(repo)}/c/${p}"><code>${short(p)}</code></a>`).join(" ") || "none"}</span>
        ${cs.rebasedFrom ? `<span class="pill">auto-rebased from <code>${short(cs.rebasedFrom)}</code></span>` : ""}
        <span><a href="#/r/${enc(repo)}/tree/${cs.id}/">browse files</a></span>
      </div>
      <div class="stats"><span>${d.stat.files} file${d.stat.files === 1 ? "" : "s"}</span><span class="add">+${d.stat.added}</span><span class="del">−${d.stat.removed}</span></div>
    </div>
    <div class="stack" style="margin-top:14px">
      ${d.files.map((f) => `
        <div class="card">
          <div class="filehead">
            <span class="pill ${f.status === "deleted" ? "warn" : ""}">${f.status}</span>
            <a class="grow" href="#/r/${enc(repo)}/tree/${cs.id}/${f.path.split("/").map(enc).join("/")}">${esc(f.path)}</a>
            <span class="add">+${f.added}</span><span class="del">−${f.removed}</span>
          </div>
          ${f.binary ? `<div class="empty">Binary file</div>` : f.patch ? renderPatch(f.patch) : ""}
        </div>`).join("") || `<div class="card"><div class="empty">No file changes (root or empty changeset).</div></div>`}
    </div>`;
}

async function viewTree(repo, rev, path, blame) {
  const info = await api(`/api/repos/${enc(repo)}`);
  const parts = path ? path.split("/") : [];
  const treeHref = (i) => `#/r/${enc(repo)}/tree/${enc(rev)}/${parts.slice(0, i + 1).map(enc).join("/")}`;
  const pathCrumbs = `<div class="toolbar mono"><a href="#/r/${enc(repo)}/tree/${enc(rev)}/">${esc(repo)}</a>${parts.map((p, i) => ` / <a href="${treeHref(i)}">${esc(p)}</a>`).join("")}<span class="muted">@ ${esc(rev.length === 64 ? short(rev) : rev)}</span></div>`;
  let body;
  try {
    const t = await api(`/api/repos/${enc(repo)}/tree`, { rev, path });
    body = `<div class="card">${t.entries.map((e) => `
      <a class="row" href="#/r/${enc(repo)}/tree/${enc(rev)}/${e.path.split("/").map(enc).join("/")}" style="color:inherit;text-decoration:none">
        <span>${e.type === "dir" ? "📁" : "📄"}</span><span class="grow">${esc(e.name)}${e.type === "dir" ? "/" : ""}</span>
      </a>`).join("") || `<div class="empty">Empty</div>`}</div>`;
  } catch (e) {
    if (!/is a file/.test(e.message)) throw e;
    const f = await api(`/api/repos/${enc(repo)}/file`, { rev, path });
    const toggle = `<a href="#/r/${enc(repo)}/${blame ? "tree" : "blame"}/${enc(rev)}/${parts.map(enc).join("/")}">${blame ? "hide blame" : "blame"}</a>`;
    const histLink = `<a href="#/r/${enc(repo)}/history/${parts.map(enc).join("/")}">history</a>`;
    let rows;
    if (f.binary) rows = `<div class="empty">Binary file · ${f.size.toLocaleString()} bytes</div>`;
    else if (blame) {
      const b = await api(`/api/repos/${enc(repo)}/blame`, { rev, path });
      let prev = null;
      rows = `<div class="code"><table>${b.lines.map((l) => {
        const meta = b.changesets[l.changeset];
        const show = l.changeset !== prev; prev = l.changeset;
        return `<tr><td class="bl">${show ? `<a href="#/r/${enc(repo)}/c/${l.changeset}">${short(l.changeset).slice(0, 8)}</a> ${esc((meta?.author || "").slice(0, 14))}` : ""}</td><td class="ln">${l.line}</td><td>${esc(l.text)}</td></tr>`;
      }).join("")}</table></div>`;
    } else {
      const lines = f.content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      rows = `<div class="code"><table>${lines.map((l, i) => `<tr><td class="ln">${i + 1}</td><td>${esc(l)}</td></tr>`).join("")}</table></div>`;
    }
    body = `<div class="card"><div class="filehead"><span class="grow">${esc(path)}</span><span class="muted">${f.size.toLocaleString()} bytes</span>${histLink}${f.binary ? "" : toggle}</div>${rows}</div>`;
  }
  $app.innerHTML = repoHeader(repo, info, "tree") + pathCrumbs + body;
}

async function viewSearch(repo, q) {
  const info = await api(`/api/repos/${enc(repo)}`);
  $app.innerHTML = repoHeader(repo, info, "search") + `
    <form class="toolbar" id="sf">
      <input type="search" name="q" placeholder="Search code on main…" value="${esc(q)}" style="flex:1;min-width:200px" autofocus>
      <label class="muted"><input type="checkbox" name="regex"> regex</label>
      <button>Search</button>
    </form>
    <div id="results"></div>`;
  const form = document.getElementById("sf");
  form.onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/r/${enc(repo)}/search/${enc(form.q.value)}${form.regex.checked ? "?regex=1" : ""}`;
  };
  if (!q) return;
  const regex = location.hash.includes("?regex=1");
  form.regex.checked = regex;
  const r = await api(`/api/repos/${enc(repo)}/search`, { q, regex: regex ? 1 : "", limit: 300 });
  document.getElementById("results").innerHTML = `
    <p class="muted">${r.matches.length}${r.truncated ? "+" : ""} match${r.matches.length === 1 ? "" : "es"} in ${r.filesScanned} files @ <code>${short(r.changeset)}</code></p>
    <div class="card">${r.matches.map((m) => `
      <a class="row mono" href="#/r/${enc(repo)}/tree/main/${m.path.split("/").map(enc).join("/")}" style="color:inherit;text-decoration:none">
        <span class="muted" style="white-space:nowrap">${esc(m.path)}:${m.line}</span><span class="grow">${esc(m.text)}</span>
      </a>`).join("") || `<div class="empty">No matches</div>`}</div>`;
}

async function viewRefs(repo) {
  const info = await api(`/api/repos/${enc(repo)}`);
  $app.innerHTML = repoHeader(repo, info, "refs") + `<div class="card">${info.refs.map((r) => `
    <a class="row" href="#/r/${enc(repo)}/c/${r.target}" style="color:inherit;text-decoration:none">
      <strong>${esc(r.name)}</strong><span class="grow"></span>
      <span class="id">${short(r.target)}</span><span class="muted">v${r.version} · ${ago(r.updatedAt)}</span>
    </a>`).join("")}</div>
    <p class="muted" style="margin-top:12px">Refs move only by compare-and-swap. Agents land directly on <code>main</code>; branches are for release lines.</p>`;
}

function viewAuth() {
  crumbs([]);
  $app.innerHTML = `
    <h1>Token required</h1>
    <p class="muted">This Graft server requires a bearer token (GRAFT_TOKEN or GRAFT_READ_TOKEN).</p>
    <form class="toolbar" id="tf"><input type="password" name="t" placeholder="Token" style="min-width:280px"><button>Save</button></form>`;
  document.getElementById("tf").onsubmit = (e) => {
    e.preventDefault();
    setToken(e.target.t.value);
    route();
  };
}

// ------------------------------------------------------------------ router

async function route() {
  stopPoll();
  const raw = location.hash.replace(/^#\/?/, "").replace(/\?.*$/, "");
  const parts = raw.split("/");
  const dec = (s) => decodeURIComponent(s || "");
  try {
    if (parts[0] !== "r" || !parts[1]) return await viewRepos();
    const repo = dec(parts[1]);
    const kind = parts[2];
    if (!kind) return await viewLog(repo);
    if (kind === "c") return await viewChangeset(repo, dec(parts[3]));
    if (kind === "tree" || kind === "blame") return await viewTree(repo, dec(parts[3]) || "main", parts.slice(4).filter(Boolean).map(dec).join("/"), kind === "blame");
    if (kind === "history") return await viewLog(repo, parts.slice(3).map(dec).join("/"));
    if (kind === "search") return await viewSearch(repo, dec(parts[3]));
    if (kind === "refs") return await viewRefs(repo);
    return await viewRepos();
  } catch (e) {
    if (e.auth) return viewAuth();
    $app.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

window.addEventListener("hashchange", route);
route();
api("/api/version").then((v) => {
  const el = document.createElement("span");
  el.className = "muted";
  el.style.fontSize = "12px";
  el.textContent = `v${v.version}`;
  document.querySelector(".brand").after(el);
}).catch(() => {});
