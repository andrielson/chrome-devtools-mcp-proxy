// The e2e smoke's MCP client: zero dependencies, no MCP SDK — just the
// streamable-HTTP wire protocol (POST /mcp, mcp-session-id header echo,
// session DELETE) over an injectable HTTP transport. The default transport is
// plain fetch; tests/helpers/netns-http.ts provides the in-netns alternative
// for daemons whose published ports do not reach the test process. The wire
// contract is unit-tested in tests/unit/mcp-client.test.ts.

/** One HTTP round trip. Transports return response headers with lowercase keys. */
export type HttpTransport = (url: string, request: HttpRequest) => Promise<HttpResponse>

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE'
  headers: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

// The spec-standard Accept: the server may answer application/json (mcp-proxy
// does) or an SSE stream; the client below insists on JSON.
const ACCEPT = 'application/json, text/event-stream'

// The default transport: one fetch per round trip, response headers
// normalized to the lowercase contract every transport must return.
export const fetchTransport: HttpTransport = async (url, request) => {
  const response = await fetch(url, { method: request.method, headers: request.headers, body: request.body })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return { status: response.status, headers, body: await response.text() }
}

export interface InitializeResult {
  protocolVersion: string
  serverInfo: { name: string }
}

export interface ToolsResult {
  tools: Array<{ name: string }>
}

export interface CallToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

export class McpClient {
  readonly #transport: HttpTransport
  readonly #url: string
  #sessionId: string | undefined
  #protocolVersion = '2025-06-18'
  #nextRequestId = 1

  constructor(transport: HttpTransport, url: string) {
    this.#transport = transport
    this.#url = url
  }

  // Send a request, attaching the session header once a session exists.
  async #exchange(request: HttpRequest): Promise<HttpResponse> {
    return this.#transport(this.#url, {
      ...request,
      headers: {
        ...request.headers,
        ...(this.#sessionId ? { 'Mcp-Session-Id': this.#sessionId } : {}),
      },
    })
  }

  #captureSession(response: HttpResponse): void {
    this.#sessionId ??= response.headers['mcp-session-id']
  }

  async #rpc(method: string, params?: unknown): Promise<unknown> {
    const response = await this.#exchange({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        'MCP-Protocol-Version': this.#protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextRequestId++, method, params }),
    })
    this.#captureSession(response)

    const contentType = response.headers['content-type'] ?? ''
    if (!contentType.includes('application/json')) {
      // mcp-proxy answers application/json (json_response=True). If that ever
      // changes, fail loudly here instead of producing a confusing parse error.
      throw new Error(
        `${method} answered ${contentType || 'no content-type'} (HTTP ${response.status}): ${response.body.slice(0, 200)}`,
      )
    }
    const message = JSON.parse(response.body) as { result?: unknown; error?: unknown }
    if (message.error !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(message.error)}`)
    }
    return message.result
  }

  async #notify(method: string): Promise<void> {
    const response = await this.#exchange({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    })
    this.#captureSession(response)
    if (response.status !== 202) {
      throw new Error(`notification ${method} answered HTTP ${response.status}: ${response.body.slice(0, 200)}`)
    }
  }

  async initialize(): Promise<InitializeResult> {
    const result = (await this.#rpc('initialize', {
      protocolVersion: this.#protocolVersion,
      capabilities: {},
      clientInfo: { name: 'chrome-devtools-mcp-proxy-e2e', version: '0.0.0' },
    })) as InitializeResult
    if (typeof result.protocolVersion === 'string') {
      this.#protocolVersion = result.protocolVersion
    }
    await this.#notify('notifications/initialized')
    return result
  }

  listTools(): Promise<ToolsResult> {
    return this.#rpc('tools/list', {}) as Promise<ToolsResult>
  }

  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.#rpc('tools/call', { name, arguments: args }) as Promise<CallToolResult>
  }

  // Terminate the session (streamable-HTTP DELETE). A client with no session —
  // initialize never ran or already terminated — has nothing to delete.
  async closeSession(): Promise<void> {
    if (this.#sessionId === undefined) return
    try {
      const response = await this.#exchange({ method: 'DELETE', headers: {} })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`session DELETE answered HTTP ${response.status}: ${response.body.slice(0, 200)}`)
      }
    } finally {
      this.#sessionId = undefined
    }
  }
}
