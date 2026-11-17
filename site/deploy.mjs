#!/usr/bin/env node
/**
 * Deploy site/dist to Cloudflare Pages: production (latest) + a permanent per-version alias.
 * Auth: `npx wrangler login` once, or CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID).
 * Project name: GRAFT_SITE_PROJECT (default "graft-vcs"); created on first deploy.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "site/dist");
const project = process.env.GRAFT_SITE_PROJECT || "graft-vcs";
if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(project)) throw new Error(`invalid Pages project name: ${project}`);
if (!existsSync(join(dist, "index.html"))) throw new Error("site/dist is empty — run npm run site:build first");
const version = JSON.parse(readFileSync(join(dist, "data/version.json"), "utf8")).version;
const wrangler = join(root, "node_modules/.bin/wrangler");

const run = (args, opts = {}) => spawnSync(wrangler, args, { cwd: root, encoding: "utf8", ...opts });

// Create the project if it does not exist yet (an "already exists" error is fine).
// --force keeps this a classic Pages project (pages.dev URLs, per-branch aliases); wrangler 4.16x otherwise
// delegates new projects to Workers. It only matters on creation.
const create = run(["pages", "project", "create", project, "--production-branch", "main", "--force"]);
if (create.status !== 0 && !/already exists|A project with this name already exists|8000002/i.test(create.stdout + create.stderr)) {
  process.stderr.write(create.stdout + create.stderr);
  process.exit(1);
}

let commitHash = "";
try {
  commitHash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
const message = `Graft v${version}${commitHash ? ` (${commitHash})` : ""}`;

const urls = [];
for (const branch of ["main", `v${version}`]) {
  const r = run(["pages", "deploy", dist, "--project-name", project, "--branch", branch, "--commit-message", message, "--commit-dirty=true"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = r.stdout + r.stderr;
  if (r.status !== 0) {
    process.stderr.write(out);
    process.exit(1);
  }
  const u = /(https:\/\/[^\s]+\.pages\.dev)/.exec(out)?.[1];
  urls.push([branch, u]);
  console.log(`${branch === "main" ? "production" : "version alias"} (${branch}): ${u ?? "(see wrangler output)"}`);
}
console.log(`\nproduction: https://${project}.pages.dev  ·  this release: https://v${version.replace(/\./g, "-")}.${project}.pages.dev`);
