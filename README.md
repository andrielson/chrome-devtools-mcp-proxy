# chrome-devtools-mcp-proxy

A Docker image — `src/Dockerfile` — that exposes
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(a stdio MCP server) over HTTP via
[mcp-proxy](https://github.com/sparfenyuk/mcp-proxy), always connecting to
an external Chrome over CDP. The image is transport glue, not a browser
host: it contains no Chrome of its own.

Every upstream artifact is pinned to an exact version as a Dockerfile `ARG`
and surfaced as an `io.github.andrielson.chrome-devtools-mcp-proxy.*` OCI
label (`docker inspect` audits them). Two environment variables configure
the final command at run time — `MCP_PROXY_ARGS` (default
`--host=0.0.0.0 --port=19222`) and `CHROME_DEVTOOLS_MCP_ARGS` (default
`--browser-url=http://localhost:9222`) — parsed with shell-like quoting by
the POSIX entrypoint (`src/docker-entrypoint.sh`), which logs the assembled
command as one line and `exec`s mcp-proxy as PID 1. Note that the startup
log puts argument values into `docker logs`.

The repository tooling is built on the `bun init` template distilled from
[rtx-workspace](https://github.com/andrielson/rtx-workspace): the quality
tooling, git hooks and agent tooling are prewired.

## Prerequisites

- **Bun** (1.4+) — runs the scripts, the test suite and the git hooks.
- **ShellCheck** (0.10+) — shell linting (`lint:sh` and the pre-commit
  gate). Shell _formatting_ needs no host binary: it goes through Prettier
  and `prettier-plugin-sh`.
- **Docker** — for building and running the image. `bun test` stays green
  without it: the container suite and the e2e smoke skip with a visible
  notice, and the unit suites never need it. The e2e smoke additionally needs
  outbound internet (it loads the real developers.chrome.com page through the
  whole chain) and skips just as visibly without it.

## Getting started

Use this repository as a template on GitHub ("Use this template"), clone
the result, then:

```bash
bun install
```

`bun install` also activates the git hooks: the `prepare` lifecycle script
points `core.hooksPath` at `.husky/_`, so a fresh clone needs zero manual
setup.

## Commands

| Command                | What it does                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install`          | Install dependencies (and activate the git hooks)                                                                                                                                                                                                                                                                                                                                                  |
| `bun run lint`         | Biome check (TS family)                                                                                                                                                                                                                                                                                                                                                                            |
| `bun run lint:fix`     | Biome check with auto-fix                                                                                                                                                                                                                                                                                                                                                                          |
| `bun run lint:sh`      | ShellCheck over the tracked shell scripts                                                                                                                                                                                                                                                                                                                                                          |
| `bun run lint:compose` | Validate the fixture Compose file (`docker compose config --quiet` — client-side, no daemon)                                                                                                                                                                                                                                                                                                       |
| `bun run format`       | Prettier write (markdown/YAML/shell/Dockerfile)                                                                                                                                                                                                                                                                                                                                                    |
| `bun run format:check` | Prettier check, no changes applied                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run typecheck`    | `tsc --noEmit`                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun test`             | Run the test suite ([Bun's test runner](https://bun.com/docs/test-writer) is built in) — unit suites (no Docker), the container suite (`tests/container/`, Docker + Compose) and the e2e smoke (`tests/e2e/`, Docker + outbound internet: one real MCP session through client → mcp-proxy → chrome-devtools-mcp → Chrome). The Docker-dependent suites skip with a visible notice rather than fail |
| `bun build <entry>`    | Bundle an entrypoint (`.ts`, `.html`, `.css`)                                                                                                                                                                                                                                                                                                                                                      |

## Lint, formatting and type checking

Formatting is split between two tools with strict ownership — they never
touch the same file:

- **Biome** owns the TS family (`ts`, `tsx`, `js`, `jsx`, `json`, `jsonc`):
  lint, formatting and import organization, configured in `biome.json`.
- **Prettier** owns markdown, YAML, shell and Dockerfile, configured in
  `.prettierrc` with `prettier-plugin-sh` (which embeds shfmt's engine for
  shell). `.prettierignore` excludes the Biome-owned extensions so a
  repo-wide Prettier run never crosses the boundary.

`.shellcheckrc` holds the ShellCheck policy (bash dialect, optional rules
enabled, known-noise codes disabled). `lint:sh` targets every tracked
shell script (`git ls-files`), currently the image entrypoint
(`src/docker-entrypoint.sh`), whose POSIX-sh constructs carry inline,
documented `# shellcheck disable=` comments.

## Git hooks (Husky)

Hooks run through [Husky](https://typicode.github.io/husky/) and activate
themselves (see [Getting started](#getting-started)). Hook logic is
TypeScript executed by Bun; each extensionless hook under `.husky/` is a
minimal shell shim delegating to its sibling `.ts` implementation — the
same files `lint` and `typecheck` cover.

- `pre-commit` — lint-staged runs the fixers on staged files and re-stages
  what changed (Biome on the TS family, Prettier on its own types,
  configured in `.lintstagedrc.json`); then the blocking gates: ShellCheck
  on staged shell files, and the full type check.
- `post-checkout` / `post-merge` — rerun `bun install` so `node_modules`
  never goes stale after a checkout, merge or pull.

Escape hatches for emergencies: `git commit --no-verify` skips the hook
once, and `HUSKY=0` disables Husky entirely (e.g. `HUSKY=0 bun install`
skips hook activation).

VS Code is preconfigured (`.vscode/`, `.editorconfig`) to format on save
with the same tools as the hooks: Biome for the TS family, the Prettier
extension for markdown, YAML, shell and Dockerfile.

## Continuous integration

One workflow — `.github/workflows/ci.yml` — with three jobs:

- **Changed paths** — diffs the event's range into boolean gates consumed by
  the other jobs' `if:` conditions. There is deliberately no workflow-level
  `paths` filter: a path-skipped workflow never reports its checks, and
  branch protection requires them; a job skipped by `if:` still reports.
- **Hygiene** — Bun (version from `packageManager`),
  `bun install --frozen-lockfile`, ShellCheck v0.10 (upstream tarball — apt
  ships an older minor), then `lint`, `format:check`, `typecheck`,
  `lint:sh` and `lint:compose`. Runs whenever the diff touches `src`,
  `tests`, the workflow, `package.json`, `bun.lock` or the repo-config
  group (Husky hooks, Biome, tsconfig, Prettier, ShellCheck, lint-staged) —
  a config-only PR must not skip typecheck.
- **Test suite** — plain GitHub-hosted `ubuntu-latest` runners; bare
  `bun test` (the suites build the image themselves through the fixture —
  CI has no separate build step). Draft PRs skip it and
  `ready_for_review` re-triggers it; merges to `main` skip it (the PR-only
  flow is enforced by branch protection). The daemon build cache is warmed
  from the published image first, and a failed suite gets exactly one
  full-suite retry — the e2e smoke loads a real site, so a vendor hiccup
  deserves a second chance that a real regression will not survive.

## Agent tooling

The template ships coding-agent tooling alongside the code:

- **DeepWiki MCP** — `.mcp.json` declares the `deepwiki` MCP server
  (`https://mcp.deepwiki.com/mcp`), a free, no-authentication service that
  answers questions about public GitHub repositories from AI-generated
  documentation. The `deepwiki` skill in `.claude/skills/` describes when
  and how to use it.
- **Agent workflows** — `docs/agents/` holds the workflows for coding
  agents (issue tracker via `gh`, triage labels, domain docs); start at
  `CLAUDE.md`.
- **mattpocock-skills plugin** — `.claude/settings.json` enables the
  `mattpocock-skills` Claude Code plugin, which provides the engineering
  skills those workflow docs refer to.

## Conventions

- All repository content is written in English.
- Commands use long options wherever the tool provides them.
- Compose files use the long syntax for volumes and ports.
- Formatting is split with strict ownership (see
  [Lint, formatting and type checking](#lint-formatting-and-type-checking)).

The full list, including Bun-over-Node preferences and shell quoting rules,
lives in `CLAUDE.md`.
