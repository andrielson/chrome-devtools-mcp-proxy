// Unit suite for the MCP JSON-RPC client (tests/helpers/mcp-client.ts), run
// without Docker: the wire-protocol contract — request shape, session-id
// capture and echo, protocol-version negotiation, error surfacing — is
// checkable against a scripted HTTP transport, so protocol bugs surface in
// milliseconds instead of as e2e flakes. The e2e smoke then only has to prove
// the chain, not the client.
import { describe, expect, test } from 'bun:test'

import type { HttpRequest, HttpResponse } from '../helpers/mcp-client'
import { fetchTransport, McpClient } from '../helpers/mcp-client'

// The spec-standard Accept header the client sends; reused by the transport
// test below.
const ACCEPT_HEADER = 'application/json, text/event-stream'

// A scripted transport: responses are consumed in order, every request is
// recorded, and a request with no scripted response fails loudly (the client
// under test made a call the test did not arrange).
const scriptedTransport = (responses: HttpResponse[]) => {
  const requests: HttpRequest[] = []
  let next = 0
  const transport = async (_url: string, request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request)
    const response = responses[next++]
    if (response === undefined) {
      throw new Error(`unexpected request #${next}: ${JSON.stringify(request)}`)
    }
    return response
  }
  return { transport, requests }
}

// A successful JSON-RPC response wrapping `result` in the wire envelope.
const okJson = (result: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
})

const accepted = { status: 202, headers: {}, body: '' }

const sessionId = 'f'.repeat(32)

const initializeResult = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  serverInfo: { name: 'chrome_devtools', version: '1.10.1' },
}

describe('the MCP JSON-RPC client', () => {
  test('initialize performs the handshake, captures the session and confirms it initialized', async () => {
    const { transport, requests } = scriptedTransport([
      okJson(initializeResult, { 'mcp-session-id': sessionId }),
      accepted,
    ])
    const client = new McpClient(transport, 'http://proxy.test/mcp')

    const result = await client.initialize()
    expect(result.serverInfo.name).toBe('chrome_devtools')

    // The initialize request: JSON-RPC with an id, the declared client, and
    // no session header — the session is not known yet.
    const initialize = JSON.parse(requests[0]?.body ?? '')
    expect(initialize).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'chrome-devtools-mcp-proxy-e2e', version: '0.0.0' },
      },
    })
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers['Content-Type']).toBe('application/json')
    expect(requests[0]?.headers.Accept).toContain('application/json')
    expect(requests[0]?.headers).not.toHaveProperty('Mcp-Session-Id')

    // The initialized notification: no id (notifications are not requests),
    // and the captured session echoed back.
    const notification = JSON.parse(requests[1]?.body ?? '')
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(requests[1]?.headers['Mcp-Session-Id']).toBe(sessionId)
  })

  test('after the handshake every request echoes the session and the negotiated protocol version', async () => {
    const { transport, requests } = scriptedTransport([
      okJson({ ...initializeResult, protocolVersion: '2025-11-25' }, { 'mcp-session-id': sessionId }),
      accepted,
      okJson({ tools: [{ name: 'new_page' }, { name: 'performance_start_trace' }] }),
    ])
    const client = new McpClient(transport, 'http://proxy.test/mcp')
    await client.initialize()

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['new_page', 'performance_start_trace'])

    const listRequest = requests[2]
    expect(JSON.parse(listRequest?.body ?? '').method).toBe('tools/list')
    // The server negotiated a newer protocol revision than the client opened
    // with — subsequent requests must speak the negotiated one.
    expect(listRequest?.headers['MCP-Protocol-Version']).toBe('2025-11-25')
    expect(listRequest?.headers['Mcp-Session-Id']).toBe(sessionId)
  })

  test('callTool sends the tool name and arguments under tools/call', async () => {
    const { transport, requests } = scriptedTransport([
      okJson(initializeResult, { 'mcp-session-id': sessionId }),
      accepted,
      okJson({ content: [{ type: 'text', text: 'done' }] }),
    ])
    const client = new McpClient(transport, 'http://proxy.test/mcp')
    await client.initialize()

    const result = await client.callTool('performance_start_trace', { pageId: 3, autoStop: true, reload: true })
    expect(result.content?.[0]?.text).toBe('done')

    expect(JSON.parse(requests[2]?.body ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'performance_start_trace', arguments: { pageId: 3, autoStop: true, reload: true } },
    })
  })

  test('a JSON-RPC error result is thrown with the server’s error payload', async () => {
    const { transport } = scriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unknown tool' } }),
      },
    ])
    const client = new McpClient(transport, 'http://proxy.test/mcp')

    await expect(client.callTool('no_such_tool', {})).rejects.toThrow('Unknown tool')
  })

  test('a non-JSON response fails loudly with status and content type', async () => {
    // mcp-proxy answers application/json (json_response=True). If a future
    // version answers an SSE stream instead, the client must say so instead of
    // failing with a confusing JSON parse error.
    const { transport } = scriptedTransport([
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: message\ndata: {}\n\n' },
    ])
    const client = new McpClient(transport, 'http://proxy.test/mcp')

    await expect(client.listTools()).rejects.toThrow('tools/list answered text/event-stream (HTTP 200)')
  })

  test('closeSession DELETEs the session exactly once, and never without one', async () => {
    const { transport, requests } = scriptedTransport([
      okJson(initializeResult, { 'mcp-session-id': sessionId }),
      accepted,
      { status: 200, headers: {}, body: '' },
    ])
    const client = new McpClient(transport, 'http://proxy.test/mcp')
    await client.initialize()

    await client.closeSession()
    await client.closeSession() // a session already terminated — nothing to delete

    const terminate = requests[2]
    expect(terminate?.method).toBe('DELETE')
    expect(terminate?.headers['Mcp-Session-Id']).toBe(sessionId)
    // Once for initialize, once for the notification, once for the DELETE —
    // the second closeSession added no request.
    expect(requests).toHaveLength(3)

    // Without a handshake there is no session to terminate: no request at all.
    const silent = scriptedTransport([])
    const fresh = new McpClient(silent.transport, 'http://proxy.test/mcp')
    await fresh.closeSession()
    expect(silent.requests).toHaveLength(0)
  })
})

describe('the fetch transport', () => {
  test('performs the round trip and lowercases response headers', async () => {
    const seen: Array<{ method: string; body: string; contentType?: string }> = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seen.push({
          method: request.method,
          body: await request.text(),
          contentType: request.headers.get('content-type') ?? undefined,
        })
        return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'S1' },
        })
      },
    })
    try {
      const response = await fetchTransport(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: ACCEPT_HEADER },
        body: '{"jsonrpc":"2.0"}',
      })

      expect(seen).toEqual([{ method: 'POST', body: '{"jsonrpc":"2.0"}', contentType: 'application/json' }])
      expect(response.status).toBe(200)
      // Response headers normalize to lowercase — the transports' contract,
      // which McpClient relies on when reading mcp-session-id.
      expect(response.headers['mcp-session-id']).toBe('S1')
      expect(response.body).toBe('{"jsonrpc":"2.0","id":1,"result":{}}')
    } finally {
      server.stop(true)
    }
  })
})
