# chrome-devtools-mcp-proxy

_Exposes [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) over HTTP via [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy), always driving an external Chrome through CDP._

## What this is

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is an MCP
server that automates Chrome — but it speaks stdio, so only a client in the same process
tree can reach it. MCP clients living elsewhere (another host, another container, a CI
runner) want HTTP. [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) bridges stdio and
HTTP; this image packages that bridge with working defaults.

The image is **transport glue, not a browser host**:

- **No Chrome inside.** It always connects to a Chrome you provide, over the Chrome
  DevTools Protocol (`--browser-url`). Bring your own browser; the proxy drives it.
- Inside the image: chrome-devtools-mcp (npm package) and mcp-proxy (uv tool), each pinned
  to an exact version that `docker inspect` can audit (see [Releases](#releases)).
- A POSIX entrypoint turns two environment variables into the final command — no rebuild
  needed to change either upstream's flags (see [Configuration](#configuration)).

## Quick start (sidecar)

Save this as a `compose.yaml`, then `docker compose up --detach`. The snippet lives here
only — the repository deliberately ships no example `compose.yaml`; its test fixtures are
the executable version.

```yaml
services:
  chrome:
    image: docker.io/chromedp/headless-shell:155.0.8059.40
    init: true # reap zombies (the Chrome image's own recommendation)
    shm_size: "1gb" # headless-shell crashes with BUS_ADRERR on the 64 MB default
    ports:
      # Declare ports on chrome — the network-namespace owner; Compose silently
      # ignores ports on a service that shares another service's namespace.
      - target: 19222 # the proxy's HTTP surface
        published: "19222"

  mcp:
    image: ghcr.io/andrielson/chrome-devtools-mcp-proxy:v0.2.0
    network_mode: "service:chrome" # shares chrome's network namespace
    # Zero configuration: the image defaults already point at http://localhost:9222.
```

Check that it is up, then connect:

```bash
curl --silent http://localhost:19222/status # health check — answers JSON
```

Point your MCP client at `http://localhost:19222/mcp` (Streamable HTTP; legacy clients use
`http://localhost:19222/sse`). CDP never leaves the shared loopback: port 9222 stays
unpublished, and Chrome's DevTools endpoint has no authentication.

Any Chrome that speaks CDP works in place of headless-shell — a regular Chrome started
with `--remote-debugging-port=9222`, another containerized Chrome, or the one already
running on your host (see [Host network](#host-network-simple-linux-only)).

## Connecting to Chrome

Three ways to place the proxy next to your Chrome, in order of preference.

### Sidecar (supported)

`network_mode: "service:chrome"` on the proxy plus the image's default
`--browser-url=http://localhost:9222`. The proxy shares Chrome's network namespace, so
Chrome sits on the proxy's loopback and satisfies Chrome's localhost rule by construction.
This is the topology the [quick start](#quick-start-sidecar) uses and the only one the
test suites exercise. Two details to remember:

- Every published port must be declared on the `chrome` service (the namespace's owner).
- Keep `9222` unpublished: CDP has no authentication.

### Host network (simple, Linux-only)

Chrome runs on the host with remote debugging on; the container joins the host network:

```bash
google-chrome --remote-debugging-port=9222 # on the host; Chrome 136+ also needs a non-default --user-data-dir
docker run --rm --network host ghcr.io/andrielson/chrome-devtools-mcp-proxy:v0.2.0
```

The image defaults (`localhost:9222`) already fit — nothing to override. The proxy then
listens on `0.0.0.0:19222` on the host. Docker's host networking is Linux-only.

### Separate containers (advanced, fragile)

Two services on a shared Docker network — the named-service topology, the instinctive
Compose shape — **cannot use the DNS name**. Chrome's DevTools handler rejects any request whose `Host` header is not an IP
literal or `localhost` (DNS-rebinding protection, Chrome 66+). It answers `HTTP 500` —
`Host header is specified and is not an IP address or localhost.` — and no Chrome flag
lifts the check (`--remote-allow-origins=*` included). So
`CHROME_DEVTOOLS_MCP_ARGS: "--browser-url=http://chrome:9222"` fails on the first browser
tool, with the error surfacing only in the tool response, never in `docker logs`.

The one working form is Chrome's container IP:

```yaml
environment:
  CHROME_DEVTOOLS_MCP_ARGS: "--browser-url=http://172.20.0.2:9222" # chrome's address on the shared network
```

… but a container IP is allocator state, not a contract: it holds for the life of one
`docker compose up` and typically survives a `down`/`up` cycle, yet anything else claiming
addresses on that network can shift it — and a stale IP fails every browser tool.
Re-resolve it on every `up` if you depend on this tier. Documented for completeness;
prefer the sidecar.

## Configuration

Two environment variables, both defined by the image with defaults, both overridable at
run time (`docker run --env` / Compose `environment:`):

| Variable                   | Default                               | Configures                                   |
| -------------------------- | ------------------------------------- | -------------------------------------------- |
| `MCP_PROXY_ARGS`           | `--host=0.0.0.0 --port=19222`         | mcp-proxy (transport and HTTP side)          |
| `CHROME_DEVTOOLS_MCP_ARGS` | `--browser-url=http://localhost:9222` | chrome-devtools-mcp (tools and browser side) |

The entrypoint assembles the final command from them:

```
mcp-proxy ${MCP_PROXY_ARGS} -- chrome-devtools-mcp ${CHROME_DEVTOOLS_MCP_ARGS}
```

Which flags each variable accepts is each upstream's own documentation (see
[Context sources](#context-sources)).

**Quoting rules.** Values are parsed with shell-like quoting, so values with spaces
survive as one argument:

- `'...'` is fully literal — JSON values need no escaping
- `"..."` honors `\"` and `\\`
- `\x` escapes any character outside quotes
- spaces, tabs and newlines separate words
- no substitution (`$VAR`, `$(...)`, backticks stay literal text) and no globbing (`*`
  and `?` stay literal)

A two-word flag therefore keeps its value as one word:

```yaml
environment:
  MCP_PROXY_ARGS: '--port=8080 --headers X-Api-Token "Bearer eyJhbGciOi…"'
```

Malformed input — an unterminated quote, or a raw newline inside quotes — makes the
container exit `64` with a message naming the variable.

**Secrets end up in `docker logs`.** The entrypoint logs the assembled command, argument
values in the clear, on every start. Anything you put in either variable (an `--headers`
token, say) will be readable in `docker logs` — decide knowingly.

## HTTP surface

One port (`19222` by default) serves everything:

| Endpoint  | Method | Purpose                                     |
| --------- | ------ | ------------------------------------------- |
| `/mcp`    | POST   | Streamable HTTP — point modern clients here |
| `/sse`    | GET    | Legacy HTTP+SSE — for older clients         |
| `/status` | GET    | Health check (JSON)                         |

**Sessions are stateful by default.** The `initialize` reply carries an `mcp-session-id`
header; every subsequent request in the session must echo it back (missing → `400`,
unknown → `404`). A minimal session with curl:

```bash
# 1) initialize — the response headers carry mcp-session-id
curl --silent --dump-header - http://localhost:19222/mcp \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

# 2) notifications/initialized — completes the handshake (answers 202)
curl --silent --output /dev/null http://localhost:19222/mcp \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'mcp-session-id: SESSION_ID' \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) list the tools
curl --silent http://localhost:19222/mcp \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'mcp-session-id: SESSION_ID' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4) end the session
curl --silent --request DELETE http://localhost:19222/mcp \
  --header 'mcp-session-id: SESSION_ID'
```

POSTs must send an `Accept` header that includes `application/json` — the spec-standard
`Accept: application/json, text/event-stream` used above always works. mcp-proxy also has
a `--stateless` mode (via `MCP_PROXY_ARGS`) that issues no session header and requires no
`initialize`.

## Testing

One command runs everything:

```bash
bun test
```

Three nested suites:

- **Unit** (`tests/unit/`) — the entrypoint's env-to-argv contract and the test helpers;
  no Docker, milliseconds.
- **Container** (`tests/container/`) — the built image's contract and wiring (ENTRYPOINT,
  ENV defaults, env overrides reaching the running process's argv, `/status` answering)
  through the Compose sidecar fixture in `tests/fixtures/`.
- **E2E smoke** (`tests/e2e/`) — one real MCP session through the whole chain
  (client → mcp-proxy → chrome-devtools-mcp → Chrome), tracing the performance of the real
  https://developers.chrome.com page.

No Docker on the machine? The container suite and the E2E smoke skip with a visible notice
instead of failing the run — and the E2E smoke skips just as visibly without outbound
internet. CI runs the same bare `bun test`.

## Development

### Prerequisites

- **Bun** (1.4+) — runs the scripts, the test suite and the git hooks.
- **ShellCheck** (0.10+) — shell linting (`lint:sh` and the pre-commit gate). Shell
  _formatting_ needs no host binary: it goes through Prettier and `prettier-plugin-sh`.
- **Docker** — only for the container suite and the E2E smoke (see [Testing](#testing));
  everything else stays green without it.

`bun install` also activates the git hooks (Husky): `pre-commit` runs the staged fixers,
then ShellCheck and the full type check; `post-checkout` and `post-merge` refresh
`node_modules`. Escape hatches: `git commit --no-verify` skips the hook once, `HUSKY=0`
disables Husky entirely. Hook mechanics live in [CLAUDE.md](CLAUDE.md).

### Commands

| Command                | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `bun install`          | Install dependencies (and activate the git hooks)                                 |
| `bun test`             | Run all tests (Docker-dependent suites skip visibly without Docker)               |
| `bun run lint`         | Biome check (TS family)                                                           |
| `bun run lint:fix`     | Biome check with auto-fix                                                         |
| `bun run lint:sh`      | ShellCheck over the tracked shell scripts                                         |
| `bun run lint:compose` | Validate the fixture Compose file (`docker compose config --quiet` — client-side) |
| `bun run format`       | Prettier write (markdown, YAML, shell, Dockerfile)                                |
| `bun run format:check` | Prettier check, no changes applied                                                |
| `bun run typecheck`    | `tsc --noEmit`                                                                    |
| `bun build <entry>`    | Bundle an entry (`.ts`, `.html`, `.css`)                                          |

Formatting ownership is split and strict — Biome owns the TS family, Prettier owns
markdown/YAML/shell/Dockerfile, and they never touch the same file. CI runs these same
gates on pull requests; the test suite joins for non-draft PRs whose diff touches code or
configuration.

## Releases

Nobody bumps versions by hand. Conventional commits drive
[semantic-release](https://github.com/semantic-release/semantic-release): merging to
`main` decides the next version, publishes `ghcr.io/andrielson/chrome-devtools-mcp-proxy`
as `vX.Y.Z` and `latest` on GHCR, pushes the git tag `vX.Y.Z`, and opens the GitHub
release (release notes live there — there is no CHANGELOG file). PR titles are
commitlint-checked in CI, because squash merges make the title the commit that
semantic-release reads.

The git tag is the **publication record**: it lands only after the image push succeeded,
so a tag's presence means that version was published.

Pinned upstream versions (the base images, chrome-devtools-mcp, mcp-proxy, Python) live in
the Dockerfile `ARG`s and surface as OCI labels — `docker inspect` on any published tag
audits exactly what it contains. There is deliberately **no versions table** in this
README: a table would drift; the labels cannot.

One-time setup note for forks: the first push creates the GHCR package as private — flip
it to public once (package page → Settings → Danger Zone → Change visibility) if anonymous
pulls should work.

## Context sources

- **Using the image** — the two upstreams:
  [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) (the transports and
  every flag behind `MCP_PROXY_ARGS`) and
  [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  (the tools and every flag behind `CHROME_DEVTOOLS_MCP_ARGS`).
- **Contributing** — [CONTEXT.md](CONTEXT.md) (the living glossary),
  [docs/adr/](docs/adr/) (decisions of record) and [docs/research/](docs/research/) (the
  verified findings behind them).
- **Coding agents** — start at [CLAUDE.md](CLAUDE.md) and [docs/agents/](docs/agents/);
  questions about either upstream go through the `deepwiki` MCP (workflow in
  `.claude/skills/deepwiki/`).
