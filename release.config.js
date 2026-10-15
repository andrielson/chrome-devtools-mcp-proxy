// semantic-release configuration, decided in
// docs/adr/0001-conventional-commit-versioning-via-semantic-release.md and
// run by the CI release job via pinned `npx --package` invocations — this
// file is the project's only release input, and the project's dependency
// tree holds no release tooling at all.
//
// Deliberately absent: @semantic-release/npm (nothing reads a version field;
// package.json carries none) and @semantic-release/git (no release commits
// to main — the PR-only flow branch protection enforces stays intact). The
// image push runs in the exec plugin's prepare phase so the git tag lands
// only on a completed publish; release notes live in GitHub Releases, so
// there is no CHANGELOG file.
module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer', // bundled with semantic-release
    '@semantic-release/release-notes-generator', // bundled
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${nextRelease.version} is @semantic-release/exec's own template syntax, interpolated by the plugin — not a JavaScript template placeholder
    ['@semantic-release/exec', { prepareCmd: 'scripts/release-image.sh ${nextRelease.version}' }],
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
}
