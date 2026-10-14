# Conventional-commit versioning via semantic-release

- Status: accepted (2026-10-14)
- Decided in [#10](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/10)
  (versioning core amended by
  [#12](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/12)); the map
  ([#1](https://github.com/andrielson/chrome-devtools-mcp-proxy/issues/1)) keeps the
  decision index.

Versions are never bumped by hand, and no file in the repo carries one. semantic-release
derives each version from the conventional-commit history (default analyzer: breaking →
major, even from 0.x; feat → minor; fix → patch) and publishes the git tag, the GitHub
release and the GHCR image. It runs inside the release job as
`npx --yes --package semantic-release@<exact> --package @semantic-release/exec@<exact> semantic-release`
on the runner's Node — a release dependency with zero entries in the project's dependency
tree, never executed under Bun. Exact pins are chosen at build time: upstream warns an
unpinned plugin breaks a release as surely as an unpinned core.

## No release commits to `main`

`@semantic-release/git` and `@semantic-release/npm` are deliberately absent from
`release.config.js`. A release commit pushed straight to `main` would collide with the
PR-only flow that branch protection enforces, and nothing reads a version field anyway:
`package.json` keeps the project rename but carries no `version`, and the OCI labels
take `nextRelease.version` directly.

## The image push runs in `prepare`, so the tag is the publication record

The image build/push lives in the exec plugin's `prepareCmd` (a repo shell script
wrapping `docker buildx build --push`), not in a `publishCmd`. semantic-release core's
order is prepare → tag push → publish, so the tag lands only after the image push has
succeeded — the git tag stays the publication record: present means that image version
was published. Had the push lived in `publishCmd`, a docker failure would strand a tag
whose version every later run then skips forever; with `prepare`, a failed build
publishes nothing and the next run retries cleanly. Accepted residual risk: a run
cancelled between image push and tagging leaves an orphan image for a version that is
never tagged — harmless.

## Consequences

- Release notes live in GitHub Releases (`@semantic-release/github`, comments and
  labels off); there is no CHANGELOG file.
- Commitlint checks PR titles in the `hygiene` job: squash merges make the PR title the
  commit, and a non-conventional title silently releases nothing.
- The version series is anchored by the seed tag `v0.1.0` on `1dbad81` ("feat: add
  functional poc"), created manually before the release job first runs; without it the
  first release would be 1.0.0, and the pipeline's own merge commit (a feat) releases
  0.2.0.
