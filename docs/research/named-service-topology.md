# Research: does the named-service Docker topology work? (Chrome DNS-rebinding protection vs `--browser-url=http://chrome:9222`)

- **Ticket:** [#11](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/11) (input to [#9](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/9))
- **Date:** 2026-10-14
- **Method:** live two-container Compose verification on this machine (Docker Engine
  29.9.0, Compose 5.6.0) plus upstream source research (Chromium source, Chrome docs,
  chromedp/headless-shell, chrome-devtools-mcp, Puppeteer). Every live claim below was
  measured today; every upstream claim carries a link.

## Verdict (TL;DR)

**No — the named-service form `--browser-url=http://chrome:9222` does not work against
this image, and it cannot be fixed from the client side by any flag.** Chrome's DevTools
handler (`RequestIsSafeToServe` in `content/browser/devtools/devtools_http_handler.cc`,
shipping since Chrome 66, 2018 — DNS-rebinding protection) rejects every request whose
`Host` header is not an IP literal or `localhost`, with `HTTP 500` and the body
`Host header is specified and is not an IP address or localhost.`
The check is purely lexical on the `Host` header — the TCP connection from another
container succeeds (socat accepts it), DNS resolution succeeds, and only the HTTP layer
rejects. The same check also guards the WebSocket upgrade endpoint (on this Chrome 155
image; verified live).

**What does work: the container's IP.** `--browser-url=http://172.20.0.2:9222` (the
chrome container's address on the shared network) passed a full MCP session end to end:
`initialize` → `tools/list` (30 tools) → `new_page` → `evaluate_script` → `42`. Chrome's
`webSocketDebuggerUrl` echoes the requesting `Host` verbatim, so an IP-based
`/json/version` fetch yields a `ws://<same-ip>:9222/...` URL that connects cleanly — no
rewriting needed. But a container IP is allocator state, not a contract: it is stable
within one `compose up` and was re-issued identically across `compose down`/`up` here,
yet moved to a different address as soon as another container occupied the old one.

Consequence for the README (#9): document the **sidecar pattern
(`network_mode: "service:chrome"` + `--browser-url=http://localhost:9222`) as the one
supported way to run the two containers** — it satisfies Chrome's rule by construction —
and state explicitly that the DNS-name form cannot work and that no Chrome flag lifts
the check. If separate containers on a shared network are described at all, the only
working `--browser-url` is chrome's container IP, re-resolved on every `up` (advanced,
fragile — see [What #9 should say](#what-9-should-say-readme-topology-section)).

## Live verification (2026-10-14)

Fixture: a throwaway Compose project `cdp-named-service-probe` with two services on
Compose's default user-defined bridge network (`cdp-named-service-probe_default`) —
`chrome` (`docker.io/chromedp/headless-shell:155.0.8059.40`) and `mcp` (the repo's own
image, built from `src/Dockerfile` at `d0b7588` and tagged `cdp-mcp-probe:local`).
**Nothing was published to the host**; every probe ran from a container on the shared
network (`docker.io/curlimages/curl:8.10.1`, `node:lts-alpine` for the WebSocket probe).
Because `src/Dockerfile` on `main` hardcodes `--browser-url=http://localhost:9222` in
`ENTRYPOINT`, the `mcp` service overrode `entrypoint:` with the identical command shape
and only the browser URL varied (via `${BROWSER_URL}`):

```yaml
services:
  chrome:
    image: docker.io/chromedp/headless-shell:155.0.8059.40
    init: true # reap zombies (image README recommendation)
    shm_size: "1gb" # avoids BUS_ADRERR on heavy pages

  mcp:
    image: cdp-mcp-probe:local
    entrypoint:
      [
        "mcp-proxy",
        "--host=0.0.0.0",
        "--port=19222",
        "--",
        "chrome-devtools-mcp",
        "--browser-url=${BROWSER_URL:-http://chrome:9222}",
      ]
    depends_on:
      - chrome
```

Chrome container log on start (note: the current image's `run.sh` passes
`--remote-debugging-address=0.0.0.0`, yet DevTools still reports a loopback listener;
socat still forwards `0.0.0.0:9222 → 127.0.0.1:9223` — the reachability conclusion below
is unaffected because the Host check lives in the HTTP handler behind either port):

```
+ exec /headless-shell/headless-shell --no-sandbox --use-gl=angle --use-angle=swiftshader --remote-debugging-address=0.0.0.0 --remote-debugging-port=9223
+ exec socat TCP4-LISTEN:9222,fork TCP4:127.0.0.1:9223

DevTools listening on ws://127.0.0.1:9223/devtools/browser/7c1a2850-c0b0-4a71-abcf-dac9eca67fae
```

Docker's embedded DNS resolves service names from every container on the network,
including the `mcp` container itself:

```
$ docker run --rm --network cdp-named-service-probe_default docker.io/curlimages/curl:8.10.1 getent hosts chrome
172.20.0.2        chrome  chrome
$ docker exec cdp-named-service-probe-mcp-1 getent hosts chrome
172.20.0.2        chrome  chrome
```

### Case 1 — DNS hostname: rejected (the baseline)

```
$ docker run --rm --network cdp-named-service-probe_default docker.io/curlimages/curl:8.10.1 \
    curl --silent --show-error --write-out '\nHTTP_STATUS=%{http_code}\n' http://chrome:9222/json/version
Host header is specified and is not an IP address or localhost.
HTTP_STATUS=500
```

**Hypothesis confirmed exactly**: HTTP 500 with
`Host header is specified and is not an IP address or localhost.`

The rejection is purely lexical on the `Host` header — proven by hitting the **same IP**
with forged `Host` headers (curl `-H 'Host: …'` against `http://172.20.0.2:9222`):

| `Host` header    | Result                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- |
| `chrome:9222`    | `HTTP/1.1 500` + `Host header is specified and is not an IP address or localhost.` |
| `chrome`         | `HTTP/1.1 500` + same body                                                         |
| `foo.example`    | `HTTP/1.1 500` + same body                                                         |
| `localhost`      | `HTTP/1.1 200 OK` + JSON                                                           |
| `localhost:9222` | `HTTP/1.1 200 OK` + JSON                                                           |
| `127.0.0.1:9222` | `HTTP/1.1 200 OK` + JSON                                                           |
| `172.20.0.2`     | `HTTP/1.1 200 OK` + JSON                                                           |

So the check accepts `localhost` (with or without port) and IP literals (with or without
port) and rejects every other name — regardless of which container the request comes
from (`Host: localhost` from a _remote_ container is accepted; the check is not
source-address based).

### Case 2 — container IP: 200, and `webSocketDebuggerUrl` echoes the Host

```
$ docker run --rm --network cdp-named-service-probe_default docker.io/curlimages/curl:8.10.1 \
    curl --silent --show-error --write-out '\nHTTP_STATUS=%{http_code}\n' http://172.20.0.2:9222/json/version
{
   "Browser": "Chrome/155.0.8059.40",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.40 Safari/537.36",
   "V8-Version": "15.5.35.20",
   "WebKit-Version": "537.36. (@cfaadc5a132d78e1828635aa8405a499f3e14864)",
   "webSocketDebuggerUrl": "ws://172.20.0.2:9222/devtools/browser/7c1a2850-c0b0-4a71-abcf-dac9eca67fae"
}

HTTP_STATUS=200
```

`/json/list` also answered `200` with `[]`.

The echo behavior is **verbatim, including the port** — and when the `Host` header lacks
a port, the echoed URL lacks it too:

```
$ curl --silent -H 'Host: localhost' http://172.20.0.2:9222/json/version | grep webSocket
"webSocketDebuggerUrl": "ws://localhost/devtools/browser/7c1a2850-…"
$ curl --silent -H 'Host: 127.0.0.1' http://172.20.0.2:9222/json/version | grep webSocket
"webSocketDebuggerUrl": "ws://127.0.0.1/devtools/browser/7c1a2850-…"
```

Two consequences:

1. **IP-based connects work end to end with zero rewriting** — puppeteer fetches
   `/json/version` via the IP, gets `ws://<same-ip>:9222/...` back, and that WebSocket's
   `Host` is an IP literal, which passes the same check (proven directly below).
2. **A proxy that rewrites only the `Host` header poisons the WS URL**: rewriting
   `Host: chrome → localhost` makes Chrome return `ws://localhost/...`, which from the
   client container points at itself, not at Chrome. A Host-rewriting proxy must
   therefore also rewrite response bodies (see
   [workaround assessment](#workaround-assessment)).

### Case 3 — full stack via hostname: MCP layer fine, browser connect fails

`mcp` started with `--browser-url=http://chrome:9222`. mcp-proxy itself comes up
normally:

```
[I … mcp_proxy.__main__] Configured default server: chrome-devtools-mcp --browser-url=http://chrome:9222
[I … mcp.server.streamable_http_manager] StreamableHTTP session manager started
INFO:     Uvicorn running on http://0.0.0.0:19222 (Press CTRL+C to quit)
```

chrome-devtools-mcp connects lazily: the container starts healthy (its startup banner
does reach `docker logs`, but the later connect failure is never logged), so the failure
surfaces only on the first browser tool. Driving a session over mcp-proxy's Streamable
HTTP endpoint (`POST /mcp`, shapes from the issue #4 research):

- `initialize` → `200`, `serverInfo` `{"name":"chrome_devtools","version":"1.10.1"}`
- `notifications/initialized` → `202`
- `tools/list` → `200`, 30 tools (click, evaluate_script, new_page, …)
- `tools/call new_page` → **`isError: true`**:

```
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Could not connect to Chrome. Check if Chrome is running.\nCause: Failed to fetch browser webSocket URL from http://chrome:9222/json/version: HTTP Internal Server Error"}],"isError":true}}
```

That is Chrome's Host-header rejection (the 500 from case 1) propagating through
Puppeteer (`Failed to fetch browser webSocket URL from …: HTTP Internal Server Error`)
into the MCP tool response. **Operational note for #9:** `docker logs` on the `mcp`
container does _not_ show this error — the tool response is the only surface; a smoke
test must assert on the tool result, not on logs.

### Case 4 — full stack via container IP: works end to end

Same stack, `--browser-url=http://172.20.0.2:9222`:

```
[I … mcp_proxy.__main__] Configured default server: chrome-devtools-mcp --browser-url=http://172.20.0.2:9222
```

Full session from a curl container on the network:

````
=== initialize ===            → HTTP/1.1 200 OK … "chrome_devtools","version":"1.10.1"
=== notifications/initialized === → HTTP/1.1 202 Accepted
=== tools/list ===            → 30 tool names, incl. new_page, evaluate_script
=== tools/call new_page (about:blank) ===
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"## Pages\n1: about:blank [selected]"}],"isError":false}}
=== tools/call evaluate_script (() => 6 * 7) on pageId 1 ===
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Script ran on page and returned:\n```json\n42\n```"}],"isError":false}}
````

**The documented workaround is proven**: same two containers, same network, only the
container IP instead of the DNS name, and the whole chain
(mcp-proxy → chrome-devtools-mcp → puppeteer → CDP HTTP + WebSocket) works.

### Case 5 — `--remote-allow-origins=*` does NOT lift the Host check

The image's `run.sh` appends extra CLI args to headless-shell, so this was cheap to
test (Compose override adding `command: ["--remote-allow-origins=*"]`):

```
+ exec /headless-shell/headless-shell --no-sandbox --use-gl=angle --use-angle=swiftshader --remote-debugging-address=0.0.0.0 --remote-debugging-port=9223 '--remote-allow-origins=*'
```

Hostname probe again:

```
$ curl --silent --include http://chrome:9222/json/version
HTTP/1.1 500 Internal Server Error
Content-Length:63
Content-Type:text/html

Host header is specified and is not an IP address or localhost.
```

**Hypothesis confirmed**: `--remote-allow-origins=*` gates WebSocket `Origin` checks
(and its own removal), not the Host-header DNS-rebinding check. No Chrome flag lifts
the Host check.

### Case 6 — the WebSocket endpoint enforces the same check

Raw handshake probe (node built-ins, no deps) against
`ws://172.20.0.2:9222/devtools/browser/<uuid>` with two different `Host` headers:

```
/json/version with Host 172.20.0.2:9222 -> 200
webSocketDebuggerUrl: ws://172.20.0.2:9222/devtools/browser/e82ef096-256a-48a0-a6d9-6d35210ab9b3
WS upgrade with Host: 172.20.0.2:9222 -> HTTP 101 [UPGRADE]
WS upgrade with Host: chrome:9222     -> HTTP 500 Host header is specified and is not an IP address or localhost.
```

So even a client that hand-fed puppeteer a rewritten `/json/version` body pointing at
`ws://chrome:9222/...` would still be rejected at the upgrade. A reverse proxy must
rewrite `Host` on **both** the HTTP fetch and the WebSocket upgrade — see workaround
assessment.

### Case 7 — operational facts for the README (IP stability)

- **Docker's embedded DNS resolves service names** (`chrome`, `mcp`) from every
  container on the network, including the `mcp` container (shown above). The failure in
  case 3 is _not_ a DNS failure.
- **Within one `compose up`**: container IPs never move; the IP form is stable for the
  life of the stack. When Chrome restarted _at the same address_, chrome-devtools-mcp
  even reconnected transparently:
  `"Note: the browser was restarted or reconnected since the last call. Page ids have changed."`
- **Across `compose down` + `up`**: Docker's IPAM re-issued the _same_ addresses here
  (`chrome` 172.20.0.2, `mcp` 172.20.0.3) — single project, deterministic start order,
  lowest-free-IP allocation. This is typical but **not contractual**.
- **IP reallocation is real**: after stopping `chrome` and letting another container
  pin `--ip 172.20.0.2`, a recreated `chrome` came back as `172.20.0.4` (name still
  resolving correctly), and the stale-IP `mcp` failed immediately:

```
$ getent hosts chrome mcp
172.20.0.4        chrome  chrome
172.20.0.3        mcp     mcp
$ tools/call new_page →
{"…","text":"Could not connect to Chrome. Check if Chrome is running.\nCause: Failed to fetch browser webSocket URL from http://172.20.0.2:9222/json/version: fetch failed","isError":true}
```

So: the IP form is correct _mechanically_ but is allocator state; anything that changes
address assignment (another container on the network, a different subnet pool, CI
runners sharing the daemon) silently breaks it. The DNS name is the stable handle —
which is exactly the one thing Chrome's Host check forbids.

### Cleanup

Every resource created for this research was torn down and verified absent afterwards
(`docker compose … down --volumes --remove-orphans`, explicit `network rm`/`rm` checks,
probe image `cdp-mcp-probe:local` removed, scratch directory deleted): no containers,
networks, volumes or built images from this session remain.

## Upstream research

### The Chromium rule: `RequestIsSafeToServe`

The check lives in
[`content/browser/devtools/devtools_http_handler.cc`](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_http_handler.cc)
(current `main`; also present verbatim in the
[image's exact tag `155.0.8059.40`](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/content/browser/devtools/devtools_http_handler.cc)):

```cpp
bool RequestIsSafeToServe(const net::HttpServerRequestInfo& info) {
  // For browser-originating requests, serve only those that are coming from
  // pages loaded off localhost or fixed IPs.
  std::string header = info.GetHeaderValue("host");
  if (header.empty())
    return true;
  GURL url = GURL("https://" + header);
  return url.HostIsIPAddress() || net::IsLocalHostname(url.GetHost());
}
```

What it accepts (code + [`net::IsLocalHostname`](https://chromium.googlesource.com/chromium/src/+/main/net/base/url_util.cc)):

- an **empty Host** (HTTP/1.0-style only; unreachable from fetch/ws clients) — the only
  code-level bypass, and it corrupts `webSocketDebuggerUrl` (`ws:///devtools/...`, per
  [chrome-remote-interface#340](https://github.com/cyrus-and/chrome-remote-interface/issues/340));
- **any IP literal**, IPv4 and IPv6 — the header is re-parsed as a URL, so a port is
  split off (`172.20.0.2:9222` passes; IPv6 must be bracketed);
- **`localhost`** (case-insensitive) **and any `*.localhost`** (one trailing dot
  stripped) — matching the live Host matrix exactly.

Both `ServerWrapper::OnHttpRequest` and `ServerWrapper::OnWebSocketRequest` call this
gate first and reply **HTTP 500** with `Host header is specified and is not an IP
address or localhost.` — the exact status and body observed live in cases 1, 5 and 6.
(Note: the WS-upgrade path gained the Host check somewhere between Chrome 140 and 155;
on older Chromes only the HTTP endpoints were gated. On this image both are, as case 6
proves live.)

**History:** CL
[chromium-review 952522](https://chromium-review.googlesource.com/c/chromium/src/+/952522)
— _"DevTools: check Host header for being IP or localhost when connecting over RDP."_,
Pavel Feldman, committed 2018-03-07 (private bug 813540, DNS rebinding), cherry-picked
to Chrome 66 ([commit `0e914b9`](https://github.com/chromium/chromium/commit/0e914b95f7cae6e8238e4e9075f248f801c686e6));
first stable release carrying the check: **Chrome 66, April 2018**. First public
breakage reports:
[chrome-remote-interface#340](https://github.com/cyrus-and/chrome-remote-interface/issues/340),
[puppeteer#2242](https://github.com/puppeteer/puppeteer/issues/2242) (_"I also could
not find anything documented about this change"_).

A **separate** check governs the WebSocket `Origin` header (403 _"Rejected an incoming
WebSocket connection from the %s origin. Use … --remote-allow-origins=…"_, Chrome 111,
[issues.chromium.org/40061801](https://issues.chromium.org/40061801)). That is the only
thing `--remote-allow-origins` feeds ([`content_switches.cc`](https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc));
`RequestIsSafeToServe` consults no switches — **there is no Chrome flag that disables
the Host-header check**, matching case 5 live. (Puppeteer sends no `Origin`, so the
Origin check never even fires on this stack.)

### Why the IP works: Chrome builds `webSocketDebuggerUrl` from the Host header

From the same file, the `/json/version` handler:

```cpp
std::string host = info.GetHeaderValue("host");
version.Set(kTargetWebSocketDebuggerUrlField,
    base::StringPrintf("ws://%s%s", host.c_str(), browser_guid_.c_str()));
```

The requesting `Host` string is echoed verbatim (the bound address is used only for the
startup banner) — exactly the echo behavior observed live, including the dropped port
when the Host header has none. So an IP-based request passes the gate _and_ yields a
`ws://<same-ip>:9222/...` URL that passes it again at the upgrade. No rewriting needed,
end to end.

### What the official docs say

- [developer.chrome.com remote-debugging docs](https://developer.chrome.com/docs/devtools/remote-debugging):
  **nothing** about the Host rule, DNS rebinding, or the localhost/IP requirement (only
  adb forwarding to `http://localhost:9222/json`). The rule is effectively undocumented
  by Chrome — it exists in source plus a private bug.
- The one first-party doc covering it is chrome-devtools-mcp's own
  [docs/troubleshooting.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md)
  ("Remote debugging between virtual machine (VM) and host fails"): _"Chrome may reject
  the connection due to 'Host' header validation… You can bypass this restriction by
  creating an SSH tunnel"_ (`ssh -N -L 127.0.0.1:9222:127.0.0.1:9222 …`, then point the
  MCP at `http://127.0.0.1:9222`). I.e. the official workaround is "make it localhost
  from the client's perspective" — which the sidecar topology does natively.
- [Node.js](https://nodejs.org/learn/getting-started/debugging) documents the identical
  rule for its own inspector with the rationale stated openly: _"For additional security
  against DNS rebinding attacks, Node.js verifies that the 'Host' headers … either
  specify an IP address or localhost."_
- Orthogonal but worth knowing for the README:
  [Chrome 136 requires a non-default `--user-data-dir`](https://developer.chrome.com/blog/remote-debugging-port)
  when `--remote-debugging-port` is used (headless-shell already uses its own profile).

### chromedp/headless-shell: known, worked around client-side, not documented in the image

The image repo [chromedp/docker-headless-shell](https://github.com/chromedp/docker-headless-shell)
has issues disabled (tracked in
[chromedp/chromedp](https://github.com/chromedp/chromedp)); its README/tests only ever
curl `localhost`. But the exact scenario is documented in
[chromedp#505](https://github.com/chromedp/chromedp/issues/505) (Nov 2019): _"I'm trying
to connect to headless-shell from another container but this message appear to me
`Host header is specified and is not an IP address or localhost`"_. The maintainer's
answer: _"Yes, this is a restriction of the devtools protocol. We do something similar
in our codebase; grep for `forceIP`."_

That `forceIP` is the upstream fix, in
[`chromedp/remote/util.go`](https://github.com/chromedp/chromedp/blob/main/remote/util.go):
_"Since Chrome 66, clients of the Chrome DevTools Protocol that connect to a browser
must send the 'Host:' header as an IP address or 'localhost'."_ — non-IP hostnames are
resolved via `net.DefaultResolver` and rewritten to the first address, applied to both
the HTTP URL and ws URLs, with `http://container-name:9222/` listed in the doc comment.
This is why Go/chromedp users of headless-shell don't hit the problem;
[chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface/issues/340)
merged the same resolve-to-IP approach in 2018. **Puppeteer has no equivalent.**

### chrome-devtools-mcp: `--browser-url` passes through verbatim

Verified at tag
[`chrome-devtools-mcp-v1.10.1`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/BrowserManager.ts):
`--browser-url` is validated only as a URL
([browser-options.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/config/browser-options.ts))
and then assigned verbatim — `connectOptions.browserURL = browserURL` — to
`puppeteer.connect()`. No hostname rewriting, no resolution, no own `/json/version`
fetch. Its `--ws-headers` option _"Only works with --wsEndpoint"_, so it cannot inject a
Host override on the `--browser-url` path either. Docs examples all use
`http://127.0.0.1:9222` ([advanced-usage.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md));
no issue in its tracker reports the DNS-name rejection from Docker (closest:
[#328](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/328) remote-IP
unreachable, [#405](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/405)
WSL2 → troubleshooting SSH tunnel, [#2188](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2188)
HTTP-transport FR mentioning proxies).

### Puppeteer `connect({browserURL})`: fetch, echo, connect — no rewriting

In
[`BrowserConnector.ts`](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/common/BrowserConnector.ts):
for `browserURL` it fetches `<url>/json/version` with `globalThis.fetch`, returns
`data.webSocketDebuggerUrl` **as-is**, and hands it to
[`NodeWebSocketTransport`](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/NodeWebSocketTransport.ts),
whose `ws` library derives the `Host` header from the URL (none is set explicitly; no
`Origin` is sent). Hence the observed behavior: `--browser-url=http://chrome:9222`
dies on the very first request with `Failed to fetch browser webSocket URL from
http://chrome:9222/json/version: HTTP Internal Server Error` — Puppeteer's rendering of
Chrome's 500.

## Workaround assessment

| Option                                                                   | Works?  | Evidence / cost                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) `--browser-url=http://<chrome-container-IP>:9222`                    | **Yes** | Proven live end to end (case 4); Chrome echoes Host into `webSocketDebuggerUrl` (source + case 2), so no rewriting. Same strategy as chromedp's `forceIP`. Cost: the IP is allocator state (case 7).                                                                                                                                                                                                   |
| (b) Resolve-at-runtime wrapper (resolve `chrome` → IP before exec)       | Yes     | Re-implements chromedp's `resolveHost`/`forceIP`; would make the DNS name usable. But the entrypoint contract from #6 is strictly env-to-args (no substitution, no resolution), so this is **user-supplied** — a wrapper script or a tiny sidecar that writes the arg.                                                                                                                                 |
| (c) HTTP reverse proxy rewriting Host                                    | Heavy   | Live case 2 + source: rewriting `Host` makes Chrome echo the _rewritten_ host into `webSocketDebuggerUrl`, pointing the client at itself; the proxy must rewrite **both** the Host on HTTP **and** WS upgrade (case 6) **and** the JSON bodies. Production precedent exists (browserless serves `ws://chrome.browserless.io` in place of Chrome's URL) but it is disqualifyingly heavy for this image. |
| (d) Chrome flags                                                         | No      | `--remote-allow-origins=*` gates only the WS `Origin` allowlist (source; live case 5: rejection unchanged). No flag disables the Host check. The only official alternative is making the endpoint localhost from the client's view — SSH tunnel (chrome-devtools-mcp troubleshooting) or… a shared network namespace.                                                                                  |
| (e) Sidecar (`network_mode: "service:chrome"`) + `http://localhost:9222` | **Yes** | Verified end to end in the #3 research; `Host: localhost` is accepted (live matrix). The image's own default `--browser-url` already assumes this.                                                                                                                                                                                                                                                     |

The last row is the decisive one: the project already has a topology that satisfies
Chrome's rule by construction, and it is simpler than every workaround above.

## What #9 should say (README topology section)

The README (still the untouched template today) should, in substance:

1. **Document exactly one supported topology: the sidecar.**
   `network_mode: "service:chrome"` on the `mcp` service +
   `CHROME_DEVTOOLS_MCP_ARGS=--browser-url=http://localhost:9222` (the image default).
   Note that `ports` must then be declared on `chrome` (the netns owner), as the #3
   research already sketches.
2. **State the rule explicitly**, because every Docker instinct points the other way:
   > Chrome's DevTools endpoint rejects any request whose `Host` header is not an IP
   > address or `localhost` (DNS-rebinding protection, Chrome 66+; HTTP 500
   > `Host header is specified and is not an IP address or localhost.`). So
   > `--browser-url=http://chrome:9222` (or any service name) **cannot work**, and no
   > Chrome flag — including `--remote-allow-origins=*` — changes that.
3. **If separate containers are mentioned at all**, document them as advanced/fragile:
   use the chrome container's IP on the shared network
   (`docker inspect`/`getent hosts chrome`), re-resolved on every `up`, with the
   caveat that Docker may allocate a different address (anything else on the network
   can shift it). Do not present it as a supported path — the entrypoint contract (#6)
   deliberately does no DNS resolution, and a resolve-at-runtime wrapper is the user's
   to supply.
4. Optionally name the escape hatches upstream recognizes: making the endpoint
   localhost from the client's view (the sidecar; or SSH forwarding per
   chrome-devtools-mcp's troubleshooting) — not a proxy, which would need to rewrite
   Host, the WebSocket upgrade, and `webSocketDebuggerUrl` bodies.

## Is a named-service test cheap to add?

- **A negative test (hostname rejected) is cheap and deterministic**: two services on a
  Compose network, then assert `tools/call new_page` returns `isError: true` with
  `HTTP Internal Server Error` from `http://chrome:9222/json/version` (the tool
  response — remember the failure never reaches `docker logs`). It pins the exact
  failure mode the README warns about.
- **A positive IP-based test is the fragile one**: it needs chrome's container IP,
  which must be resolved after `up` (extra bootstrap step) and can change under
  address contention (demonstrated live in case 7). On a shared CI daemon with
  concurrent networks it is a flake in waiting. If wanted, resolve the IP from a
  one-shot service and inject it via an env var — or skip it: the sidecar e2e (issue #3
  pattern) already covers the full chain, and the IP form's mechanics are proven here.
- Either way, mcp-proxy's `/mcp` endpoint (issue #4 shapes) drives both without host
  port publishing; keep 9222/19222 internal to the project network.

## Sources

Live verification on this machine, 2026-10-14 (Docker Engine 29.9.0, Compose 5.6.0):
all commands and outputs in [Live verification](#live-verification-2026-10-14) above.

- Chromium source: [devtools_http_handler.cc (main)](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_http_handler.cc) ·
  [same at tag 155.0.8059.40](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/content/browser/devtools/devtools_http_handler.cc) ·
  [net/base/url_util.cc](https://chromium.googlesource.com/chromium/src/+/main/net/base/url_util.cc) ·
  [content_switches.cc](https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc) ·
  CL [952522](https://chromium-review.googlesource.com/c/chromium/src/+/952522) ·
  cherry-pick [commit 0e914b9](https://github.com/chromium/chromium/commit/0e914b95f7cae6e8238e4e9075f248f801c686e6) ·
  Origin-enforcement issue [40061801](https://issues.chromium.org/40061801)
- Chrome/Node docs: [remote-debugging](https://developer.chrome.com/docs/devtools/remote-debugging) ·
  [remote-debugging-port blog (M136)](https://developer.chrome.com/blog/remote-debugging-port) ·
  [Node.js debugging docs](https://nodejs.org/learn/getting-started/debugging)
- chromedp: [docker-headless-shell repo](https://github.com/chromedp/docker-headless-shell) ·
  [chromedp#505 (exact scenario)](https://github.com/chromedp/chromedp/issues/505) ·
  [remote/util.go (`forceIP`)](https://github.com/chromedp/chromedp/blob/main/remote/util.go)
- chrome-devtools-mcp: [BrowserManager.ts @v1.10.1](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/BrowserManager.ts) ·
  [browser-options.ts @v1.10.1](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/config/browser-options.ts) ·
  [troubleshooting.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md) ·
  [advanced-usage.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md) ·
  issues [#328](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/328),
  [#405](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/405),
  [#2188](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2188)
- Puppeteer: [BrowserConnector.ts](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/common/BrowserConnector.ts) ·
  [NodeWebSocketTransport.ts](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/NodeWebSocketTransport.ts) ·
  [puppeteer#2242](https://github.com/puppeteer/puppeteer/issues/2242)
- Ecosystem reports of the same rejection:
  [chrome-remote-interface#340](https://github.com/cyrus-and/chrome-remote-interface/issues/340) ·
  [go-rod discussion #510](https://github.com/go-rod/rod/discussions/510) ·
  [Stack Overflow 70990383](https://stackoverflow.com/questions/70990383/host-header-is-specified-and-is-not-an-ip-address-or-localhost-message-when-us) ·
  [browserless /json/version docs](https://docs.browserless.io/enterprise/utility-functions/json-version)
  (body-rewriting proxy precedent)
- Prior research this builds on:
  [headless-Chrome image selection](https://github.com/andrielson/chrome-devtools-mcp-proxy/blob/research/headless-chrome-image/docs/research/headless-chrome-image.md)
  (issue #3, sidecar pattern verified),
  [MCP test client](https://github.com/andrielson/chrome-devtools-mcp-proxy/blob/research/mcp-test-client/docs/research/2026-10-14-mcp-test-client.md)
  (issue #4, mcp-proxy `/mcp` Streamable HTTP shapes),
  [entrypoint contract prototype](https://github.com/andrielson/chrome-devtools-mcp-proxy/blob/prototype/entrypoint-contract/src/docker-entrypoint.sh)
  (issue #6, env-to-args only — no substitution, no DNS resolution).
