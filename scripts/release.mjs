#!/usr/bin/env node
/**
 * Cut a release.
 *
 *   npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--tag] [--allow-dirty]
 *
 * 1. computes the next version (SemVer) from package.json
 * 2. writes it to every place that carries it: package.json, package-lock.json, src/version.ts,
 *    plugin/.claude-plugin/plugin.json
 * 3. moves the CHANGELOG "Unreleased" section under the new version with today's date
 * 4. builds and runs the full test suite
 * 5. with --tag: commits "release: vX.Y.Z" and creates an annotated tag vX.Y.Z (never pushes)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry-run");
const tag = args.includes("--tag");
const allowDirty = args.includes("--allow-dirty");
const fail = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};
if (!bump) fail("usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--tag] [--allow-dirty]");

const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => (dry ? console.log(`  would write ${p}`) : writeFileSync(join(root, p), s));
const pkg = JSON.parse(read("package.json"));
const cur = pkg.version.split(".").map(Number);
let next;
if (bump === "major") next = `${cur[0] + 1}.0.0`;
else if (bump === "minor") next = `${cur[0]}.${cur[1] + 1}.0`;
else if (bump === "patch") next = `${cur[0]}.${cur[1]}.${cur[2] + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else fail(`not a version or bump kind: ${bump}`);
const cmp = (a, b) => a.split(".").map(Number).reduce((r, x, i) => r || x - b.split(".").map(Number)[i], 0);
if (cmp(next, pkg.version) <= 0) fail(`next version ${next} must be greater than ${pkg.version}`);

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
let inGit = true;
try {
  git("rev-parse", "--git-dir");
} catch {
  inGit = false;
}
if (tag && !inGit) fail("--tag needs a git repository");
if (inGit && !allowDirty && !dry && git("status", "--porcelain")) fail("working tree has uncommitted changes (commit them or pass --allow-dirty)");
if (inGit && tag) {
  let exists = false;
  try {
    git("rev-parse", "-q", "--verify", `refs/tags/v${next}`);
    exists = true;
  } catch {}
  if (exists) fail(`tag v${next} already exists`);
}

const changelog = read("CHANGELOG.md");
if (!/^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[)/m.test(changelog)) fail("CHANGELOG.md has no '## [Unreleased]' section");
const unreleased = /^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[)/m.exec(changelog)[1].trim();
if (!unreleased) fail("the Unreleased section of CHANGELOG.md is empty — describe the release first");

console.log(`release ${pkg.version} → ${next}${dry ? " (dry run)" : ""}`);
const repoUrl = String(pkg.repository?.url ?? pkg.repository ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; // local date, as people read it

pkg.version = next;
write("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(read("package-lock.json"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
write("src/version.ts", read("src/version.ts").replace(/VERSION = "[^"]+"/, `VERSION = "${next}"`));
const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json"));
plugin.version = next;
write("plugin/.claude-plugin/plugin.json", JSON.stringify(plugin, null, 2) + "\n");
write(
  "CHANGELOG.md",
  changelog
    .replace(/^## \[Unreleased\]\s*\n/m, `## [Unreleased]\n\n## [${next}] - ${today}\n\n`)
    .replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repoUrl}/compare/v${next}...HEAD\n[${next}]: ${repoUrl}/releases/tag/v${next}`),
);

if (dry) process.exit(0);
console.log("building and testing…");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

if (tag) {
  git("add", "package.json", "package-lock.json", "src/version.ts", "plugin/.claude-plugin/plugin.json", "plugin/dist/graft-mcp.js", "CHANGELOG.md");
  git("commit", "-m", `release: v${next}`);
  git("tag", "-a", `v${next}`, "-m", `Graft v${next}\n\n${unreleased}`);
  console.log(`tagged v${next}. Push with: git push --follow-tags`);
} else {
  console.log(`version set to ${next}. Review, commit, then tag with: git tag -a v${next} -m "Graft v${next}"`);
}
console.log(`next: docker build -t graft:${next} .   and   npm run site:deploy`);
