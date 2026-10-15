// An HttpTransport for daemons whose published ports do not reach the test
// process (rootless daemons, remote sockets, daemons serving an outer host):
// every round trip is executed by the image's own Node inside the given
// container's network namespace — `docker exec ... node --eval` — so the HTTP
// conversation happens on the loopback the proxy actually listens on. The
// proxy container shares Chrome's network namespace (the fixture's sidecar
// topology), so any container of that stack works as the exec target.
//
// The program takes its inputs as environment variables (identical semantics
// under every runtime — no argv parsing quirks) and answers with exactly one
// JSON line on stdout, already in the HttpResponse shape with lowercase
// header keys. The command plan, the output parsing and the plan↔program
// coupling are unit-tested in tests/unit/netns-http.test.ts; the program's
// live behavior is the e2e smoke's to prove — it IS the production path.
import { $ } from 'bun'

import type { HttpRequest, HttpResponse, HttpTransport } from './mcp-client'

// The one-shot program executed inside the container. It must terminate
// itself: the HTTP client's keep-alive socket outlives the response, so the
// process (and with it `docker exec`) would never return without the explicit
// exit once stdout has flushed.
export const NETNS_ROUND_TRIP_SCRIPT =
  '(async()=>{try{const r=await fetch(process.env.MCP_E2E_URL,{method:process.env.MCP_E2E_METHOD,headers:JSON.parse(process.env.MCP_E2E_HEADERS),body:process.env.MCP_E2E_BODY||undefined});const t=await r.text();const h={};for(const[k,v]of r.headers)h[k]=v;process.stdout.write(JSON.stringify({status:r.status,headers:h,body:t}),()=>process.exit(0))}catch(e){process.stderr.write(String(e));process.exit(1)}})()'

// The full `docker exec` command for one round trip, as an argv array: Bun
// Shell interpolates arrays element-per-argument, so URLs, header JSON and
// bodies with spaces or quotes each stay one argument without shell quoting.
export const netnsExecPlan = (containerId: string, url: string, request: HttpRequest): string[] => [
  'docker',
  'exec',
  '--env',
  `MCP_E2E_URL=${url}`,
  '--env',
  `MCP_E2E_METHOD=${request.method}`,
  '--env',
  `MCP_E2E_HEADERS=${JSON.stringify(request.headers)}`,
  '--env',
  `MCP_E2E_BODY=${request.body ?? ''}`,
  containerId,
  'node',
  '--eval',
  NETNS_ROUND_TRIP_SCRIPT,
]

// The program prints exactly one JSON line; this is the whole protocol back.
export const parseRoundTrip = (output: string): HttpResponse => JSON.parse(output) as HttpResponse

export const netnsHttpTransport =
  (containerId: string): HttpTransport =>
  async (url, request) =>
    parseRoundTrip(await $`${netnsExecPlan(containerId, url, request)}`.quiet().text())
