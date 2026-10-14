// Unit suite for the image entrypoint (src/docker-entrypoint.sh): the
// env-to-argv contract, exercised without Docker. The real script runs under
// `sh` with stub `mcp-proxy` / `chrome-devtools-mcp` executables first on
// PATH (the PATH-shim technique): the entrypoint `exec`s `mcp-proxy`, so the
// stub's captured argv is the final command line.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entrypointPath = join(import.meta.dir, '..', '..', 'src', 'docker-entrypoint.sh')

let stubDir: string

// The entrypoint execs `mcp-proxy`, resolved via PATH. The stub prints its
// own PID (line 2 of stdout — proving exec replaced the shell, since the
// process identity is unchanged) and then one line per argv word, each
// prefixed with ':' so an empty word is a visible ':' line rather than an
// indistinguishable blank. chrome-devtools-mcp is never supposed to run (it
// is an argument to mcp-proxy, not something the entrypoint spawns); its
// stub exists so any unexpected execution becomes loud output.
beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'docker-entrypoint-test-'))
  const mcpProxyStub = join(stubDir, 'mcp-proxy')
  writeFileSync(mcpProxyStub, '#!/bin/sh\nprintf \'%s\\n\' "$$"\nprintf \':%s\\n\' "$@"\n')
  chmodSync(mcpProxyStub, 0o755)
  const chromeDevtoolsMcpStub = join(stubDir, 'chrome-devtools-mcp')
  writeFileSync(chromeDevtoolsMcpStub, '#!/bin/sh\nprintf \'unexpected-exec:%s\\n\' "$@"\n')
  chmodSync(chromeDevtoolsMcpStub, 0o755)
})

afterAll(() => {
  rmSync(stubDir, { force: true, recursive: true })
})

interface RunResult {
  exitCode: number | null
  pid: number
  stdoutLines: string[]
  stderrText: string
}

function runEntrypoint(env: { MCP_PROXY_ARGS?: string; CHROME_DEVTOOLS_MCP_ARGS?: string }): RunResult {
  const childEnv: Record<string, string> = {
    PATH: [stubDir, process.env.PATH].filter(Boolean).join(':'),
  }
  for (const [key, value] of Object.entries(env)) {
    childEnv[key] = value
  }
  const result = Bun.spawnSync({
    cmd: ['sh', entrypointPath],
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    pid: result.pid,
    stdoutLines: result.stdout
      .toString()
      .split('\n')
      .filter((line) => line !== ''),
    stderrText: result.stderr.toString(),
  }
}

// The argv words the exec'd mcp-proxy received: stdout line 1 is the startup
// log, line 2 the stub's PID, the rest are ':'-prefixed argv words.
function argvWords(result: RunResult): string[] {
  return result.stdoutLines.slice(2).map((line) => line.slice(1))
}

describe('docker-entrypoint.sh env-to-argv contract', () => {
  test('image defaults pass through verbatim', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '--host=0.0.0.0 --port=19222',
      CHROME_DEVTOOLS_MCP_ARGS: '--browser-url=http://localhost:9222',
    })
    expect(result.exitCode).toBe(0)
    expect(argvWords(result)).toEqual([
      '--host=0.0.0.0',
      '--port=19222',
      '--',
      'chrome-devtools-mcp',
      '--browser-url=http://localhost:9222',
    ])
  })

  test('runs of spaces and tabs separate words; a newline outside quotes separates too', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '  --a\t\t--b \n --c  ',
      CHROME_DEVTOOLS_MCP_ARGS: '',
    })
    expect(argvWords(result)).toEqual(['--a', '--b', '--c', '--', 'chrome-devtools-mcp'])
  })

  test('double-quoted value keeps its spaces as one word', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '--flag="value with spaces"',
      CHROME_DEVTOOLS_MCP_ARGS: '',
    })
    expect(argvWords(result)).toEqual(['--flag=value with spaces', '--', 'chrome-devtools-mcp'])
  })

  test('single-quoted JSON is fully literal, backslashes included', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '',
      CHROME_DEVTOOLS_MCP_ARGS: `--wsHeaders='{"Authorization":"Bearer xyz"}' --note='a\\nb'`,
    })
    expect(argvWords(result)).toEqual([
      '--',
      'chrome-devtools-mcp',
      '--wsHeaders={"Authorization":"Bearer xyz"}',
      '--note=a\\nb',
    ])
  })

  test('two-word flags (--headers KEY "VALUE") keep the value as one word', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '--headers Authorization "Bearer xyz"',
      CHROME_DEVTOOLS_MCP_ARGS: '',
    })
    expect(argvWords(result)).toEqual(['--headers', 'Authorization', 'Bearer xyz', '--', 'chrome-devtools-mcp'])
  })

  test('empty argument strings yield the bare proxy command', () => {
    const result = runEntrypoint({ MCP_PROXY_ARGS: '', CHROME_DEVTOOLS_MCP_ARGS: '' })
    expect(result.exitCode).toBe(0)
    expect(argvWords(result)).toEqual(['--', 'chrome-devtools-mcp'])
  })

  test('an explicitly empty quoted word is preserved, including as the last word', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: "--flag '' ''",
      CHROME_DEVTOOLS_MCP_ARGS: "--other ''",
    })
    expect(argvWords(result)).toEqual(['--flag', '', '', '--', 'chrome-devtools-mcp', '--other', ''])
  })

  test('glob characters are never expanded', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '--pattern=* --mark=?',
      CHROME_DEVTOOLS_MCP_ARGS: '',
    })
    expect(argvWords(result)).toEqual(['--pattern=*', '--mark=?', '--', 'chrome-devtools-mcp'])
  })

  test('shell substitutions are literal text, never executed', () => {
    const sentinel = join(stubDir, 'pwned')
    const result = runEntrypoint({
      MCP_PROXY_ARGS: `$HOME $(touch ${sentinel}) \`id\``,
      CHROME_DEVTOOLS_MCP_ARGS: "'$(echo boom)'",
    })
    expect(result.exitCode).toBe(0)
    // Unquoted literal text still splits on spaces — that is the contract:
    // `$(...)` is text, not a substitution, so `$(touch /path)` is two words.
    // Quoted, it stays one word. Either way nothing is executed.
    expect(argvWords(result)).toEqual([
      '$HOME',
      '$(touch',
      `${sentinel})`,
      '`id`',
      '--',
      'chrome-devtools-mcp',
      '$(echo boom)',
    ])
    expect(existsSync(sentinel)).toBe(false)
  })

  test('backslash escapes the next character outside quotes; lone trailing backslash is literal', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '--path=a\\ b --win=C:\\\\temp --trailing=xyz\\',
      CHROME_DEVTOOLS_MCP_ARGS: '--name="say \\"hi\\"" --json="{\\"k\\": \\"v\\"}"',
    })
    expect(argvWords(result)).toEqual([
      '--path=a b',
      '--win=C:\\temp',
      '--trailing=xyz\\',
      '--',
      'chrome-devtools-mcp',
      '--name=say "hi"',
      '--json={"k": "v"}',
    ])
  })

  test('unterminated quote exits 64 naming the variable', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: "--port=19222'",
      CHROME_DEVTOOLS_MCP_ARGS: '',
    })
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('MCP_PROXY_ARGS')
    expect(result.stderrText).toContain('unterminated quote')
    expect(result.stdoutLines).toEqual([])
  })

  test('a raw newline inside quotes exits 64 naming the variable', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '',
      CHROME_DEVTOOLS_MCP_ARGS: "--flag='two\nwords'",
    })
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('CHROME_DEVTOOLS_MCP_ARGS')
    expect(result.stderrText).toContain('unterminated quote')
  })

  test('an unset variable exits 1 with a pointer at the ENV defaults', () => {
    const result = runEntrypoint({ MCP_PROXY_ARGS: '--port=19222' })
    expect(result.exitCode).toBe(1)
    expect(result.stderrText).toContain('MCP_PROXY_ARGS and CHROME_DEVTOOLS_MCP_ARGS must both be set')
    expect(result.stdoutLines).toEqual([])
  })

  test('the assembled command is logged to stdout as one line before exec', () => {
    const result = runEntrypoint({
      MCP_PROXY_ARGS: '--port=19222',
      CHROME_DEVTOOLS_MCP_ARGS: '--browser-url=http://localhost:9222',
    })
    expect(result.stdoutLines[0]).toBe(
      "docker-entrypoint: exec: 'mcp-proxy' '--port=19222' '--' 'chrome-devtools-mcp' '--browser-url=http://localhost:9222'",
    )
    // Everything after the log line is the exec'd process's own output.
    expect(result.stdoutLines.length).toBe(1 + 1 + 4)
  })

  test('exec replaces the shell: mcp-proxy runs as the entrypoint process itself', () => {
    const result = runEntrypoint({ MCP_PROXY_ARGS: '', CHROME_DEVTOOLS_MCP_ARGS: '' })
    expect(result.exitCode).toBe(0)
    // Line 2 of stdout is the stub's own PID; it must equal the PID of the
    // `sh` this test spawned. Had the entrypoint forked mcp-proxy instead of
    // exec'ing it, the stub would be a child with a different PID — and in
    // the container, mcp-proxy would not be PID 1 receiving SIGTERM from
    // `docker stop` directly.
    expect(result.stdoutLines[1]).toBe(String(result.pid))
  })
})
