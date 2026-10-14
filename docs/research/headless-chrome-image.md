# Research: lightest headless-Chrome image exposing CDP for the test fixture

- **Ticket:** [#3](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/3)
- **Date:** 2026-10-14
- **Method:** live registry APIs (Docker Hub, GHCR), project READMEs/docs at
  their primary sources, and hands-on Docker verification on the research
  machine (Docker 29.9.0, Compose 5.6.0). Nothing below is from memory alone;
  every number was fetched or measured today.

## Recommendation

**`docker.io/chromedp/headless-shell:<exact-version>`** — for this repo
specifically `chromedp/headless-shell:155.0.8059.40`, which is the same Chrome
train (155.0.8059) as the prototype's `lscr.io/linuxserver/chrome:155.0.8059`
but **7.5x smaller compressed (157 MB vs 1.19 GB; 534 MB vs 4.68 GB
uncompressed)**, headless by design, built and pushed daily with one tag per
exact Chrome version.

It was verified live, end to end, in the exact sidecar pattern this repo uses:
`/json/version` answers `200` on `http://localhost:9222` from a container
sharing Chrome's network namespace, and a full MCP session through the repo's
own image (`mcp-proxy` → `chrome-devtools-mcp --browser-url` → puppeteer →
CDP) drove the browser: `new_page`, `evaluate_script` and `take_screenshot`
all succeeded. See [Live verification](#live-verification-2026-10-14).

Google publishes **no official Docker image** for Chrome for Testing (the
[Chrome for Testing site](https://googlechromelabs.github.io/chrome-for-testing/)
ships only `chrome`, `chromedriver` and `chrome-headless-shell` zips), so
`chromedp/headless-shell` — the `chromedp` project's containerization of
Chrome's headless shell — is the de-facto standard container for this binary.
A self-built image from the first-party CfT zip is a viable fallback and is
sketched below.

## What the proxy actually needs

The repo's image (`src/Dockerfile`) runs
`chrome-devtools-mcp --browser-url=http://localhost:9222` behind `mcp-proxy`.
Per [chrome-devtools-mcp's configuration docs][mcp-config], `--browser-url`
"connect[s] to a running, debuggable Chrome instance (e.g.
`http://127.0.0.1:9222`)"; internally it calls `puppeteer.connect({browserURL})`,
which fetches `<url>/json/version` and then opens the WebSocket at the returned
`webSocketDebuggerUrl`. Headless or headed makes no difference to it.

Two consequences for the fixture:

1. **`/json/version` over plain HTTP on 9222 is the contract.** Anything that
   serves it and accepts the CDP WebSocket qualifies.
2. **The sidecar pattern tolerates loopback-only bindings.** With
   `network_mode: "service:chrome"`, the `mcp` container shares Chrome's
   network namespace, so `http://localhost:9222` works even when Chrome binds
   `127.0.0.1` only — no published ports, no `--remote-debugging-address`
   gymnastics. It also keeps the unauthenticated CDP port off the host.

[mcp-config]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md

## Candidates

| Image                                             | Compressed                              | Uncompressed   | Headless-first                                         | CDP on 9222 from sidecar                                                           | Pin-ability                                           | Maintenance                                                                 | License                      | Verdict                        |
| ------------------------------------------------- | --------------------------------------- | -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| `docker.io/chromedp/headless-shell:155.0.8059.40` | 157 MB                                  | 534 MB         | Yes (is the headless shell)                            | **Verified: 200**                                                                  | Exact Chrome version tags, daily builds               | Active (pushed 2026-10-13)                                                  | MIT (repo)                   | **Recommended**                |
| `lscr.io/linuxserver/chrome:155.0.8059`           | 1.19 GB                                 | 4.68 GB        | No — GUI streaming desktop                             | Not exposed by default (`CHROME_CLI` flags needed); **never came up in live test** | Chrome-train tags (`155.0.8059`, `…79-1`)             | Very active (daily)                                                         | GPL-3.0 (repo)               | Reject                         |
| `zenika/alpine-chrome:124`                        | 281 MB                                  | ~633 MB (docs) | Yes (`chromium --headless`)                            | Yes, via `CHROMIUM_FLAGS`                                                          | Major-version tags only; newest is **124** (Apr 2024) | Effectively unmaintained; repo moved to `jlandure/alpine-chrome`            | Apache-2.0                   | Reject (stale Chromium)        |
| `ghcr.io/browserless/chromium:v2.38.1`            | 1.17 GB                                 | —              | It is a session-managing middleware, not a raw browser | On **3000**, not 9222; `/json/version` served with rewritten WS URL                | Semver tags (`v2.x.y`)                                | Active                                                                      | Custom (GitHub: NOASSERTION) | Reject (heavy, product-shaped) |
| `ghcr.io/cirrus-ci/chrome`                        | —                                       | —              | —                                                      | —                                                                                  | —                                                     | **Manifest 404**; Cirrus Labs wound down (image updates stopped 2026-05-01) | —                            | Reject (unavailable)           |
| CfT `chrome-headless-shell` (self-built)          | ~230 MB est. (127 MB zip + Debian slim) | —              | Yes                                                    | DIY                                                                                | Fully controlled                                      | You own it                                                                  | CfT binaries + your base     | Viable fallback                |

Sizes are registry-reported compressed layer totals (Docker Hub `full_size`;
GHCR manifest layer sums), fetched 2026-10-14. Uncompressed sizes from
`docker images` on the research machine.

## Detailed findings

### `chromedp/headless-shell` — recommended

Sources: [repo](https://github.com/chromedp/docker-headless-shell) (MIT,
pushed 2026-10-04), its
[`Containerfile`](https://github.com/chromedp/docker-headless-shell/blob/main/Containerfile)
and [`run.sh`](https://github.com/chromedp/docker-headless-shell/blob/main/run.sh),
[Docker Hub](https://hub.docker.com/r/chromedp/headless-shell) (8.2M pulls,
last updated 2026-10-13).

- **What it is:** Chrome's `headless-shell` — the slimmed-down, headless-only
  Chrome build (the same binary family as Chrome for Testing's
  `chrome-headless-shell`) — on `debian:trixie-slim`, plus `socat`. Built
  nightly from the Chromium source tree by the `chromedp` project (the
  long-standing Go CDP library), reporting Chrome's user agent; images for
  `stable`, `beta` and `dev` channels are pushed **daily**, multi-arch
  (amd64 + arm64).
- **How 9222 works:** `run.sh` starts `headless-shell --no-sandbox
--use-gl=angle --use-angle=swiftshader --remote-debugging-port=9223` (bound
  to loopback — headless Chrome does not honor `--remote-debugging-address`)
  and forwards `0.0.0.0:9222 → 127.0.0.1:9223` with socat. Extra CLI args are
  appended to the shell. Zero configuration is needed for CDP on 9222.
- **Pin-ability:** every build gets an exact-version tag
  (`155.0.8059.40`, `156.0.8078.12`, …) alongside floating
  `latest`/`stable`/`beta`/`dev`; digest pinning works as usual.
- **`shm_size`:** the README documents the failure mode ("crashing with a
  `BUS_ADRERR` error, pass a larger shm-size"). The light fixture passed even
  with Docker's default 64 MB `/dev/shm`, but `shm_size: "1gb"` is cheap
  insurance for real pages.
- **Caveats:** runs as root with `--no-sandbox` (fine inside a throwaway CI
  network namespace; harden with a seccomp profile if policy requires);
  zombie reaping needs `init: true` (README's own recommendation); the binary
  is a third-party nightly Chromium build, not a Google artifact — if that
  matters, use the self-built CfT fallback below. CDP has no authentication:
  keep 9222 unpublished and use `http://localhost:9222` (Chrome's DNS-rebinding
  protection rejects non-localhost `Host` headers anyway).
- **Headless-shell scope:** it is headless-only and ships no desktop-stack
  features (extensions, Chrome UI). All CDP page domains the MCP server needs
  are present — `tools/list` returned 30 tools and the page-driving ones were
  exercised live (see below).

### `lscr.io/linuxserver/chrome` — reject (the prototype's image)

Sources: [LinuxServer docs](https://docs.linuxserver.io/images/docker-chrome/),
[Docker Hub](https://hub.docker.com/r/linuxserver/chrome), live run of
`155.0.8059`.

- **1.19 GB compressed / 4.68 GB uncompressed** — it is a full Debian Trixie
  desktop (s6-overlay, Xorg, Wayland, nginx, PulseAudio, dbus) streamed to
  the browser via **Selkies** on ports 3000/3001. The docs' own warning: the
  web UI "includes a terminal with passwordless sudo", i.e. privileged host
  access — not something to run as a CI sidecar.
- **No headless mode is documented.** The docs describe `CHROME_CLI` ("this
  string will be passed to the application in full") and only the two GUI
  ports; `--remote-debugging-port` via `CHROME_CLI` is the user's own trick,
  not a supported path.
- **Live check (2026-10-14):** two containers were run with
  `--shm-size 4gb` and the prototype's env — one headed (exact prototype
  `CHROME_CLI`), one with `--headless=new` prepended. In both, the desktop
  stack came up (`Selkies 2.0.0 server running`, Xorg, nginx, …) but **no
  `chrome` process ever appeared and `http://localhost:9222/json/version`
  never answered** during ~6 minutes of polling per variant — the browser
  app is launched with the streamed desktop session, not the container. So
  headless-via-`CHROME_CLI` could not be made to work here at all, and even
  the headed mode only pays off when someone watches the stream. Either way
  the size verdict alone disqualifies it for a test fixture.
- License: GPL-3.0 (repo `linuxserver/docker-chrome`); tags are
  Chrome-train-pinnable (`155.0.8059`, `155.0.8059.79-1`), updated daily.

### `zenika/alpine-chrome` — reject (stale)

Sources: [README](https://github.com/jlandure/alpine-chrome) (repo transferred
out of Zenika to the original author), [Docker Hub](https://hub.docker.com/r/zenika/alpine-chrome).

- Small (~281 MB compressed) and genuinely headless-first
  (`chromium-browser --headless`, `CHROMIUM_FLAGS` env var), but it ships
  **Chromium, not Chrome**, and the newest version tag on Docker Hub is
  **124** — April 2024, ~30 major versions behind the Chrome 155 train the
  rest of this repo uses; no full-version tags exist, only majors.
- The README carries a maintenance warning: the creator no longer has support
  to maintain the image, and registry images/tags "may be deleted or
  obsolete". Repo last pushed 2025-11-15; Hub `latest` was re-pushed
  2026-09-03 but still on Chromium 124.
- Security model requires opt-in (`--no-sandbox`, `--cap-add=SYS_ADMIN`, or a
  seccomp profile); no `shm_size` guidance in the README. Apache-2.0.

### `browserless` — reject (heavy, product-shaped)

Sources: [ghcr.io/browserless/chromium](https://github.com/browserless/browserless/pkgs/container/chromium)
(v2.38.1 current), manifest layer sum = **1.17 GB** compressed (amd64),
[docs via DeepWiki][bl-wiki].

- Modern browserless is a **session-managing server** (queueing, concurrency
  limits, tokens, bundled Playwright/Puppeteer versions) listening on **port
  3000**. It does expose `/json/version`, `/json/list`, `/json/new` for
  compatibility — with `webSocketDebuggerUrl` recomputed to the external
  address — so `--browser-url=http://localhost:3000` could be made to work,
  but every connection then goes through its middleware, which is precisely
  what this repo's proxy does not need.
- The old `browserless/chrome` Docker Hub image is frozen (last push
  2024-02-16) — anyone pinning `browserless/chrome` today is two years stale.
- License: GitHub reports NOASSERTION (custom), vs MIT/Apache elsewhere.

[bl-wiki]: https://deepwiki.com/browserless/browserless

### `ghcr.io/cirrus-ci/chrome` — reject (unavailable)

- Manifest request returns **404** on `ghcr.io/cirrus-ci/chrome` (2026-10-14);
  `cirrusci/*` and `cirruslabs/chrome` are equally absent, and Docker Hub's
  `cirrusci` org lists no Chrome repo.
- Context: Cirrus Labs [wound down operations after an
  acquisition](https://github.com/cirruslabs/docker-images-flutter) and its
  image repos stopped updating 2026-05-01. Not a foundation for a fixture
  that must be pinnable.

## Live verification (2026-10-14)

All of the following ran on the research machine against
`docker.io/chromedp/headless-shell:155.0.8059.40`.

1. **Raw container:**
   `docker run -d --shm-size 1gb --init chromedp/headless-shell:155.0.8059.40`
   → logs show `DevTools listening on ws://127.0.0.1:9223/…` and
   `socat TCP4-LISTEN:9222,fork TCP4:127.0.0.1:9223`.
2. **Sidecar probe** (a `node:22-alpine` container with
   `--network container:<chrome>`, i.e. Compose's
   `network_mode: "service:chrome"`): `GET http://localhost:9222/json/version`
   → `200`, `"Browser": "Chrome/155.0.8059.40"`,
   `webSocketDebuggerUrl: ws://localhost:9222/devtools/browser/…`; a CDP
   WebSocket session answered `Browser.getVersion`
   (`protocolVersion 1.3`).
3. **Compose sidecar fixture** (same YAML shape as the recommendation below):
   `Target.createTarget` + `Page.navigate` (data URL) +
   `Runtime.evaluate` → returned the page title — and
   `Page.captureScreenshot` returned a 13 KB PNG. Also passed with the
   default 64 MB `/dev/shm`.
4. **Full repo stack:** built `src/Dockerfile` locally, then brought up the
   three-service fixture (chrome + `cdp-wait` readiness gate + `mcp`
   sidecar). `cdp-wait` exited successfully (so `/json/version` was up) and
   only then did Compose start `mcp`. Against the published 19222, an MCP
   client over mcp-proxy's SSE transport completed: `initialize` →
   `chrome_devtools 1.10.1`, `tools/list` → 30 tools, `new_page` → page
   created, `evaluate_script` → `"mcp-e2e | via chrome-devtools-mcp"`,
   `take_screenshot` → 20,664 base64 chars of PNG.
5. **`lscr.io/linuxserver/chrome:155.0.8059`:** pulled (4.68 GB) and run twice
   (prototype env and `--headless=new` variant) — desktop stack up, but no
   `chrome` process appeared and `:9222` never answered in either variant
   (~6 min each). See the candidate section for interpretation.

## Recommended fixture sketch

```yaml
services:
  chrome:
    image: docker.io/chromedp/headless-shell:155.0.8059.40
    init: true # reap zombies (image README recommendation)
    shm_size: "1gb" # avoids BUS_ADRERR on heavy pages
    # Ports must be declared here, on the network-namespace owner: the mcp
    # sidecar shares this netns, so publishing 19222 exposes the proxy.
    ports:
      - target: 19222
        published: "19222"
        protocol: tcp
      # Optional, local debugging only — CDP has no authentication:
      # - target: 9222
      #   published: "9222"
      #   protocol: tcp
    # Optional profile persistence across `compose down`, long syntax per
    # repo convention:
    # volumes:
    #   - type: volume
    #     source: chrome-user-data
    #     target: /tmp

  cdp-wait:
    image: docker.io/curlimages/curl:8.10.1
    network_mode: "service:chrome"
    entrypoint: ["/bin/sh", "-c"]
    command:
      - "until curl --fail --silent http://localhost:9222/json/version >/dev/null; do sleep 1; done"
    depends_on:
      - chrome

  mcp:
    build:
      context: .
      dockerfile: src/Dockerfile
    network_mode: "service:chrome"
    depends_on:
      chrome:
        condition: service_started
      cdp-wait:
        condition: service_completed_successfully
```

Notes:

- **`ports` belongs on `chrome`.** Compose silently discards ports declared on
  a service that uses `network_mode: "service:…"`. Since the `mcp` container
  shares Chrome's netns, publishing the proxy's 19222 on `chrome` exposes it
  on the host as `http://localhost:19222`.
- **Keep 9222 unpublished in CI.** The CDP endpoint is unauthenticated;
  the sidecar reaches it over the shared loopback. Publish it only when
  debugging locally.
- **Readiness:** `cdp-wait` is a one-shot gate that makes `depends_on`'s
  `service_completed_successfully` deterministic; this exact gate ran in the
  live verification. Alternatively poll `/json/version` from the Bun test
  bootstrap and skip the extra service.
- **Pinning:** prefer the exact-version tag (`155.0.8059.40`) over
  `stable`/`latest` (they float daily). Add a digest for full reproducibility:
  `image: docker.io/chromedp/headless-shell:155.0.8059.40@sha256:0dc9356ce…`.
- **Use `http://localhost:9222`** as the browser URL, matching the existing
  `src/Dockerfile` — Chrome's DNS-rebinding protection rejects requests whose
  `Host` header is not `localhost`/an IP.

### Fallback: self-built Chrome for Testing image

If a first-party Google binary is preferred over the chromedp nightly build,
Google ships `chrome-headless-shell` as a zip only — e.g.
`https://storage.googleapis.com/chrome-for-testing-public/157.0.8102.0/linux64/chrome-headless-shell-linux64.zip`
(127 MB, latest known-good at research time; the
[known-good-versions JSON](https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json)
is the machine-readable index). A `debian:slim` (or Alpine) image that
unzips it and runs the same flags lands around ~230 MB compressed — same
operating model as the recommendation, at the cost of owning the build and
pinning pipeline. It was not needed for this repo's conclusion.

## Sources

- chromedp/headless-shell: [repo](https://github.com/chromedp/docker-headless-shell),
  [Containerfile](https://github.com/chromedp/docker-headless-shell/blob/main/Containerfile),
  [run.sh](https://github.com/chromedp/docker-headless-shell/blob/main/run.sh),
  [README](https://github.com/chromedp/docker-headless-shell/blob/main/README.md),
  [Docker Hub tags](https://hub.docker.com/r/chromedp/headless-shell/tags)
- LinuxServer Chrome: [docs](https://docs.linuxserver.io/images/docker-chrome/),
  [repo (GPL-3.0)](https://github.com/linuxserver/docker-chrome),
  [Docker Hub tags](https://hub.docker.com/r/linuxserver/chrome/tags)
- zenika/alpine-chrome: [README (jlandure/alpine-chrome)](https://github.com/jlandure/alpine-chrome),
  [Docker Hub tags](https://hub.docker.com/r/zenika/alpine-chrome/tags)
- browserless: [browserless repo](https://github.com/browserless/browserless),
  [ghcr package](https://github.com/browserless/browserless/pkgs/container/chromium),
  [Docker Hub (stale v1)](https://hub.docker.com/r/browserless/chrome),
  [DeepWiki summary](https://deepwiki.com/browserless/browserless)
- Chrome for Testing: [site](https://googlechromelabs.github.io/chrome-for-testing/),
  [known-good-versions-with-downloads.json](https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json)
- chrome-devtools-mcp: [configuration docs](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md),
  [DeepWiki summary](https://deepwiki.com/ChromeDevTools/chrome-devtools-mcp)
- Cirrus Labs wind-down: [cirruslabs/docker-images-flutter](https://github.com/cirruslabs/docker-images-flutter)
