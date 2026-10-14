// Unit suite for the Compose project identity helper
// (tests/helpers/compose-project.ts), run without Docker. The identity is a
// per-worktree project name recorded in tests/.env — compose's own
// project-directory env file, so manual invocations without --project-name
// aim at the same project — and the read/validate/self-heal contract around
// that record is checkable with plain files: each test stands in a throwaway
// directory for tests/.env. The record is an identity, not a lock: every run
// of this worktree resolves the same project name, which is what lets the
// next run's defensive teardown clean up a crashed predecessor while
// concurrent worktrees never fight over one stack.
import { afterAll, describe, expect, test } from 'bun:test'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveComposeProject } from '../helpers/compose-project'

describe('compose project identity', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  // A stand-in tests/.env: a fresh throwaway directory per test, so tests
  // stay independent of each other's records.
  const freshEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-devtools-mcp-proxy-compose-project-'))
    dirs.push(dir)
    return join(dir, '.env')
  }

  test('a missing record generates and persists a valid identity', () => {
    const envPath = freshEnv()
    const project = resolveComposeProject(envPath)
    expect(project).toMatch(/^chrome-devtools-mcp-proxy-tests-[0-9a-f]{8}$/)
    expect(readFileSync(envPath, 'utf8')).toBe(`COMPOSE_PROJECT_NAME=${project}\n`)
  })

  test('a valid record is reused verbatim', () => {
    const envPath = freshEnv()
    const first = resolveComposeProject(envPath)
    expect(resolveComposeProject(envPath)).toBe(first)
    expect(readFileSync(envPath, 'utf8')).toBe(`COMPOSE_PROJECT_NAME=${first}\n`)
  })

  // A hand-edit that drops the trailing newline is still the same record:
  // the value is what matters, not the file's last byte.
  test('a record without a trailing newline is still reused', () => {
    const envPath = freshEnv()
    writeFileSync(envPath, 'COMPOSE_PROJECT_NAME=chrome-devtools-mcp-proxy-tests-1a2b3c4d')
    expect(resolveComposeProject(envPath)).toBe('chrome-devtools-mcp-proxy-tests-1a2b3c4d')
  })

  // The record is single-purpose: anything that is not exactly one valid
  // line is overwritten with a fresh identity (self-heal) rather than
  // trusted or rejected — a corrupt record's worst case is one orphaned
  // project, and blocking the suite on trivia would be worse.
  test.each([
    'COMPOSE_PROJECT_NAME=tests\n',
    '',
    'COMPOSE_PROJECT_NAME=chrome-devtools-mcp-proxy-tests-1a2b3c4d\nEXTRA=1\n',
    'COMPOSE_PROJECT_NAME=1a2b3c4d\n',
    'COMPOSE_PROJECT_NAME=chrome-devtools-mcp-proxy-tests-1A2B3C4D\n',
  ])('self-heals %j into a valid record', (content) => {
    const envPath = freshEnv()
    writeFileSync(envPath, content)
    const project = resolveComposeProject(envPath)
    expect(project).toMatch(/^chrome-devtools-mcp-proxy-tests-[0-9a-f]{8}$/)
    expect(readFileSync(envPath, 'utf8')).toBe(`COMPOSE_PROJECT_NAME=${project}\n`)
  })

  // The property parallel worktrees rely on: independent records draw
  // independent identities (collision odds at 32 bits are ~n²/2³³ — noise).
  test('two fresh records draw different identities', () => {
    expect(resolveComposeProject(freshEnv())).not.toBe(resolveComposeProject(freshEnv()))
  })
})
