// Unit suite for the commitlint configuration (commitlint.config.js): the
// PR-title gate the hygiene job applies. Squash merges make the PR title the
// commit, and the commit is what semantic-release analyzes — a non-
// conventional title silently releases nothing. This pins the config the CI
// step leans on, by running the locally installed @commitlint/cli under Bun
// (no network, no git history: --edit reads the message from a file).
import { describe, expect, test } from 'bun:test'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repositoryRoot = join(import.meta.dir, '..', '..')
const commitlintCli = join(repositoryRoot, 'node_modules', '@commitlint', 'cli', 'cli.js')

// What the hygiene job's `printf '%s\n' "${PR_TITLE}" | bunx commitlint` sees
// for one pull request title.
function lintTitle(title: string): { exitCode: number | null; outputText: string } {
  const messageFile = join(mkdtempSync(join(tmpdir(), 'commitlint-test-')), 'title')
  writeFileSync(messageFile, `${title}\n`)
  const result = Bun.spawnSync({
    cmd: ['bun', commitlintCli, '--edit', messageFile],
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const outputText = `${result.stdout.toString()}${result.stderr.toString()}`
  rmSync(join(messageFile, '..'), { force: true, recursive: true })
  return { exitCode: result.exitCode, outputText }
}

describe('commitlint PR-title gate', () => {
  test('a conventional title passes', () => {
    const result = lintTitle('feat: wire semantic-release')
    expect(result.exitCode).toBe(0)
  })

  test('a conventional title with scope and breaking bang passes', () => {
    const result = lintTitle('fix(proxy)!: change the HTTP surface')
    expect(result.exitCode).toBe(0)
  })

  test('a plain-English title fails (it would silently release nothing)', () => {
    const result = lintTitle('Wire semantic-release and friends')
    expect(result.exitCode).not.toBe(0)
    expect(result.outputText).toContain('type-empty')
    expect(result.outputText).toContain('subject-empty')
  })

  test('a wrong commit type fails', () => {
    const result = lintTitle('feature: wire semantic-release')
    expect(result.exitCode).not.toBe(0)
    expect(result.outputText).toContain('type-enum')
  })
})
