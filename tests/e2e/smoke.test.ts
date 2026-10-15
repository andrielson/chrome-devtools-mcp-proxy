// E2E smoke: one real MCP session through the whole chain — client →
// mcp-proxy → chrome-devtools-mcp → Chrome — proving the transport glue, not
// assuming it. Exactly the map's three steps plus teardown, no extras: every
// extra call is flake surface, and this suite loads the real
// developers.chrome.com page (outbound internet required — skipped visibly
// without it, like Docker is). Assertions are structural, never exact: an
// upstream page change must not turn into a failure here.
//
// All paths are CWD-relative: this suite is run as bare `bun test` from the
// repository root. Lifecycle per Docker suite file — defensive teardown,
// build, bring-up, tests, teardown; no shared singleton stack.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { $ } from 'bun'

import { resolveComposeProject } from '../helpers/compose-project'
import { isDockerAvailable } from '../helpers/docker-availability'
import type { CallToolResult } from '../helpers/mcp-client'
import { fetchTransport, McpClient } from '../helpers/mcp-client'
import { netnsHttpTransport } from '../helpers/netns-http'
import { isOutboundInternetAvailable } from '../helpers/outbound-internet'
import { pollUntil } from '../helpers/poll-until'

const project = resolveComposeProject('tests/.env')
const compose = ['docker', 'compose', '--file', 'tests/fixtures/docker-compose.yml', '--project-name', project]

describe.skipIf(!isDockerAvailable() || !isOutboundInternetAvailable())(
  'one MCP session through the whole chain',
  () => {
    let client: McpClient | undefined

    // The tests run only after beforeAll built the client; when it never got
    // built (a failed bring-up), fail with a clear message instead of a
    // TypeError on undefined.
    const session = (): McpClient => {
      if (client === undefined) throw new Error('no session client — the stack bring-up failed')
      return client
    }

    // The selected page's id from a new_page result: structuredContent.pages[]
    // when the server sends it, with the human-readable page list as the
    // fallback (v1.10.1 sends only the text form).
    const selectedPageIdOf = (result: CallToolResult): number => {
      const pages = result.structuredContent?.pages
      if (Array.isArray(pages)) {
        const selected = pages.find((page) => (page as { selected?: boolean }).selected === true) as
          | { id?: unknown }
          | undefined
        if (typeof selected?.id === 'number') return selected.id
      }
      const text = (result.content ?? []).map((item) => item.text ?? '').join('\n')
      const fromText = Number(/^(\d+): .*\[selected\]/m.exec(text)?.[1])
      if (Number.isInteger(fromText) && fromText > 0) return fromText
      throw new Error(`no selected page id in the new_page result: ${JSON.stringify(result)}`)
    }

    // Where the session speaks HTTP from. The published port is the documented
    // surface (ephemeral, resolved at runtime — concurrent worktrees never
    // collide), but some daemons publish on a host this process cannot reach
    // (rootless daemons, remote sockets, daemons serving an outer host), so
    // fall back to speaking from inside the shared network namespace via the
    // image's own Node — the same McpClient wire protocol either way.
    const sessionClient = async (): Promise<McpClient> => {
      const containerId = (await $`${compose} ps --quiet mcp`.quiet().text()).trim()
      expect(containerId).not.toBe('')
      const inNetns = netnsHttpTransport(containerId)

      // `up --wait` gates on the container running, not on the HTTP listener:
      // poll /status in-netns (reachable wherever the daemon publishes) until
      // the proxy answers — after which a published-port failure means
      // "unreachable", never "not ready yet".
      await pollUntil(
        async () => {
          try {
            const response = await inNetns('http://127.0.0.1:19222/status', { method: 'GET', headers: {} })
            return response.status === 200 ? response : undefined
          } catch {
            return undefined // not answering (yet) — keep polling
          }
        },
        30_000,
        500,
        async () =>
          new Error(
            `/status did not answer in-netns within 30 s; the mcp service's docker logs:\n${await $`docker logs ${containerId}`.quiet().nothrow().text()}`,
          ),
      )

      const published = (await $`${compose} port chrome 19222`.quiet().nothrow().text()).trim()
      const hostPort = Number(published.split(':').pop())
      if (Number.isInteger(hostPort) && hostPort > 0) {
        try {
          const response = await fetch(`http://127.0.0.1:${hostPort}/status`, {
            signal: AbortSignal.timeout(4000),
          })
          if (response.ok) {
            console.log(`e2e: driving the session via the published port ${hostPort}`)
            return new McpClient(fetchTransport, `http://127.0.0.1:${hostPort}/mcp`)
          }
        } catch {
          // Unreachable from this process — the in-netns transport below.
        }
      }
      console.log('e2e: published port unreachable from this process — driving the session in-netns')
      return new McpClient(inNetns, 'http://127.0.0.1:19222/mcp')
    }

    beforeAll(async () => {
      // Defensive teardown first: afterAll does not run when a prior run was
      // killed, so this run's `down` cleans its leftovers. nothrow: a stack
      // that was never up is the normal first-run case.
      await $`${compose} down --volumes --remove-orphans`.nothrow().quiet()
      await $`${compose} build --pull`
      await $`${compose} up --detach --wait`
      client = await sessionClient()
    }, 300_000)

    afterAll(async () => {
      // The session is DELETEd at the end, including on failure paths — but a
      // teardown failure must not skip the stack teardown, and a client that
      // never initialized (beforeAll failed earlier) has no session at all.
      try {
        await client?.closeSession()
      } finally {
        await $`${compose} down --volumes --remove-orphans`.nothrow().quiet()
      }
    }, 120_000)

    test('initialize names the chrome_devtools server', async () => {
      const result = await session().initialize()
      expect(result.serverInfo.name).toBe('chrome_devtools')
    }, 120_000)

    test('tools/list exposes the page and performance tools', async () => {
      // Count-agnostic: which tools exist matters, not how many.
      const { tools } = await session().listTools()
      const names = tools.map((tool) => tool.name)
      expect(names).toContain('new_page')
      expect(names).toContain('performance_start_trace')
    }, 120_000)

    test('a real page load yields a performance trace with insights', async () => {
      const page = await session().callTool('new_page', { url: 'https://developers.chrome.com' })
      expect(page.isError).toBeFalsy()

      const trace = await session().callTool('performance_start_trace', {
        pageId: selectedPageIdOf(page),
        autoStop: true,
        reload: true,
      })
      expect(trace.isError).toBeFalsy()

      // Structural, never exact: a text result must have come back, and it
      // must be the pinned server's trace report — insight sets, a lab LCP
      // metric value — not a page-specific string. Upstream page changes may
      // alter every value in the report, but not this shape; bumping the
      // pinned CHROME_DEVTOOLS_MCP_VERSION is the one event that may.
      const text = (trace.content ?? []).find((item) => item.type === 'text')?.text ?? ''
      expect(text).not.toBe('')
      expect(text).toMatch(/insight set id:/i)
      expect(text).toMatch(/LCP: \d/)
    }, 120_000)
  },
)
