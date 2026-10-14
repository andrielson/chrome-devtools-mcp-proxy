# Research: exact versions to pin as `src/Dockerfile` ARG defaults

- Ticket: #5
- Date resolved: 2026-10-14
- Method: all version data below was pulled **live** on that date from the primary registry APIs (Docker Hub tag API, GHCR OCI distribution API, npm registry, PyPI JSON API) and the official release-schedule sources — not from memory. Each claim cites its source.

## Answer

| Floating reference today                          | Exact pin (as of 2026-10-14)                      |
| ------------------------------------------------- | ------------------------------------------------- |
| `node:lts-alpine`                                 | `node:24.21.0-alpine3.24`                         |
| `ghcr.io/astral-sh/uv:latest`                     | `ghcr.io/astral-sh/uv:0.13.0`                     |
| `npm install --global chrome-devtools-mcp@latest` | `npm install --global chrome-devtools-mcp@1.10.1` |
| `uv tool install mcp-proxy`                       | `uv tool install mcp-proxy==0.13.0`               |

Suggested `ARG` shape for the Dockerfile (one `ARG` per artifact, exact tags, no floating aliases, no digests — per the map's standing ruling in #1):

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_IMAGE_TAG=24.21.0-alpine3.24
ARG UV_IMAGE_TAG=0.13.0
ARG CHROME_DEVTOOLS_MCP_VERSION=1.10.1
ARG MCP_PROXY_VERSION=0.13.0

FROM node:${NODE_IMAGE_TAG}

COPY --from=ghcr.io/astral-sh/uv:${UV_IMAGE_TAG} /uv /uvx /bin/

RUN npm install --global chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION} \
  && uv tool install mcp-proxy==${MCP_PROXY_VERSION}
```

## 1. Node base image: `node:lts-alpine` → `node:24.21.0-alpine3.24`

- `lts-alpine` is currently **Node 24, codename "Krypton"**. The Node.js release schedule shows v24 (`Krypton`) in LTS since 2025-10-28, maintenance until 2028-04-30; v26 is still `Current` (`lts: false` in `https://nodejs.org/dist/index.json`, newest v24 = `v24.21.0` released 2026-09-07). Source: `https://raw.githubusercontent.com/nodejs/release/main/schedule.json`, `https://nodejs.org/dist/index.json`.
- Digest comparison on Docker Hub: the tag `lts-alpine` (updated 2026-09-18) carries exactly the same six per-architecture digests as `lts-alpine3.24`, `krypton-alpine3.24`, `24-alpine3.24`, `24.21-alpine3.24` and **`24.21.0-alpine3.24`**. Source: `https://hub.docker.com/v2/repositories/library/node/tags?name=lts-alpine` and `...?name=alpine3.24` (Docker Hub tag API, `images[].digest` sets).
- The fully-qualified form exists and is exact: `node:24.21.0-alpine3.24`. A plain `24.21.0-alpine` tag also exists and currently points at the same digest set, but it is a floating alias over the Alpine minor (a `24.21.0-alpine3.23` variant exists too), so the `alpine3.24`-suffixed form is the maximally exact choice.

Caveats:

- **LTS flip imminent**: v26 enters LTS on **2026-10-28** (schedule.json) — two weeks after this research date. From that day, Docker Hub's `lts-alpine` alias will start tracking Node 26 builds. Pinning `24.21.0-alpine3.24` stays valid regardless (it is an immutable-enough tag that keeps tracking 24.21.0-on-3.24 rebuilds only), but it is a _choice of Krypton_: when the project next refreshes pins it may prefer the v26 LTS line instead. This is expected drift, not a pin failure.
- **Tag granularity**: Docker Hub publishes `X.Y.Z-alpine` (floats across Alpine minors), `X.Y.Z-alpine3.23`, `X.Y.Z-alpine3.24` (pinned to the Alpine minor) — but _not_ Alpine patch-level (`alpine3.24.x`). A rebuild of the same tag (e.g. Alpine 3.24.x base bump) changes the digest under an unchanged tag name; if bit-for-bit reproducibility ever matters more than readability, the map's "no digests" ruling is the accepted trade-off.
- Node 24 alpine images are multi-arch (6 architectures: amd64, arm variants, arm64, ppc64le, s390x).

## 2. uv image: `ghcr.io/astral-sh/uv:latest` → `ghcr.io/astral-sh/uv:0.13.0`

- `latest` and `0.13.0` are byte-identical right now: both resolve to manifest digest `sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168` (GHCR OCI API, `GET /v2/astral-sh/uv/manifests/<tag>`, `Docker-Content-Digest` header). 0.13.0 is the highest plain version tag out of the full 7,309-tag list (paginated `GET /v2/astral-sh/uv/tags/list`).
- **Tag scheme** (full list enumerated from the registry):
  - `<X.Y.Z>` — plain version tag. **Distroless (`scratch`-based): only `/uv` and `/uvx`, no shell, no Python.** This is the variant the upstream docs recommend for `COPY --from=` binary extraction.
  - `<X.Y.Z>-alpine`, `-alpine3.21`/`-alpine3.22`/`-alpine3.23` — Alpine-based with uv preinstalled.
  - `<X.Y.Z>-debian`, `-debian-slim`, `-trixie`, `-trixie-slim` — Debian 13 "trixie" based (`debian:trixie-slim`, `buildpack-deps:trixie`).
  - `<X.Y.Z>-python3.9` … `-python3.14`, `-python3.15-rc` combined with `-alpine`/`-trixie`/`-trixie-slim`/`-dhi` — official-Python-image based.
  - `<X.Y.Z>-dhi` — security-hardened images from `dhi.io` bases.
  - Floating aliases mirror all of the above (`latest`, `alpine`, `trixie-slim`, `python3.13-alpine3.23`, …) plus `sha-<git-commit>` tags for commit-level pinning.
- Recommended exact tag for this Dockerfile's `COPY --from=ghcr.io/astral-sh/uv:${UV_IMAGE_TAG} /uv /uvx /bin/`: **`ghcr.io/astral-sh/uv:0.13.0`** — it matches the documented pattern (`COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /uvx /bin/`), and since the image is just the two static binaries, nothing from the base leaks into the final image. Sources: uv docs (Docker integration guide, via DeepWiki on `astral-sh/uv`), GHCR registry API.

Caveats:

- The uv/uvx binaries are **fully statically linked (musl targets)**, so they run unchanged in the Alpine/musl `node:*-alpine` final stage regardless of which variant is copied from; the distroless plain tag is fine (and smallest).
- The Debian variants moved from `bookworm` to **`trixie`** in current releases — `0.5.9`-era `-bookworm` tags still exist in the registry but new versions no longer publish them. Do not pin a bookworm tag.
- `-dhi` variants build from third-party hardened bases; not needed for binary extraction.

## 3. npm: `chrome-devtools-mcp@latest` → `chrome-devtools-mcp@1.10.1`

- Dist-tags: `{"latest": "1.10.1"}` — the **only** dist-tag; there is no `next`/`beta` channel. Sources: `https://registry.npmjs.org/-/package/chrome-devtools-mcp/dist-tags`, `npm view chrome-devtools-mcp`.
- `1.10.1` published 2026-09-23 (`npm view chrome-devtools-mcp time --json`; release cadence is roughly bi-weekly: 1.9.0 on 2026-09-08, 1.10.0 on 2026-09-23).
- Compatibility with the pinned Node: `engines.node` is `^20.19.0 || ^22.12.0 || >=23` — Node 24.21.0 satisfies it. The package has **zero runtime dependencies** and exposes the `chrome-devtools-mcp` bin. Source: `https://registry.npmjs.org/chrome-devtools-mcp/1.10.1`.
- Exact spelling: `npm install --global chrome-devtools-mcp@1.10.1`.

## 4. PyPI: `mcp-proxy` → `mcp-proxy==0.13.0`

- Latest version on PyPI: **0.13.0** (`https://pypi.org/pypi/mcp-proxy/json` → `info.version = 0.13.0`; files `mcp_proxy-0.13.0-py3-none-any.whl` + sdist, `requires_python = >=3.10`).
- Corroborated by upstream: GitHub release `v0.13.0` published 2026-10-10 (`gh api repos/sparfenyuk/mcp-proxy/releases`). Note the DeepWiki snapshot of `sparfenyuk/mcp-proxy` still says 0.12.0 — the live PyPI JSON API is the authority here.
- `uv tool install mcp-proxy` is the upstream-documented install path (README via DeepWiki), so the pinned spelling is a one-token change: `uv tool install mcp-proxy==0.13.0`.
- `requires_python >=3.10` is open-ended upward; the Dockerfile's `UV_PYTHON="3.15"` satisfies it.

## Pinning caveats (summary)

1. **Alpine granularity**: the exactness ceiling for the Node tag is `X.Y.Z-alpine<minor>` (e.g. `24.21.0-alpine3.24`); no Alpine-patch-level tags exist, and tag digests can move on base-image rebuilds.
2. **LTS flip on 2026-10-28**: `lts-alpine` will start tracking Node 26 then; the pinned 24 tag is unaffected, but "LTS" semantics at pin-refresh time will differ from today's.
3. **uv plain tag is distroless**: nothing but the two binaries — ideal for `COPY --from`; no variant matching to the final base is needed because the binaries are static musl builds. Don't pin legacy `-bookworm` variants (superseded by `-trixie`).
4. **Registry drift**: `latest`/`lts` aliases verified today (`uv:latest == 0.13.0`, `lts-alpine == 24.21.0-alpine3.24`) move without notice; that is the reason for the exact pins above.
5. All four pins are plain version strings, which keeps manual updates (the map rules out Renovate/Dependabot) to four one-line `ARG` edits.

## Sources

- Docker Hub tag API: `https://hub.docker.com/v2/repositories/library/node/tags?name=lts-alpine`, `...?name=alpine3.24`, `...?name=24.21.0-alpine`
- Node.js release schedule: `https://raw.githubusercontent.com/nodejs/release/main/schedule.json`; dist index: `https://nodejs.org/dist/index.json`
- GHCR OCI distribution API: token + `https://ghcr.io/v2/astral-sh/uv/tags/list` (paginated, 7,309 tags), `https://ghcr.io/v2/astral-sh/uv/manifests/{latest,0.13.0,...}`
- uv Docker docs / image definitions: `astral-sh/uv` via DeepWiki (Docker images and distribution guide)
- npm registry: `https://registry.npmjs.org/-/package/chrome-devtools-mcp/dist-tags`, `https://registry.npmjs.org/chrome-devtools-mcp/1.10.1`, `npm view chrome-devtools-mcp [--json] [time --json]`
- PyPI: `https://pypi.org/pypi/mcp-proxy/json`
- sparfenyuk/mcp-proxy releases: `gh api repos/sparfenyuk/mcp-proxy/releases`; README install guidance via DeepWiki
