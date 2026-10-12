// Post-checkout hook: keep node_modules fresh after a checkout. Unconditional
// because a no-op `bun install` is sub-second, and file checkouts (e.g.
// `git checkout <commit> -- <path>`) can also restore dependency manifests
// from another commit.
// Husky runs the extensionless shell shim `post-checkout`, which delegates
// here.
import { $ } from 'bun'

const install = await $`bun install`.nothrow()
process.exit(install.exitCode)
