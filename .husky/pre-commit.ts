// Pre-commit hook: run the lint-staged fixers (Biome on the TS family,
// Prettier on markdown/yaml/shell/Dockerfile), then the blocking gates:
// ShellCheck on staged shell files and the full type check.
// Husky runs the extensionless shell shim `pre-commit`, which delegates here.
// To skip it in an emergency: `git commit --no-verify`.
import { $ } from 'bun'

const stagedFiles = async (...pathspecs: string[]): Promise<string[]> => {
  // Bun Shell interpolates each array element as its own escaped argument,
  // so filenames with whitespace are safe here.
  const listing = await $`git diff --cached --name-only --diff-filter=ACMR -- ${pathspecs}`.quiet().nothrow().text()
  return listing.split('\n').filter((file) => file.length > 0)
}

// Fixers first, as a single lint-staged invocation: it applies the fixes and
// re-stages whatever changed. The blocking verifiers below deliberately stay
// in this script instead of the lint-staged config, because lint-staged runs
// glob groups concurrently and a checker racing a writer on the same file is
// not deterministic.
const lintStaged = await $`bunx lint-staged`.nothrow()
if (lintStaged.exitCode !== 0) {
  console.error('pre-commit: lint-staged found unfixable issues. Fix the reported errors, then try again.')
  process.exit(1)
}

const shellFiles = await stagedFiles('*.sh', '*.bash')

if (shellFiles.length > 0) {
  const shellcheck = await $`shellcheck ${shellFiles}`.nothrow()
  if (shellcheck.exitCode !== 0) {
    console.error("pre-commit: ShellCheck found issues. Run 'bun run lint:sh' for the full report.")
    process.exit(1)
  }
}

const typecheck = await $`bun run typecheck`.nothrow()
if (typecheck.exitCode !== 0) {
  console.error("pre-commit: type checking failed. Run 'bun run typecheck' for details.")
  process.exit(1)
}
