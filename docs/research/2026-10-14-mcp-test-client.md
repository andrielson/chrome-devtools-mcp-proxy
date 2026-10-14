# Research: lightest MCP client for the Bun e2e smoke test

- **Ticket:** [#4](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/4) (wayfinder map: [#1](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/1))
- **Date:** 2026-10-14
- **Question:** What is the lightest, most suitable MCP client for Bun test files driving an e2e smoke test through mcp-proxy's HTTP transport?

## TL;DR

**Use a ~60-line hand-rolled `fetch`-based JSON-RPC client in the test files. Zero dependencies.**

mcp-proxy (v0.13.0) exposes **both** MCP HTTP transports on its listen port — Streamable
HTTP at `POST /mcp` and legacy HTTP+SSE at `GET /sse` — and its `/mcp` endpoint answers
every client request with a plain `Content-Type: application/json` body (it configures the
Python SDK session manager with `json_response=True`). That removes the only real reason a
smoke test would need an SDK: SSE parsing. The full lifecycle (initialize →
`notifications/initialized` → `tools/list` → `tools/call` → `DELETE`) was validated under
Bun against a real, locally running mcp-proxy 0.13.0 — see [Verification](#verification).

Fall back to `@modelcontextprotocol/client` (v2, not the legacy `@modelcontextprotocol/sdk`)
only if the tests grow needs the wire protocol makes annoying: server-initiated requests,
elicitation, SSE-streamed responses, capability-aware negotiation.

## Part 1 — What mcp-proxy actually exposes

Verified three ways: DeepWiki on `sparfenyuk/mcp-proxy`, current `main` source
(`src/mcp_proxy/mcp_server.py`, `src/mcp_proxy/__main__.py`), GitHub release notes, and a
**live run of mcp-proxy 0.13.0** against a minimal stdio MCP server (2026-10-14).

### Both transports, one port

Every server-mode instance (`mcp-proxy --port <P> -- <command...>`) mounts, on the same
port:

| Endpoint  | Transport         | Behavior (live-observed)                                                                                                       |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/mcp`    | Streamable HTTP   | `POST` initialize → `200` + `mcp-session-id` header, body is plain JSON. Notifications → `202`. `DELETE` with session → `200`. |
| `/sse`    | Legacy HTTP+SSE   | `GET` → SSE stream; first event `event: endpoint` / `data: /messages/?session_id=<32-hex>`.                                    |
| `/status` | (health, not MCP) | JSON: `api_last_activity`, `active_sse_connections`, `server_instances`.                                                       |

Source: `create_single_instance_routes()` in `src/mcp_proxy/mcp_server.py` builds the
Streamable HTTP route with `StreamableHTTPSessionManager(..., json_response=True, stateless=<--stateless>)`
and the legacy route with `SseServerTransport('/messages/')`. The `json_response=True` is
the load-bearing fact: **POST responses are `application/json`, never SSE-wrapped**.

Startup log only advertises the SSE URL ("Serving MCP Servers via SSE: …") — the README's
server-mode section likewise only shows `/sse` URLs — but `/mcp` is there and is the
transport to target.

### Session rules (stateful, the default)

- The first `POST /mcp` without a session header must be `initialize`; anything else →
  `400 "Missing session ID"`.
- `initialize` response carries `mcp-session-id: <32-hex>`; **every subsequent request
  must echo it** (missing → `400`; unknown/wrong → `404 "Session not found"`).
- `notifications/initialized` returns `202` but is **not enforced** — `tools/list` works
  right after `initialize`. Send it anyway; it is one line and spec-required.
- `DELETE /mcp` with the session header terminates the session (`200`).
- `--stateless` flips this: no session id is issued and no `initialize` is required at all.
- No authentication on the exposed server. `--username`/`--password`/`--digest`/OAuth
  flags are for mcp-proxy's _client_ mode (connecting upstream), not the listen port.
- POSTs require an `Accept` header including `application/json` (none → `406`).
  Sending the spec-standard `Accept: application/json, text/event-stream` works fine.
- Relevant flags: `--port` (**default 0 = random port** — the e2e harness must pass one
  explicitly and/or read `/status`), `--host` (default `127.0.0.1`), `--stateless`,
  `--allow-origin` (no CORS by default).

### Transport timeline (GitHub releases)

- v0.3.0 (2025-01-02): server mode added, SSE only.
- v0.6.0 (2025-05-13): Streamable HTTP at `/mcp` (PR #60), `--stateless` added.
- v0.10.0 (2025-10-26): `/mcp` handling aligned with the official python-sdk.
- v0.13.0 (2026-10-10, current): upstream client auth; `mcp` dependency capped `<2`.

## Part 2 — Client candidates

### A. `@modelcontextprotocol/sdk` (v1) — not recommended

- **Weight (measured 2026-10-14, `bun add`):** 92 packages installed, 27 MB `node_modules`.
  Ships the whole server stack (express, hono, cors, jose, ajv, express-rate-limit…) that a
  test client never touches.
- **Status:** maintenance mode. The v2 release (2026-07-27) made `main` the v2 line; v1.x
  gets bug/security fixes "for at least six months after the v2 release" (ROADMAP.md) and
  targets the older 2025-11-25 spec revision. New spec revisions land on v2 only.
- **Bun:** works in practice (engines: `node >= 18`); Bun support was tracked as v2 work
  (issue #1269). Several historical Bun issues (#91, #709) are closed.

### B. `@modelcontextprotocol/client` (v2) — the SDK fallback

- **Weight (measured):** 13 packages installed, 18 MB (dominated by zod + jose).
- **Status:** stable line since 2.0.0 (2026-07-27); current 2.3.1 (2026-10-05). Semver'd,
  fixed version group with `@modelcontextprotocol/core`. Young and fast-moving (2.1 → 2.3.1
  in two weeks).
- **Bun:** first-class. Repo README: "It runs on **Node.js**, **Bun**, and **Deno**", with
  `bun add @modelcontextprotocol/client` shown; runtime coverage for Bun is an explicit v2
  hardening focus (ROADMAP.md). **Validated live under Bun** in this research: `connect()`
  (initialize handshake), `listTools()`, `callTool()`, `terminateSession()`, `close()` all
  pass against a real mcp-proxy 0.13.0.
- **API:** `import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'`.
  Same class names as v1; only import paths moved. `SSEClientTransport` still exists as the
  documented fallback for SSE-only servers, and v2 docs show try-Streamable-then-SSE as the
  compatibility pattern — useful if the tests must also cope with pre-0.6.0 proxies (they
  will not; the repo pins current mcp-proxy).

### C. Hand-rolled `fetch` JSON-RPC client — recommended

- **Weight:** zero dependencies; ~60 lines; uses Bun's native global `fetch`.
- **Bun:** nothing to be compatible with — plain `fetch` + `Response.json()`.
  **Validated live under Bun** against real mcp-proxy 0.13.0 (full lifecycle, including
  `DELETE` teardown → `200`).
- **API stability:** depends only on the MCP wire protocol (`initialize`, `tools/list`,
  `tools/call`), which is stable across revisions and pinned by mcp-proxy's own `mcp <2`
  dependency. No SDK major-version churn exposure (v1 → v2 moved every import path).
- **Covers the smoke test exactly:** initialize → list → one call. mcp-proxy answers
  `application/json`, so `res.json()` suffices — no SSE parsing.
- **Risks & mitigations:**
  - If a future mcp-proxy stops setting `json_response=True`, responses become SSE
    (`text/event-stream`). Mitigation: the helper below asserts the response content type,
    so the change fails loudly at the assertion, not as a confusing parse error.
  - Server-initiated requests / elicitation / sampling would need a GET SSE stream.
    chrome-devtools-mcp's performance flow needs none of these; it is client-driven only.
  - No schema validation of results — irrelevant for a smoke test that asserts on shape.

### Decision

| Criterion                | A: sdk v1           | B: client v2    | C: fetch hand-rolled |
| ------------------------ | ------------------- | --------------- | -------------------- |
| New dependencies         | 92 pkgs / 27 MB     | 13 pkgs / 18 MB | **none**             |
| Bun                      | works, unofficial   | **first-class** | **native**           |
| Maintenance risk         | **deprecated line** | young (2.x)     | none (wire protocol) |
| Matches smoke-test scope | overkill            | overkill        | **exact**            |

The repo currently has zero runtime dependencies; adding 18–27 MB of SDK to `devDependencies`
for four JSON-RPC POSTs is the wrong trade. Choose **C**, with **B** as the named fallback
pinned to `2.x` if requirements grow.

## Part 3 — Recommended snippet shape

Dropped into the future `tests/` as a helper + smoke test. The helper is the exact code
validated against real mcp-proxy 0.13.0 under Bun in this research.

### JSON-RPC-over-fetch helper (`tests/helpers/mcp.ts`)

```ts
const PROXY_URL = process.env.MCP_PROXY_URL ?? "http://127.0.0.1:8080/mcp";

let nextId = 1;
let sessionId: string | undefined;
let protocolVersion = "2025-06-18";

async function rpc(method: string, params?: unknown): Promise<any> {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      "MCP-Protocol-Version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId ??= res.headers.get("mcp-session-id") ?? undefined;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // mcp-proxy 0.13.0 answers application/json (json_response=True). If that ever
    // changes, fail loudly here instead of producing a confusing parse error.
    throw new Error(
      `unexpected content-type ${contentType} (HTTP ${res.status})`,
    );
  }
  const message = await res.json();
  if (message.error) throw new Error(JSON.stringify(message.error));
  return message.result;
}

async function notify(method: string): Promise<void> {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  });
  if (res.status !== 202)
    throw new Error(`notification ${method} -> HTTP ${res.status}`);
}

export async function initialize(): Promise<void> {
  const result = await rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "chrome-devtools-mcp-proxy-e2e", version: "0.0.0" },
  });
  protocolVersion = result.protocolVersion;
  await notify("notifications/initialized");
}

export const listTools = () => rpc("tools/list", {});
export const callTool = (name: string, arguments_: object) =>
  rpc("tools/call", { name, arguments: arguments_ });

export async function closeSession(): Promise<void> {
  if (!sessionId) return;
  await fetch(PROXY_URL, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": sessionId },
  });
  sessionId = undefined;
}
```

### Smoke test shape (`tests/e2e.smoke.test.ts`)

The performance check of <https://developers.chrome.com> is the example the
chrome-devtools-mcp README itself suggests ("Check the performance of
https://developers.chrome.com"). The tools: `new_page` (opens the URL, response lists
pages), then `performance_start_trace` with `autoStop` + `reload` (navigates, records,
stops, and returns insights in one call). Both need a `pageId`, obtained from the
`structuredContent.pages[]` array (verified to pass through mcp-proxy verbatim) with a
text-regex fallback.

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { callTool, closeSession, initialize, listTools } from "./helpers/mcp";

beforeAll(initialize);
afterAll(closeSession);

test("proxy exposes chrome-devtools-mcp tools", async () => {
  const { tools } = await listTools();
  expect(tools.map((tool: { name: string }) => tool.name)).toContain(
    "performance_start_trace",
  );
});

test("performance check of developers.chrome.com", async () => {
  const page = await callTool("new_page", {
    url: "https://developers.chrome.com",
  });

  // structuredContent passes through mcp-proxy verbatim; fall back to the text list.
  const pageId: number =
    page.structuredContent?.pages?.find(
      (p: { selected: boolean }) => p.selected,
    )?.id ?? Number(/^(\d+): .*\[selected\]/m.exec(page.content[0].text)?.[1]);
  expect(Number.isInteger(pageId)).toBe(true);

  const trace = await callTool("performance_start_trace", {
    pageId,
    autoStop: true,
    reload: true,
  });
  expect(trace.isError).toBeFalsy();
  expect(JSON.stringify(trace.content)).toMatch(/(LCP|CLS|INP|Insight)/);
}, 120_000);
```

Notes on the flow:

- `performance_start_trace`'s `reload: true` re-navigates the page the tool just opened —
  its schema says to navigate first (`new_page` here) when `reload`/`autoStop` are set.
  The explicit start/stop pair (`performance_start_trace` then `performance_stop_trace`)
  works too but costs an extra round trip.
- Chrome starts lazily on the first tool that needs a browser, so `new_page` absorbs the
  startup cost; keep the test timeout generous (trace + cold load of a heavy page).
- chrome-devtools-mcp's `--headless` flag keeps CI hermetic; the smoke test does not read
  pixels.

### SDK fallback equivalent (for the record)

```ts
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const transport = new StreamableHTTPClientTransport(
  new URL(process.env.MCP_PROXY_URL ?? "http://127.0.0.1:8080/mcp"),
);
const client = new Client({
  name: "chrome-devtools-mcp-proxy-e2e",
  version: "0.0.0",
});

await client.connect(transport); // runs the initialize handshake
const { tools } = await client.listTools();
const result = await client.callTool({
  name: "performance_start_trace",
  arguments: { pageId: 1, autoStop: true, reload: true },
});
await transport.terminateSession();
await client.close();
```

## Verification

All live checks performed 2026-10-14 on this machine, Bun 1.4.x, against:

- a hand-written minimal stdio MCP server proxied by **mcp-proxy 0.13.0** (`uvx mcp-proxy
--port … -- python3 stdio_server.py`), exercising `curl` probes plus both client
  candidates under Bun;
- a hand-written minimal Streamable HTTP server (`Bun.serve`) for transport-agnostic
  cross-checks.

Results: candidate B (official v2 client) and candidate C (raw fetch) both completed
initialize → `tools/list` → `tools/call` → teardown under Bun against real mcp-proxy with
zero protocol errors. `structuredContent` round-trips through the proxy unchanged.

## Sources

- mcp-proxy source and docs: <https://github.com/sparfenyuk/mcp-proxy> (`src/mcp_proxy/mcp_server.py`, `src/mcp_proxy/__main__.py`), DeepWiki Q&A on `sparfenyuk/mcp-proxy`, GitHub Releases (v0.3.0 → v0.13.0), `mcp-proxy --help` and live run of 0.13.0.
- MCP Streamable HTTP transport spec (2025-06-18): <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports> — Accept header, `Mcp-Session-Id` lifecycle, `MCP-Protocol-Version` header, DELETE termination, legacy-SSE fallback.
- TypeScript SDK v2: <https://github.com/modelcontextprotocol/typescript-sdk> — README ("runs on Node.js, Bun, and Deno"; `bun add @modelcontextprotocol/client`), `docs/clients/connect.md`, `docs/get-started/first-client.md`, `ROADMAP.md` (v1.x maintenance), `VERSIONING.md`, issue #1269 (non-Node runtimes).
- npm registry measurements (2026-10-14): `@modelcontextprotocol/sdk@1.32.1` (16 deps → 92 packages, 27 MB), `@modelcontextprotocol/client@2.3.1` (7 deps → 13 packages, 18 MB).
- chrome-devtools-mcp: README ("Check the performance of https://developers.chrome.com") and `docs/tool-reference.md` (`new_page`, `list_pages`, `performance_start_trace`, `performance_stop_trace` schemas), DeepWiki Q&A on `ChromeDevTools/chrome-devtools-mcp` (pageId from `structuredContent.pages[]` or `^(\d+): .*\[selected\]` text lines).
