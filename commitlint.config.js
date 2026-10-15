// Commitlint checks pull request titles in the CI hygiene job (see
// .github/workflows/ci.yml): squash merges make the PR title the commit, and
// the commit is what semantic-release analyzes — a non-conventional title
// would silently release nothing. The rules are the conventional-commit
// preset unchanged (docs/adr/0001-conventional-commit-versioning-via-semantic-release.md);
// the contract is certified by tests/unit/commitlint.test.ts.
module.exports = {
  extends: ['@commitlint/config-conventional'],
}
