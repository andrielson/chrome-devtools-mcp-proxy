import { readFileSync, writeFileSync } from 'node:fs'

// The fixture stack's per-worktree Compose identity. The project name every
// Docker-global resource of a suite run derives from is recorded in the
// Compose project directory's .env (tests/.env, gitignored via the nested
// tests/.gitignore), which Compose itself loads — so manual invocations
// without --project-name aim at the same project. The suites pass
// --project-name explicitly anyway: the flag outranks both the shell
// environment and .env, so a stray exported COMPOSE_PROJECT_NAME cannot
// hijack a run.
export const resolveComposeProject = (envPath: string): string => {
  // A missing or unreadable record is simply a fresh identity.
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    content = ''
  }
  const recorded = /^COMPOSE_PROJECT_NAME=(chrome-devtools-mcp-proxy-tests-[0-9a-f]{8})\n?$/.exec(content)?.[1]
  if (recorded) return recorded

  // 32 random bits as exactly eight lowercase hex chars.
  const [value = 0] = crypto.getRandomValues(new Uint32Array(1))
  const project = `chrome-devtools-mcp-proxy-tests-${value.toString(16).padStart(8, '0')}`
  writeFileSync(envPath, `COMPOSE_PROJECT_NAME=${project}\n`)
  return project
}
