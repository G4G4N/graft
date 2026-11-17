# Changelog

All notable changes to Graft are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Graft uses
[Semantic Versioning](https://semver.org/): while the major version is 0, minor releases may change the
API; the wire protocol and database schema have their own version numbers (see `DEPLOY.md` → Versioning).

## [Unreleased]

## [0.2.0] - 2026-11-12

### Security
- Hardened the server, CLI, dashboard and Docker setup; upgraded dependencies.

### Added
- MIT license.
- Versioning: `GET /api/version`, `x-graft-version` response header, wire-protocol negotiation (`x-graft-protocol`, HTTP 426 on mismatch), `graft --version`, `graft version`, `graft-server --version`.
- Database schema versioning with automatic, transactional migrations (`PRAGMA user_version`).
- `npm run release` to bump, changelog, build, test and tag a release.
- Swarm experiment: scripted swarm runner, live dashboard, real-agent setup/verification, results export and report.
- `GRAFT_TRACE` per-command timing log for the CLI.
- Landing page and static results site, deployable to Cloudflare Pages.
- `DEPLOY.md` with server, client, site and release instructions.

### Fixed
- 16 correctness bugs from the repository-wide scan (diff memory blowup, racily clean files, sparse overwrite, input validation, commit base on non-main branches, atomic repo creation, and more — see the report).
- `GET /api/version` answers without a token, like `/api/health`, so probes and `graft version` work.
- Docker image builds and runs as tested: unprivileged user, read-only root filesystem, data persists across restarts.

### Changed
- CLI commits send small changes inline and fetch only changed paths after a rebase.
- MCP bundle is minified.

## [0.1.0] - 2026-11-11

### Added
- Graft server: changesets, compare-and-swap refs, derived manifests/blame/history, content-addressed blobs, server-side commit + land with automatic rebase and 3-way merge.
- MCP plugin with 13 tools and a skill; `graft` CLI with sparse workspaces and a node-wide object cache; web viewer; Dockerfile.

[Unreleased]: https://github.com/G4G4N/graft/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/G4G4N/graft/releases/tag/v0.2.0
