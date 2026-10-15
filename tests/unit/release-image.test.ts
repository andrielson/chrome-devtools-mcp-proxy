// Unit suite for the release build script (scripts/release-image.sh): the
// version-to-buildx contract, exercised without a registry. The real script
// runs under `sh` with a stub `docker` executable first on PATH (the
// PATH-shim technique): the script `exec`s `docker`, so the stub's captured
// argv is the exact command line semantic-release's exec plugin will run in
// the release job.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'release-image.sh')
const repositoryRoot = join(import.meta.dir, '..', '..')

const image = 'ghcr.io/andrielson/chrome-devtools-mcp-proxy'

let stubDir: string

// The script execs `docker`, resolved via PATH. The stub prints its own PID
// (line 1 of stdout — proving exec replaced the shell, since the process
// identity is unchanged) and then one line per argv word, each prefixed with
// ':' so a flag value is a visible ':value' line rather than blank-looking
// text.
beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'release-image-test-'))
  const dockerStub = join(stubDir, 'docker')
  writeFileSync(dockerStub, '#!/bin/sh\nprintf \'%s\\n\' "$$"\nprintf \':%s\\n\' "$@"\n')
  chmodSync(dockerStub, 0o755)
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

function runScript(versionArguments: string[]): RunResult {
  const result = Bun.spawnSync({
    cmd: ['sh', scriptPath, ...versionArguments],
    env: {
      PATH: [stubDir, process.env.PATH].filter(Boolean).join(':'),
    },
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

// The argv words the exec'd docker received: stdout line 1 is the stub's
// PID, the rest are ':'-prefixed argv words (docker's own name excluded).
function argvWords(result: RunResult): string[] {
  return result.stdoutLines.slice(1).map((line) => line.slice(1))
}

describe('release-image.sh version-to-buildx contract', () => {
  test('a bare X.Y.Z version builds and pushes vX.Y.Z + latest with the decided mechanics', () => {
    const result = runScript(['1.2.3'])
    expect(result.exitCode).toBe(0)
    expect(argvWords(result)).toEqual([
      'buildx',
      'build',
      '--push',
      '--pull',
      '--platform',
      'linux/amd64',
      '--tag',
      `${image}:v1.2.3`,
      '--tag',
      `${image}:latest`,
      '--label',
      'org.opencontainers.image.version=1.2.3',
      '--label',
      'org.opencontainers.image.source=https://github.com/andrielson/chrome-devtools-mcp-proxy',
      '--cache-from',
      `type=registry,ref=${image}:buildcache`,
      '--cache-to',
      `type=registry,ref=${image}:buildcache,mode=max`,
      '--cache-to',
      'type=inline',
      join(repositoryRoot, 'src'),
    ])
  })

  test('exec replaces the shell: docker runs as the script process itself', () => {
    const result = runScript(['1.2.3'])
    expect(result.exitCode).toBe(0)
    // Line 1 of stdout is the stub's own PID; it must equal the PID of the
    // `sh` this test spawned. Had the script forked docker instead of exec'ing
    // it, the stub would be a child with a different PID — and a failed build's
    // exit code would reach semantic-release through a shell, not directly.
    expect(result.stdoutLines[0]).toBe(String(result.pid))
  })

  test('a v-prefixed version exits 64 without invoking docker', () => {
    const result = runScript(['v1.2.3'])
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('bare X.Y.Z')
    expect(result.stdoutLines).toEqual([])
  })

  test('a version with the wrong number of segments exits 64 without invoking docker', () => {
    const result = runScript(['1.2'])
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('bare X.Y.Z')
    expect(result.stdoutLines).toEqual([])
  })

  test('a version with an empty segment exits 64 without invoking docker', () => {
    const result = runScript(['1..2'])
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('bare X.Y.Z')
    expect(result.stdoutLines).toEqual([])
  })

  test('a prerelease-suffixed version exits 64 without invoking docker', () => {
    const result = runScript(['1.2.3-rc.1'])
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('bare X.Y.Z')
    expect(result.stdoutLines).toEqual([])
  })

  test('a missing version argument exits 64 with usage', () => {
    const result = runScript([])
    expect(result.exitCode).toBe(64)
    expect(result.stderrText).toContain('usage:')
    expect(result.stdoutLines).toEqual([])
  })
})
