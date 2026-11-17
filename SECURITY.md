# Security

## Supported versions

Only the latest minor release gets security fixes. Check the version you run with `graft --version`,
`graft-server --version`, or `GET /api/version`.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security tab) rather than in a public issue. Include the version, a
description and, if possible, a proof of concept. We aim to acknowledge within 3 days.

## Threat model

| Asset | Threat | Defense |
| --- | --- | --- |
| Repository contents and history | Unauthenticated network access | Loopback-only by default; non-loopback requires `GRAFT_TOKEN` (≥ 16 chars); TLS at a reverse proxy |
| A developer's local server | Malicious web pages (CSRF, DNS rebinding) | JSON requires `application/json` (forces a CORS preflight that is never answered); cross-site `Origin` / `Sec-Fetch-Site` refused; `Host` allowlist when no token is set |
| The web viewer's token | XSS through repository content | Raw content is served as `attachment` with `nosniff` and a `sandbox` CSP; the viewer runs under `script-src 'self'` and escapes all data |
| The machine running `graft` | A malicious or compromised server | Every path from the server is validated, must be canonical, must stay inside the workspace (symlinks included); `.git` paths are rejected on both sides; blobs are hash-verified |
| Server availability | Oversized or pathological requests | 16 MiB JSON / 64 MiB blob limits, 120 s request timeout, regex and line-length caps on search, bounded diff memory |

## Known limitations

- **Author identity is self-declared** (`x-graft-author`). Everyone holding the write token is trusted
  equally. Use one deployment per trust boundary until per-token identities land.
- **No rate limiting.** Put the server behind a reverse proxy with limits if untrusted clients can reach it.
- **Regex search runs on the server thread.** Inputs are capped (1,000-char pattern, 20,000-char lines)
  but a hostile token holder can still burn CPU.
