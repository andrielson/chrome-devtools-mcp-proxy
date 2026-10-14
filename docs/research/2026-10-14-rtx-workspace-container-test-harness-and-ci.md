# Research: rtx-workspace container-test harness and CI/GHCR patterns

Date: 2026-10-14. Ticket: [#2](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/2).
Wayfinder map context: issue #1 rules that "test fixtures follow rtx-workspace
patterns" and "CI + GHCR publishing … are in scope, modeled on rtx-workspace" —
this file supplies the facts behind those rulings. This repo currently has
`src/Dockerfile` (the image is the product), no `tests/` and no
`.github/workflows/`; rtx-workspace has the same shape (image product,
`src/Dockerfile`) with a mature harness.

All findings below are read from the primary source — the repository
`andrielson/rtx-workspace` at `main` = `cb2e59c65d32d566812b2734b0540160269596bb`
(via `gh api` file reads; DeepWiki has no index for this repo). Cited files:

- `tests/docker-compose.yml`, `tests/Dockerfile.nginx`, `tests/.env.service.test.example`,
  `tests/.gitignore`, tracked symlink `tests/src` → `../src` (mode 120000)
- `tests/compose-project.ts`, `tests/compose-project.test.ts`, `tests/docker.test.ts`,
  `tests/env-loader.test.ts`, `tests/user-install.test.ts`
- `.github/workflows/ci.yml`, `package.json`, `.husky/pre-push.ts`
- ADRs: `docs/adr/0004-baked-nginx-bootstrap-script-for-tests-stack.md`,
  `0005-tests-stack-ssh-on-all-interfaces.md`,
  `0007-standalone-tests-compose-symlink-context.md`,
  `0008-ci-gates-and-ghcr-releases.md`,
  `0010-per-worktree-tests-stack-identity.md`

## (a) Container-test harness with Bun

### Suite and file layout

`tests/` holds four suites plus the fixture, all run by plain `bun test`
(there is no `test` script in `package.json`):

| File                            | Kind                                                                                                       | Needs Docker? |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| `tests/compose-project.test.ts` | unit tests of the identity helper                                                                          | no            |
| `tests/env-loader.test.ts`      | sources `src/01-home-bash-env.sh` in a sandbox home under fresh `bash`                                     | no            |
| `tests/user-install.test.ts`    | lifts helpers out of the bootstrap script by regex; `Bun.serve` loopback-TLS stand-in for vendor endpoints | no            |
| `tests/docker.test.ts`          | the container suite: image contract + first-boot end-to-end                                                | yes           |

The split is deliberate: everything checkable without Docker lives in its own
file, so the Docker suite is the only part that builds images. The two
script-level suites show the pattern for testing shell wiring without a
container: throwaway `mkdtempSync` home, `bash -c` sourced execution with
runner env stripped child-side, and `Bun.serve({ tls })` as a fake HTTPS
endpoint driven by the real `curl` wrapper.

### The Compose fixture

`tests/docker-compose.yml` is a **standalone** file — every service declared
in full, no `extends:` layering (ADR 0007). Both services build from one
context: `context: src`, resolved through the tracked symlink `tests/src` →
`../src`, so the uploaded tree is exactly what a plain build from `src/` sends.
The second fixture Dockerfile (`tests/Dockerfile.nginx`) stays in `tests/`,
outside the context, referenced as `dockerfile: ../Dockerfile.nginx` — every
builder supports that because the Dockerfile travels through its own transfer
(ADR 0007). `src/.dockerignore` is an allowlist (`*` then `!<files>`), so both
builds upload a minimal tree.

Fixture hygiene rules worth copying:

- **No fixed Docker-global names anywhere**: no `name:`, no `container_name:`,
  no `image:` tags on builds — images land on compose's project-scoped
  defaults (`<project>-<service>`), which shadow nothing (ADR 0010).
- **Long syntax** for volumes (`type:`/`source:`/`target:`) and ports
  (`target:`/`published:`, here `target: 22` with `host_ip: 0.0.0.0` and no
  published port — a random host port, resolved at runtime).
- **Dummy secrets**: `env_file: - path: .env.service.test` with
  `required: false` (an `env_file` **object** form, Compose 2.24+) pointing at
  a gitignored copy of `tests/.env.service.test.example` holding empty values;
  validation stays green on fresh clones and no real token ever reaches a test
  container.
- `tests/.gitignore` ignores `.env*` but re-includes `!.env*.example`.

### Per-worktree identity and isolation

The load-bearing idea (ADR 0010). The suite derives a compose project name
`rtx-workspace-tests-<8 hex>` (32 random bits, `crypto.getRandomValues`),
recorded as `COMPOSE_PROJECT_NAME=` in gitignored `tests/.env` — which is
compose's own project-directory env file, so manual flagless invocations
(`docker compose --file tests/docker-compose.yml logs workspace`) aim at the
same project. The helper (`tests/compose-project.ts`) reads-or-generates the
record and self-heals malformed ones; the suite **also** passes
`--project-name` explicitly (the flag outranks both shell env and `.env`, so a
stray exported `COMPOSE_PROJECT_NAME` cannot hijack it). The record is an
identity, not a lock: it is never deleted, so the next run's defensive
teardown cleans a crashed predecessor's leftovers. Consequences:

- Multiple worktrees / concurrent agent sessions share one Docker daemon
  without colliding (containers, volume, and image tags are all
  project-scoped).
- The worst pre-fix failure mode — one run's opening `down` destroying
  another run's live containers — is structurally impossible.
- Two concurrent runs in the _same_ worktree still collide (explicitly out of
  scope: one run per worktree).
- `tests/compose-project.test.ts` unit-tests the record contract (generate,
  reuse, self-heal, distinct draws) without Docker.

### Lifecycle: build, start, probe, tear down

Global hooks in `tests/docker.test.ts` (module level):

```ts
const project = resolveComposeProject("tests/.env");
const compose = [
  "docker",
  "compose",
  "--file",
  "tests/docker-compose.yml",
  "--project-name",
  project,
];
const env = {
  ...process.env,
  DOCKER_GID: String(statSync("/var/run/docker.sock").gid),
};

beforeAll(async () => {
  await $`${compose} down --volumes --remove-orphans`
    .env(env)
    .nothrow()
    .quiet(); // defensive teardown
  await $`${compose} build --pull`.env(env); // not quiet: live progress, throws with stderr
}, 1_900_000);

afterAll(async () => {
  await $`${compose} down --volumes --remove-orphans`
    .env(env)
    .nothrow()
    .quiet();
}, 120_000);
```

Key mechanics:

- **Bun Shell is the only subprocess layer**: `$` from `bun`, an interpolated
  array expands into separate arguments; `.env({...})` injects variables
  (process env wins over compose `.env` interpolation), `.nothrow()` resolves
  expected failures into an exit code, `.quiet()` silences, `.text()` captures
  stdout. No `Bun.spawn`, no execa.
- **Defensive teardown first, in `beforeAll` and in every block's
  `beforeAll`** (`docker rm --force --volumes <name>` for one-offs) — because
  `afterAll` does not run under SIGKILL, a crashed prior run must be cleaned
  by the next one.
- **Explicit hook/test timeouts everywhere**: `bun:test` kills hooks after 5 s
  by default; the build hook gets 1 900 000 ms, per-test timeouts 30–960 s.
- **Start = `up --detach --wait --wait-timeout 1500`**: readiness gates on the
  compose healthchecks (`depends_on: condition: service_healthy`), so there is
  no ad-hoc sleep-and-retry for the main stack. The effective ceiling is the
  healthcheck budget (`start_period` + `retries × interval`); `--wait-timeout`
  is only a backstop beyond it.
- **Healthchecks are cheap in-container probes**: nginx uses
  `wget -qO- http://localhost/user-install.sh`; the workspace proves sshd with
  bash's `exec 3<>/dev/tcp/127.0.0.1/22`. A healthcheck doubles as the
  acceptance signal — sshd answering only after first-boot provisioning
  finished, so "stack healthy" is itself the no-manual-steps check.
- **Resolve, don't derive**: the running container's name comes from
  `compose ps --quiet workspace` + `docker inspect --format {{.Name}}`
  (strip the leading `/`); the built image is referenced by ID via
  `docker inspect --format {{.Image}} <container>`; the published port from
  `compose port workspace 22` (parsed `<address>:<port>`). Nothing assumes
  compose's naming scheme.
- **One-off containers for image-contract tests**:
  `compose run --detach --name ${project}-dockerfile --no-deps --entrypoint sleep workspace infinity`
  — entrypoint replaced so first-boot never runs; `compose exec` reaches `run`
  containers too; names derive from the project identity so parallel worktrees
  cannot collide. Assert image config through
  `docker inspect --format {{json .Config.<Field>}}`.
- **Polling loop for containers that cannot use `up --wait`** (one-offs):
  probe function returning exit code via `.nothrow().quiet()`, a deadline
  check, `await Bun.sleep(1_000)` — same probe as the healthcheck.
- **Log-based state assertions**: `docker logs [--since <ISO>] <container>`
  plus a distinctive marker line (`const bootstrapMarker = '…'`); presence
  proves provisioning ran, absence proves a skip — with `--since` scoping to a
  restart.
- **Never-throw teardown of one-offs in `finally`**, so a failed assertion
  still removes the container.

### Helpers for up/exec/logs

There is no shared framework — per-suite helper closures over `compose`/`env`:
`execInWorkspace` (`compose exec --user … workspace bash -c …`), `execBare`
(`docker exec` — plainest surface, image `ENV`-resolved), `execInteractive`
(`docker exec --user ubuntu … bash -ic`), log/inspect/port resolvers as above.
SSH-surface helpers (`sshLogin`, `sshCommand`, `sshInteractive` with a
throwaway `ssh-keygen` keypair, `BatchMode`/`IdentitiesOnly`/`accept-new`
options, `compose port`-resolved random port) exist because that image's
contract _is_ sshd; they are product-specific, not harness-generic.

### Skipping when Docker is unavailable

**It does not skip.** Docker is a stated README prerequisite, and
`tests/docker.test.ts` reads `/var/run/docker.sock`'s `statSync(...).gid` at
module load — no socket means the file fails to load and the suite fails.
There is no `skipIf`/environment probe anywhere. (For this repo, whose
template README calls Docker optional, that is a gap to adapt — see the
recommendation.)

### Parallelism

Within a run: `bun test` executes files sequentially in one process, and the
Docker suite relies on that — one shared stack, built once, with
order-dependent blocks (the recreate test tears down and re-ups the same
stack). Between runs: the per-worktree project identity is the isolation
mechanism (ADR 0010); resource contention (disk, `--pull` bandwidth, CPU) is
deliberately unmitigated.

### Local-dev loop

`bun test` on demand; `.husky/pre-push` runs only the fast
`Dockerfile` block per push
(`bun test --only-failures --test-name-pattern 'Dockerfile'`) — the full suite
is too slow and its vendor-endpoint half too flaky to gate every push
(ADR 0008).

## (b) CI workflow (`.github/workflows/ci.yml`)

One workflow, four jobs:

1. **`changes`** — checks out with `fetch-depth: 0` and diffs the event's
   range (`base...head` for PRs, `HEAD~1...HEAD` for squash-merge pushes,
   everything for `workflow_dispatch`) into `hygiene`/`release` boolean
   outputs over path sets (`src tests .github/workflows/ci.yml package.json
bun.lock` for hygiene; the `src`-only subset for release). Filtering is
   per-job `if:` — **not** a workflow-level `paths:` filter — because a
   path-skipped workflow never reports the required checks and the PR would
   sit unmergeable, while a skipped job reports success.
2. **`hygiene`** (needs `changes`, 15 min) — `oven-sh/setup-bun` (reads the
   version from `packageManager`), `bun install --frozen-lockfile`, ShellCheck
   v0.10.0 installed from the upstream tarball (apt ships an older minor),
   then `bun run lint` (Biome), `format:check` (Prettier), `typecheck`
   (`tsc --noEmit`), `lint:sh`, and `lint:compose`
   (`docker compose --file tests/docker-compose.yml config --quiet` —
   client-side, no daemon needed).
3. **`test-suite`** (needs `changes` + `hygiene`, 90 min job / 75 min step) —
   runs only for ready PRs and manual dispatch (`ready_for_review`
   re-triggers; drafts run hygiene only) and only when the diff touches the
   gate paths. Container tests run on the plain `ubuntu-latest` GitHub-hosted
   runner (Docker + compose preinstalled) as literally `bun test` — the
   suite's own hooks build the image through the Tests stack, so CI has **no
   separate build step**. Before the suite: `docker pull
ghcr.io/andrielson/rtx-workspace:latest` (`continue-on-error: true` — cold
   bootstrap before the first release) then
   `docker build --cache-from ghcr.io/…:latest --tag rtx-workspace:latest src`
   to warm the daemon-side BuildKit cache so `compose build --pull` resolves
   as cache hits. The suite step is `continue-on-error: true` with exactly one
   full-suite retry on failure — vendor-endpoint hiccups get a second chance,
   real regressions fail deterministically twice.
4. **`release`** — see (c).

Workflow-level posture: `permissions: contents: read`; a `concurrency` group
(`ci-pr-<n>` / ref) with `cancel-in-progress: true`; third-party actions
pinned by commit SHA; `timeout-minutes` on every job; no
`pull_request_target` anywhere (fork PRs run with the read-only token and no
secrets; the publish path is push-to-main only, which a fork cannot produce).

On merges: `test-suite` skips (its `if:` requires a PR or dispatch event) —
the suite gates at PR time; merges re-run hygiene and cut the release.

Caching summary: no `actions/cache` at all. The strategy is Docker-centric —
daemon-side BuildKit cache warmed from the release image on PRs, and a
registry `buildcache` manifest on releases (below). Bun's own install cache
rides `setup-bun`; nothing else is cached.

## (c) GHCR publishing

The `release` job (needs `changes` + `hygiene` — not `test-suite`; the suite
already gated the PR, and a `workflow_dispatch` publish without the suite is a
deliberate manual act by the owner):

- **Triggers**: the job's `if:` requires
  `github.repository == 'andrielson/rtx-workspace' && github.ref == 'refs/heads/main' && (push || workflow_dispatch) && needs.changes.outputs.release == 'true'`
  — merge (or manual dispatch) that touched the image inputs (`src/`, the
  workflow, `package.json`). The workflow `on:` block itself is just
  pull_request/push(main)/workflow_dispatch.
- **Version and idempotency**: the version is read from `package.json`
  (validated `X.Y.Z`); the git tag `v{version}` is the publication record —
  present means already released, absent means publish. A merge without a bump
  publishes nothing; a publish that fails mid-flight self-heals on the next
  qualifying merge or dispatch because the tag never landed. Date tags and
  semver-from-labels were explicitly rejected (ADR 0008).
- **Credentials**: `docker/login-action` against `ghcr.io` with
  `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}` —
  no PAT. The job-level `permissions` block rises to `contents: write` (git
  tag + release) and `packages: write` (push); everything else stays
  `contents: read`.
- **Build and push**: `docker/setup-buildx-action` (the default driver cannot
  export registry cache) then `docker/build-push-action` with `context: src`,
  `pull: true`, `push: true`, tags `ghcr.io/andrielson/rtx-workspace:v{version}`
  and `:latest`, hand-written OCI labels
  (`org.opencontainers.image.title/description/version/revision/source`), and
  cache `cache-from: type=registry,ref=…:buildcache` /
  `cache-to: type=registry,ref=…:buildcache,mode=max` plus `type=inline` (the
  inline half is what PR-run cache warming consumes).
- **Record**: `gh release create v{version} --title v{version} --generate-notes --target <sha>`
  with `GH_TOKEN: ${{ github.token }}` — after the push, so the tag lands only
  on a completed publish.
- The release build is a rebuild, not a retag of the PR's image (different
  ephemeral runners; transferring a ~GB artifact per PR was rejected). The
  package is created private on first push and flipped public once, manually.
- Note: `docker/metadata-action` is **not** used — tags and labels are
  explicit in the workflow.

## Recommendation for chrome-devtools-mcp-proxy

This repo ships an image (transport glue: mcp-proxy wrapping
chrome-devtools-mcp against an external CDP endpoint), not an app. The map
already pins: `ARG`-pinned versions, `ENV`-defaulted
`MCP_PROXY_ARGS`/`CHROME_DEVTOOLS_MCP_ARGS`, a future `docker-entrypoint.sh`
env-to-args contract, unit / container-integration / e2e-smoke test tiers, no
example `compose.yaml` in the repo.

### Port verbatim

- **`tests/` layout**: fixture files colocated with the suites; Docker-free
  unit suites in their own files; the container suite as the only
  Docker-dependent file. `tests/.gitignore` (`!.env*.example` / `.env*`) and
  the dummy `env_file` + `required: false` pattern for any env the fixture
  needs.
- **`tests/compose-project.ts` + its unit test**, renamed to this repo's
  prefix (`chrome-devtools-mcp-proxy-tests-<8 hex>`): per-worktree identity,
  self-healing record in `tests/.env`, explicit `--project-name` anyway.
- **The compose argv prefix + Bun Shell discipline**: `$` from `bun`,
  array-spread arguments, `.nothrow().quiet()` defensive teardowns, `.text()`
  captures, explicit `.env({...})`.
- **Defensive teardown** in `beforeAll` (stack-level `down --volumes
--remove-orphans`; one-off `docker rm --force --volumes`) and in
  `afterAll`/`finally`.
- **Explicit hook and test timeouts** on everything Docker-touching
  (bun:test's 5 s default kills slow hooks).
- **`up --detach --wait --wait-timeout N`** as the single bring-up + readiness
  gate, backed by compose healthchecks and `depends_on:
condition: service_healthy`; healthcheck budget as the real ceiling.
- **Resolve-don't-derive** for container name (`compose ps --quiet` +
  `docker inspect --format {{.Name}}`), image by ID (`{{.Image}}`), published
  port (`compose port`).
- **No `container_name:`, no `image:` tags, no `name:` in the fixture**;
  project-scoped defaults only.
- **Polling pattern** (probe + deadline + `Bun.sleep`) for one-off containers
  outside `up --wait`; **log-marker assertions** via `docker logs [--since]`.
- **CI shape**: the `changes` job with per-job `if:` skips (never a
  workflow-level `paths:` filter if checks become required), `hygiene` job
  (lint / format:check / typecheck / lint:sh / lint:compose), `test-suite`
  job running plain `bun test` on `ubuntu-latest` (no separate CI build —
  the suite builds the image), `concurrency` + `cancel-in-progress`,
  SHA-pinned actions, `permissions: contents: read` default, `timeout-minutes`
  everywhere, one full-suite retry.
- **Release mechanics**: push-to-main + `workflow_dispatch` only,
  path-gated, `github.repository` guard, version from `package.json` with the
  git tag `v{version}` as the idempotency record, `login-action` with
  `GITHUB_TOKEN` (`github.actor`), job-scoped `contents: write` +
  `packages: write`, `v{version}` + `latest` tags, `pull: true`, registry
  `buildcache` + inline cache, `gh release create --generate-notes` after the
  push.

### Adapt

- **Fixture services**: `workspace` + `nginx` becomes the proxy image plus a
  headless-Chrome CDP fixture (the e2e smoke's `--browser-url` target), both
  built/declared in `tests/docker-compose.yml` with the same no-fixed-names
  rules. The proxy healthcheck becomes an HTTP reachability probe on the
  mcp-proxy port (19222) instead of sshd's `/dev/tcp`.
- **`tests/src` symlink → `../src`** with both contexts `src` and any extra
  fixture Dockerfile in `tests/` via `dockerfile: ../Dockerfile.nginx`-style
  paths — or the equally valid plain `context: ../src` (ADR 0007 records them
  as mechanically equivalent; the symlink just keeps paths local to `tests/`).
- **Docker-unavailable skip**: rtx-workspace has none (hard prerequisite);
  this repo's README calls Docker optional, so add a guard — probe
  `docker info` (or `/var/run/docker.sock`) once and gate the container suite
  with `describe.skipIf`/`test.skipIf` so Docker-less `bun test` stays green
  and a skip is distinguishable from a failure. Keep the unit suites
  Docker-free exactly as upstream does.
- **Image-contract block**: port the `compose run --detach --no-deps
--entrypoint sleep … infinity` one-off + `docker inspect
{{json .Config.…}}` assertions, re-aimed at this image's contract:
  `ENTRYPOINT ["docker-entrypoint", …]` shape, `MCP_PROXY_ARGS` /
  `CHROME_DEVTOOLS_MCP_ARGS` `ENV` defaults, pinned `ARG` versions visible in
  the build, `UV_*` env carried through.
- **Script unit-testing patterns** (`env-loader.test.ts`,
  `user-install.test.ts`): sandbox-home `bash -c` sourcing and the
  `Bun.serve` stand-in endpoint — aimed at the future `docker-entrypoint.sh`
  env-to-args contract instead of a bootstrap script.
- **Scale the time budgets**: rtx-workspace's 90/75-min suite budget reflects
  a ~19-min first-boot Nix provisioning; this image is small — think 15–30-min
  job, 10–15-min suite step, healthcheck budgets in seconds-to-a-few-minutes.
- **Cache warming**: keep the `docker pull :latest` + `docker build
--cache-from` pre-warm (`continue-on-error` covers the pre-release cold
  start), aimed at this repo's GHCR image once it exists.
- **`compose build --pull`**: keep — the map pins exact tags without digests,
  so `--pull` still refreshes what a pinned tag points to.
- **e2e smoke**: initialize + `tools/list` + one page load over the proxy's
  HTTP surface, driven from the suite against `compose port`-resolved
  endpoints — same harness mechanics, MCP-specific payload.
- **Draft-PR gating** (`ready_for_review` re-trigger): port only if this repo
  adopts required checks + draft PR workflow.

### Skip

- **The SSH harness wholesale**: throwaway keypair, `sshLogin` /
  `sshCommand` / `sshInteractive`, `known_hosts` pinning, and the
  `defaultGateway()` / `host_ip: 0.0.0.0` machinery for reaching published
  ports from inside containers (ADR 0005) — that exists because sshd _is_ the
  product's interface; the proxy's interface is HTTP, reached via `compose
port` from the runner. Revisit only if an e2e ever runs from inside a
  sibling container.
- **The nginx web-root fixture** (`Dockerfile.nginx`, ADR 0004's baked
  script): exists to serve a first-boot bootstrap script; this image has no
  first-boot provisioning.
- **Volume-persistence / second-boot / bundle-skip suites** (`recreate`,
  `second boot`, `bundle skips`): no provisioning volume to prove persistent.
  If a container-recreate env test is ever wanted (changed
  `MCP_PROXY_ARGS`), the `down`-keep-volumes-`up` shape is the reference — but
  the e2e smoke covers the behavior more directly.
- **`DOCKER_GID` / docker-socket bind / `group_add`**: the proxy needs no
  Docker-in-Docker; drop the `statSync('/var/run/docker.sock')` env plumbing.
- **pre-push running container tests**: upstream keeps even the fast half
  flaky-gated deliberately; keep this repo's pre-commit as-is and run
  `bun test` on demand.
- **`docker/metadata-action`**: not used upstream; hand-written OCI labels
  carry version/revision/source explicitly. Either is defensible — port the
  upstream's explicit labels for consistency, and adopt metadata-action only
  if tagging grows more dimensions than `v{version}` + `latest`.
