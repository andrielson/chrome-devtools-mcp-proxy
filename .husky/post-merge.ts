// Post-merge hook: keep node_modules fresh after a merge or pull, since
// merged changes may update the lockfile; `bun install` is idempotent when
// they did not.
// Husky runs the extensionless shell shim `post-merge`, which delegates here.
import { $ } from 'bun'

const install = await $`bun install`.nothrow()
process.exit(install.exitCode)
