// Unit suite for the in-netns HTTP transport (tests/helpers/netns-http.ts),
// run without Docker. The transport's docker-exec side is deliberately thin —
// build an argv array, run it, parse one JSON line — so what needs unit
// testing is the pure surface: the command plan's env encoding, the output
// parsing, and the invariants coupling the plan to the program it execs. The
// program's live round trip is the e2e smoke's to prove (it IS the production
// path); here, executing a spawned HTTP client is neither possible in every
// sandbox nor the unit suite's tier.
//
// One deliberate exception to the unit suite's no-white-box rule: the coupling
// test below asserts on the program's source text, because the plan and the
// program are two artifacts that only meet inside the container — a rename on
// either side would otherwise surface as an e2e failure far from the change.
// The rest of this file stays behavioral.
import { describe, expect, test } from 'bun:test'

import type { HttpRequest, HttpResponse } from '../helpers/mcp-client'
import { NETNS_ROUND_TRIP_SCRIPT, netnsExecPlan, parseRoundTrip } from '../helpers/netns-http'

const request: HttpRequest = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'a'.repeat(32) },
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
}

describe('the in-netns transport', () => {
  test('the exec plan encodes the round trip as docker-exec argv with env inputs', () => {
    const plan = netnsExecPlan('container-id-123', 'http://127.0.0.1:19222/mcp', request)

    expect(plan).toEqual([
      'docker',
      'exec',
      '--env',
      'MCP_E2E_URL=http://127.0.0.1:19222/mcp',
      '--env',
      'MCP_E2E_METHOD=POST',
      '--env',
      `MCP_E2E_HEADERS=${JSON.stringify(request.headers)}`,
      '--env',
      `MCP_E2E_BODY=${request.body}`,
      'container-id-123',
      'node',
      '--eval',
      NETNS_ROUND_TRIP_SCRIPT,
    ])
  })

  test('a round trip without a body sends an empty MCP_E2E_BODY, not the string "undefined"', () => {
    const plan = netnsExecPlan('c', 'http://127.0.0.1:19222/mcp', { method: 'DELETE', headers: {} })
    expect(plan).toContain('MCP_E2E_BODY=')
    expect(plan).not.toContain('MCP_E2E_BODY=undefined')
  })

  test('parseRoundTrip decodes the program’s one JSON line', () => {
    const answer = parseRoundTrip('{"status":202,"headers":{},"body":""}')
    expect(answer).toEqual({ status: 202, headers: {}, body: '' } satisfies HttpResponse)
  })

  test('the program and the plan agree on their contract', () => {
    // Every variable the plan exports must be one the program reads, and vice
    // versa — a rename on either side would otherwise only surface as an e2e
    // failure far from the change.
    const exported = netnsExecPlan('c', 'u', request)
      .filter((argument) => argument.startsWith('MCP_E2E_'))
      .map((argument) => `process.env.${argument.slice(0, argument.indexOf('='))}`)
    expect(exported).toEqual([
      'process.env.MCP_E2E_URL',
      'process.env.MCP_E2E_METHOD',
      'process.env.MCP_E2E_HEADERS',
      'process.env.MCP_E2E_BODY',
    ])
    for (const reference of exported) {
      expect(NETNS_ROUND_TRIP_SCRIPT).toContain(reference)
    }
    const read = Array.from(NETNS_ROUND_TRIP_SCRIPT.matchAll(/process\.env\.[A-Z0-9_]+/g), ([name]) => name)
    expect(read).toEqual(exported)

    // The program must terminate itself once stdout has flushed: the HTTP
    // client's keep-alive socket outlives the response, so without an explicit
    // exit the exec'd process (and `docker exec` with it) never returns.
    expect(NETNS_ROUND_TRIP_SCRIPT).toContain('()=>process.exit(0)')

    // And it must be a syntactically valid program at all — parse, never run.
    expect(() => new Function(NETNS_ROUND_TRIP_SCRIPT)).not.toThrow()
  })
})
