// Container suite: certifies the built image's contract and wiring with
// Docker + Compose — the ENTRYPOINT/ENV/label contract at `docker inspect`
// level, the env-override-to-argv wiring in a one-off, and mcp-proxy's
// /status with the fixture stack up. No MCP session is driven here; that is
// the e2e smoke's job. Skips with a visible notice (from the probe) when
// Docker is unavailable, so a Docker-less `bun test` stays green.
//
// All paths are CWD-relative: this suite is run as bare `bun test` from the
// repository root. Lifecycle per Docker suite file — defensive teardown,
// build, bring-up, tests, teardown; no shared singleton stack.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { $ } from 'bun'

import { resolveComposeProject } from '../helpers/compose-project'
import { isDockerAvailable } from '../helpers/docker-availability'
import { pollUntil } from '../helpers/poll-until'

const project = resolveComposeProject('tests/.env')
const compose = ['docker', 'compose', '--file', 'tests/fixtures/docker-compose.yml', '--project-name', project]

describe.skipIf(!isDockerAvailable())('the built image', () => {
  // bun:test kills hooks after 5 s by default; build + bring-up (base image
  // pulls, npm/uv installs, Chrome download, cdp-wait gate) needs a real
  // budget.
  beforeAll(async () => {
    // Defensive teardown first: afterAll does not run when a prior run was
    // killed, so this run's `down` cleans its leftovers. nothrow: a stack
    // that was never up is the normal first-run case.
    await $`${compose} down --volumes --remove-orphans`.nothrow().quiet()
    await $`${compose} build --pull`
    await $`${compose} up --detach --wait`
  }, 300_000)

  afterAll(async () => {
    await $`${compose} down --volumes --remove-orphans`.nothrow().quiet()
  }, 120_000)

  // The stack's mcp container and the image under test, both resolved at
  // runtime — resolve, don't derive: nothing assumes Compose's naming scheme.
  const mcpContainerIdOf = async (): Promise<string> => {
    const containerId = (await $`${compose} ps --quiet mcp`.quiet().text()).trim()
    expect(containerId).not.toBe('')
    return containerId
  }

  // `docker inspect --format` values are always interpolated as values, never
  // written as template-literal text: Bun Shell parses `{{... }}` constructs
  // containing spaces and mangles them into shell words before docker ever
  // sees the format string.
  const imageRefFormat = '{{.Image}}'
  const entrypointFormat = '{{json .Config.Entrypoint}}'
  const envFormat = '{{json .Config.Env}}'
  const labelsFormat = '{{json .Config.Labels}}'
  const runningFormat = '{{.State.Running}}'

  const inspect = (format: string, ref: string): Promise<string> =>
    $`docker inspect --format ${format} ${ref}`.quiet().text()

  const imageIdOf = async (): Promise<string> => (await inspect(imageRefFormat, await mcpContainerIdOf())).trim()

  test('docker inspect certifies the ENTRYPOINT, ENV defaults and pinned-version labels', async () => {
    const imageId = await imageIdOf()
    const entrypoint = JSON.parse(await inspect(entrypointFormat, imageId)) as string[]
    expect(entrypoint).toEqual(['/usr/local/bin/docker-entrypoint.sh'])

    const env = JSON.parse(await inspect(envFormat, imageId)) as string[]
    // "KEY=VALUE" entries; the value may itself contain '=' — split on the first only.
    const envMap = new Map(
      env.map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
    )
    expect(envMap.get('MCP_PROXY_ARGS')).toBe('--host=0.0.0.0 --port=19222')
    expect(envMap.get('CHROME_DEVTOOLS_MCP_ARGS')).toBe('--browser-url=http://localhost:9222')

    const labels = JSON.parse(await inspect(labelsFormat, imageId)) as Record<string, string>
    // The pinned upstream versions, asserted as literals so a Dockerfile
    // refactor cannot silently change what gets shipped.
    const pinLabelPrefix = 'io.github.andrielson.chrome-devtools-mcp-proxy.'
    expect(labels[`${pinLabelPrefix}node-image-tag`]).toBe('24.21.0-alpine3.24')
    expect(labels[`${pinLabelPrefix}uv-image-tag`]).toBe('0.13.0')
    expect(labels[`${pinLabelPrefix}chrome-devtools-mcp-version`]).toBe('1.10.1')
    expect(labels[`${pinLabelPrefix}mcp-proxy-version`]).toBe('0.13.0')
    expect(labels[`${pinLabelPrefix}python-version`]).toBe('3.15')
  }, 30_000)

  test("a run-time environment override reaches the running process's argv", async () => {
    // A one-off of the mcp service with MCP_PROXY_ARGS overridden: the
    // entrypoint parses the value with shell-like quoting and execs
    // mcp-proxy as PID 1, so the env-injected words — including the quoted
    // value with spaces as ONE argv word — must appear in /proc/1/cmdline.
    // This validates the documented configuration mechanism end to end
    // (Compose env → image ENV override → entrypoint quoting → exec) without
    // driving any MCP session. mcp-proxy spawns its stdio child eagerly and
    // exits when it dies, so this one-off does need Chrome answering on the
    // shared loopback — which the up-and-running fixture stack provides.
    const oneOff = `${project}-env-override`
    const envSetting =
      "MCP_PROXY_ARGS=--host=0.0.0.0 --port=19229 --env CONTAINER_TEST_MARKER 'env override value with spaces'"
    try {
      // Defensive removal of a crashed predecessor's one-off.
      await $`docker rm --force --volumes ${oneOff}`.nothrow().quiet()
      await $`${compose} run --detach --no-deps --name ${oneOff} --env ${envSetting} mcp`.quiet()

      // PID 1 is the entrypoint shell for a moment, then the exec'd command
      // takes over. mcp-proxy is a uv-installed Python script, so the exec'd
      // PID 1 is its interpreter with the script path ahead of our words —
      // poll until the marker word appears in /proc/1/cmdline (it can only
      // exist post-exec) or the one-off dies.
      const marker = 'env override value with spaces'
      const argv = await pollUntil(
        async () => {
          const running = (await $`docker inspect --format ${runningFormat} ${oneOff}`.quiet().nothrow().text()).trim()
          if (running !== 'true') {
            const logs = await $`docker logs ${oneOff}`.quiet().nothrow().text()
            throw new Error(`the env-override one-off exited; its docker logs:\n${logs}`)
          }
          const cmdline = await $`docker exec ${oneOff} cat /proc/1/cmdline`.quiet().nothrow().text()
          const words = cmdline.replace(/\0+$/, '').split('\0')
          return words.includes(marker) ? words : undefined
        },
        30_000,
        250,
        async () =>
          new Error(
            `the exec'd command never took over PID 1 within 30 s; its docker logs:\n${await $`docker logs ${oneOff}`.quiet().nothrow().text()}`,
          ),
      )
      // The launcher words ahead of the assembled command (the uv-managed
      // Python interpreter plus the mcp-proxy script path) are packaging
      // detail; the contract is everything from mcp-proxy's flags onward —
      // including the quoted marker as ONE argv word, which is what proves
      // the entrypoint's quote parsing survived into the live process.
      const expectedInvocation = [
        '--host=0.0.0.0',
        '--port=19229',
        '--env',
        'CONTAINER_TEST_MARKER',
        marker,
        '--',
        'chrome-devtools-mcp',
        // CHROME_DEVTOOLS_MCP_ARGS was not overridden — the image default.
        '--browser-url=http://localhost:9222',
      ]
      expect(argv.slice(0, -expectedInvocation.length).at(-1)).toMatch(/mcp-proxy$/)
      expect(argv.slice(-expectedInvocation.length)).toEqual(expectedInvocation)
    } finally {
      // Never-throw teardown: a failed assertion must still remove the one-off.
      await $`docker rm --force --volumes ${oneOff}`.nothrow().quiet()
    }
  }, 60_000)

  test("mcp-proxy's /status answers with the stack up", async () => {
    // The proxy's port is published ephemerally on the chrome service (the
    // netns owner) — resolve it at runtime via `compose port`, never assume
    // a host port: concurrent worktrees never collide.
    const published = (await $`${compose} port chrome 19222`.quiet().text()).trim()
    const port = Number(published.split(':').pop())
    // Greater-than-zero, not isInteger: Number('') is 0 — an integer — so the
    // empty-output case must fail here rather than sail through.
    expect(port).toBeGreaterThan(0)

    // The HTTP probe itself runs on the loopback inside the shared network
    // namespace (busybox wget — the Alpine base has no curl, and BusyBox
    // utilities take short flags only). The assertion is mcp-proxy's
    // answering with the stack up, and the in-netns probe holds wherever
    // the daemon happens to publish (rootless daemons, remote sockets, CI).
    // `up --wait` gates on the container running, not on the HTTP listener,
    // so poll until /status answers.
    const containerId = await mcpContainerIdOf()
    const status = await pollUntil(
      async () => {
        const body = await $`docker exec ${containerId} wget -q -O - http://127.0.0.1:19222/status`
          .quiet()
          .nothrow()
          .text()
        try {
          return JSON.parse(body) as Record<string, unknown>
        } catch {
          return undefined // not answering (yet) — keep polling
        }
      },
      30_000,
      500,
      async () =>
        new Error(
          `/status did not answer within 30 s; the mcp service's docker logs:\n${await $`docker logs ${containerId}`.quiet().nothrow().text()}`,
        ),
    )
    // Structural, not exact: the values vary with traffic and sessions.
    expect(Object.keys(status)).toEqual(
      expect.arrayContaining(['api_last_activity', 'active_sse_connections', 'server_instances']),
    )
  }, 60_000)
})
