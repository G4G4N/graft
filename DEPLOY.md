# Deploying Graft

This guide covers the four things you deploy: the **server**, the **clients** that agents use
(MCP plugin and CLI), the **landing site**, and **releases**. Every command is meant to be copied as is.

- [1. Try it locally (2 minutes)](#1-try-it-locally-2-minutes)
- [2. Run the server in production](#2-run-the-server-in-production)
- [3. Connect agents](#3-connect-agents)
- [4. Upgrades and versioning](#4-upgrades-and-versioning)
- [5. Backups](#5-backups)
- [6. Deploy the landing site to Cloudflare Pages](#6-deploy-the-landing-site-to-cloudflare-pages)
- [7. Cut a release](#7-cut-a-release)
- [8. Security checklist](#8-security-checklist)

Requirements: Node.js 22.5 or newer (the server uses the built-in `node:sqlite`), or Docker.

## 1. Try it locally (2 minutes)

```bash
git clone https://github.com/G4G4N/graft && cd graft
npm install
npm run build
npm start
```

The server listens on `http://127.0.0.1:7070` and the web viewer is at `/`. With no token it only
answers loopback host names, so nothing else on your network can reach it.

```bash
node bin/graft.js create demo
node bin/graft.js clone demo work && cd work
echo "hello" > README.md && node ../bin/graft.js commit -m "First commit"
```

## 2. Run the server in production

### Docker Compose (recommended)

```bash
export GRAFT_TOKEN=$(openssl rand -hex 32)      # keep this; agents need it
docker compose up -d --build
curl -s http://127.0.0.1:7070/api/version
```

The compose file:

- refuses to start without `GRAFT_TOKEN`,
- publishes the port on the host's loopback interface only (`127.0.0.1:7070`),
- runs as an unprivileged user with a read-only root filesystem and no Linux capabilities,
- stores everything in the `graft-data` volume (`/data`: `graft.db` plus a `blobs/` directory).

### Put TLS in front

Agents send the token on every request, so never expose the server over plain HTTP. Any reverse proxy
works. With [Caddy](https://caddyserver.com) (automatic certificates):

```caddyfile
graft.example.com {
  reverse_proxy 127.0.0.1:7070
  request_body {
    max_size 64MB
  }
}
```

Clients then use `GRAFT_URL=https://graft.example.com`.

### Plain Node (systemd)

```ini
# /etc/systemd/system/graft.service
[Unit]
Description=Graft source control server
After=network.target

[Service]
User=graft
WorkingDirectory=/opt/graft
Environment=GRAFT_DATA=/var/lib/graft
Environment=GRAFT_HOST=127.0.0.1
Environment=PORT=7070
EnvironmentFile=/etc/graft/token.env
ExecStart=/usr/bin/node bin/graft-server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/graft

[Install]
WantedBy=multi-user.target
```

`/etc/graft/token.env` contains `GRAFT_TOKEN=...` and should be readable only by root and `graft`.

### Server configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRAFT_TOKEN` | none | Bearer token for every API call. Required to listen beyond loopback. At least 16 characters. |
| `GRAFT_READ_TOKEN` | none | Optional read-only token (GET requests only), e.g. for the web viewer. |
| `GRAFT_HOST` | `127.0.0.1` | Interface to listen on. The Docker image sets `0.0.0.0`. |
| `PORT` | `7070` | Port. |
| `GRAFT_DATA` | `./graft-data` | Database and blob directory. |
| `GRAFT_ALLOWED_HOSTS` | loopback names | Comma-separated host names served when no token is set (DNS-rebinding protection). |
| `GRAFT_ALLOW_OPEN` | unset | `1` lets a token-less server listen beyond loopback. Only on a trusted network. |
| `GRAFT_MAX_JSON_BYTES` | 16 MiB | Largest JSON request (a commit with inline content). |
| `GRAFT_MAX_BLOB_BYTES` | 64 MiB | Largest single blob upload. |
| `GRAFT_QUIET` | unset | `1` turns off the request log. |
| `GRAFT_EXTENSIONS` | none | Comma-separated paths to extension modules (identity, access control, audit). See README → Extensions. |

Health: `GET /api/health` (no auth) returns `{"ok": true, "version": "…"}`.

## 3. Connect agents

### Claude Code (MCP plugin)

```bash
claude plugin marketplace add /path/to/graft
claude plugin install graft@graft
```

Set these in the environment Claude Code starts from:

```bash
export GRAFT_URL=https://graft.example.com
export GRAFT_TOKEN=...            # the server's token
export GRAFT_REPO=my-repo         # optional default repository
export GRAFT_AUTHOR=claude-agent  # optional: author name on commits
```

### Any other MCP client

The plugin's server is a single file with no dependencies: `node plugin/dist/graft-mcp.js` (stdio).
Pass the same environment variables.

### The `graft` CLI

```bash
cd /path/to/graft && npm install && npm run build && npm link   # puts `graft` on PATH
graft version                                                    # client, server, protocol check
```

## 4. Upgrades and versioning

Graft carries three independent version numbers:

| What | Where | Rule |
| --- | --- | --- |
| **Release** (`0.2.0`) | `package.json`, `src/version.ts`, plugin manifest, `/api/version`, `x-graft-version` header | [Semantic Versioning](https://semver.org). While the major version is 0, a minor release may change behavior; read `CHANGELOG.md`. |
| **Wire protocol** (`1`) | `x-graft-protocol` request header, `/api/version` → `protocol` / `minProtocol` | Clients announce their protocol. A server answers HTTP **426** if it does not support it, so a client never runs against an incompatible server silently. Additive API changes bump `protocol`; removing behavior bumps `minProtocol`. |
| **Database schema** (`1`) | SQLite `PRAGMA user_version` | Migrations run automatically and transactionally on startup. A server refuses a database written by a newer schema, so you cannot downgrade by accident. |

To upgrade a server:

1. Back up (section 5).
2. Pull the new release and rebuild: `docker compose up -d --build`.
3. Check: `curl -s https://graft.example.com/api/version` and `graft version` from a client.

Upgrade servers before clients when the protocol changes; `graft version` tells you which side is older.

## 5. Backups

Blobs are immutable and content-addressed; the database is a single SQLite file. For a consistent copy,
stop the server briefly:

```bash
docker compose stop graft
docker run --rm -v graft_graft-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/graft-$(date +%F).tgz -C /data .
docker compose start graft
```

To restore, extract the archive into an empty volume before starting the server.

## 6. Deploy the landing site to Cloudflare Pages

The site (`site/`) is static: the landing page, the full swarm report, the security audit, these docs,
the raw result data and the web apps the agents built.

```bash
npm run site:build                 # → site/dist (version-stamped)
npx wrangler login                 # once, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npm run site:deploy                # builds, then deploys
```

`npm run site:deploy` publishes two deployments:

- **production** — `https://<project>.pages.dev`, always the latest release;
- **a version alias** — `https://v0-2-0.<project>.pages.dev`, a permanent snapshot of that release's site
  and results.

Set `GRAFT_SITE_PROJECT` to choose the Pages project name (default `graft-vcs`). The project is created
on first deploy. To use your own domain, add it under *Workers & Pages → your project → Custom domains*
in the Cloudflare dashboard.

Security headers (CSP, HSTS, `nosniff`, frame protection) ship with the site in `site/public/_headers`.

## 7. Cut a release

1. Describe the changes under `## [Unreleased]` in `CHANGELOG.md`.
2. Run:

   ```bash
   npm run release -- minor --tag     # or: patch | major | 1.4.0; add --dry-run to preview
   git push --follow-tags
   docker build -t graft:$(node -p "require('./package.json').version") .
   npm run site:deploy
   ```

`npm run release` bumps every version field, dates the changelog section, rebuilds the MCP bundle, runs
the full test suite and (with `--tag`) commits and creates an annotated `vX.Y.Z` tag. It never pushes.

## 8. Security checklist

- [ ] `GRAFT_TOKEN` set, 32+ random bytes, stored outside the repository.
- [ ] TLS terminates in front of the server; the server port is not reachable directly.
- [ ] Separate deployments per trust boundary (all token holders are equally trusted).
- [ ] Backups scheduled and a restore tested.
- [ ] `npm audit` clean and the latest release deployed.

Report security issues privately to the maintainers.
