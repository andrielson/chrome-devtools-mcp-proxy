#!/bin/sh
# Build and push the chrome-devtools-mcp-proxy release image to GHCR. Invoked
# by semantic-release's exec plugin from release.config.js
# (prepareCmd: 'scripts/release-image.sh ${nextRelease.version}') in the
# release job's prepare phase — BEFORE semantic-release core pushes the git
# tag, so the tag lands only on a completed publish and a failed build
# retries with no stranded tag (docs/adr/0001-…-via-semantic-release.md).
#
# Contract (certified by tests/unit/release-image.test.ts):
#   1. Exactly one argument: the bare X.Y.Z release version
#      (${nextRelease.version} — no leading 'v'; branches: ['main'] means no
#      prerelease suffixes either). Anything else exits 64 (EX_USAGE) without
#      touching the registry.
#   2. One `docker buildx build --push`: tags v{version} + latest, the bare
#      version as org.opencontainers.image.version (the io.github.andrielson.*
#      pinned-version labels come from the Dockerfile itself), registry
#      buildcache (mode=max) plus inline cache — the inline half is what the
#      test-suite job's cache warming consumes — --pull (exact tags without
#      digests still move upstream), the single platform linux/amd64, and the
#      repository's src as context, resolved from this script's location so
#      the CWD never matters.
#   3. exec(1) replaces the shell, handing docker's exit code to
#      semantic-release directly: a failed push fails the release.
#
# POSIX sh (runs on the GitHub Actions runner, never inside the image). The
# registry credentials and the docker-container builder are set up by the
# release job before this runs (the default docker driver cannot export
# registry cache).

set -eu

program_name='release-image'

image='ghcr.io/andrielson/chrome-devtools-mcp-proxy'
cache_ref="${image}:buildcache"

usage() {
  printf 'usage: %s X.Y.Z\n' "${program_name}" >&2
  # shellcheck disable=SC2016  # literal on purpose: names semantic-release's own template variable
  printf '%s: semantic-release passes the bare version (${nextRelease.version}), no leading v\n' "${program_name}" >&2
}

# shellcheck disable=SC2292  # POSIX sh (runs under /bin/sh): [[ ]] is not available there
if [ "$#" -ne 1 ]; then
  usage
  exit 64
fi

version="${1}"

# Bare X.Y.Z only: digits and exactly two dots, no empty segment. A leading
# 'v' (which would double up as a vv… tag) or a prerelease suffix cannot come
# from semantic-release with branches: ['main'] — better to fail loudly here
# than to push malformed tags to the registry.
not_bare_version() {
  printf '%s: %s: not a bare X.Y.Z version\n' "${program_name}" "${version}" >&2
  usage
  exit 64
}

# Falling through (no pattern matched) is the valid-version path: the
# patterns reject anything that is not digits-and-dots with no empty segment.
# shellcheck disable=SC2249
case "${version}" in
  '' | .* | *. | *..* | *[!0-9.]*)
    not_bare_version
    ;;
esac
nondigits=$(printf '%s' "${version}" | tr --delete '0-9')
# shellcheck disable=SC2292  # POSIX sh (runs under /bin/sh): [[ ]] is not available there
if [ "${nondigits}" != '..' ]; then
  not_bare_version
fi

# The repository root (and the src context under it), resolved from this
# script's own location: prepareCmd runs from the checkout root, but nothing
# here should depend on that.
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname -- "${script_dir}")

exec docker buildx build \
  --push \
  --pull \
  --platform linux/amd64 \
  --tag "${image}:v${version}" \
  --tag "${image}:latest" \
  --label "org.opencontainers.image.version=${version}" \
  --label 'org.opencontainers.image.source=https://github.com/andrielson/chrome-devtools-mcp-proxy' \
  --cache-from "type=registry,ref=${cache_ref}" \
  --cache-to "type=registry,ref=${cache_ref},mode=max" \
  --cache-to type=inline \
  "${repo_root}/src"
