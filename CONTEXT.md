# chrome-devtools-mcp-proxy

A Docker image that exposes chrome-devtools-mcp (a stdio MCP server) over HTTP via mcp-proxy, always connecting to an external Chrome over CDP. The image is transport glue, not a browser host.

## Language

**Unit suite**:
Tests of script and helper logic run by Bun alone, with no Docker.
_Avoid_: script tests, white-box tests

**Container suite**:
Tests of the image's contract and wiring — entrypoint, environment defaults, final command, health endpoint — run with Docker and Compose, driving no MCP session.
_Avoid_: integration suite, docker tests

**E2E smoke**:
The single test that drives one MCP session through the whole chain — client, mcp-proxy, chrome-devtools-mcp, Chrome — against the real developers.chrome.com page.
_Avoid_: e2e tests, browser tests

**Fixture**:
The test-only Compose stack — Chrome, the cdp-wait gate, the proxy — never shipped as example configuration.
_Avoid_: example compose, demo stack

**cdp-wait gate**:
The one-shot fixture service whose successful exit makes the proxy's startup conditional on Chrome answering `/json/version`.
_Avoid_: readiness service, healthcheck sidecar

**Publication record**:
The git tag `v{version}` whose presence means that image version was successfully published; its absence means a publish is still due.
_Avoid_: release tag, version tag

### Topologies

The ways a user places the image next to their Chrome. Only the sidecar topology is tested.

**Sidecar topology**:
The proxy container shares Chrome's network namespace; the browser URL is localhost.
_Avoid_: netns mode, same-network trick

**Named-service topology**:
The proxy and Chrome are separate services on one network; the browser URL names Chrome's service.
_Avoid_: bridge topology

**Host-network topology**:
The proxy runs on the host network and reaches a Chrome on the host.
_Avoid_: local mode
