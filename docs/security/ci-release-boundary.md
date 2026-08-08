# CI and release trust boundary

LoomTV treats pull-request validation and production release as separate trust zones.

## Invariants

- `.github/workflows/validate.yml` is the only workflow that executes pull-request code. It declares `contents: read`, does not reference protected secrets, and contains no publishing operation.
- Every external action and reusable workflow is pinned to a full commit SHA. Dependency installs use the frozen lockfile.
- `.github/workflows/release.yml` operates only on an existing `v*` tag. Signing jobs and the publishing job use the protected `production-release` environment.
- Only `publish-release` receives `contents: write`; build jobs remain read-only. Signing credentials are scoped to their platform-specific release steps.
- Production macOS and Windows jobs fail before packaging when any required signing or notarization credential is absent. Unsigned packages are available only from the validation workflow.
- A release tag is resolved once and its commit SHA is passed to every downstream job, so signing and publishing build the source verified by `prepare`.
- Every job has an explicit timeout; completed `main` validation is not cancelled by a newer push.

Until the atomic-publishing work item lands, reruns retain same-named release assets instead of replacing the complete draft set. Treat any interrupted or partially uploaded release as unsafe to publish; the planned atomic manifest/checksum gate must replace this interim behavior.

The repository enforces the file-level portion of these invariants with:

```sh
corepack pnpm verify:workflow-policy
corepack pnpm test:workflow-policy
```

## Required GitHub repository configuration

Repository administrators must configure these controls before enabling production releases:

1. Create an environment named `production-release`.
2. Add at least one required maintainer reviewer. Limit deployment branches and tags to protected refs.
3. Store signing and notarization secrets only in that environment, using the names referenced by `release.yml`.
4. Protect `main`: require the `Validate` checks, require review, block force pushes, and prevent branch deletion.
5. Protect `v*` tags so only release maintainers or the release automation can create or update them. Tags must not be mutable.

These settings are external to Git and must be verified in repository settings after the workflow change merges.

## Validation evidence

For a pull request, confirm the workflow summary shows a read-only `GITHUB_TOKEN`, no environment approval prompt, and no protected secrets. The workflow-policy tests include negative fixtures for write permissions, secret references and inheritance, publishing commands, `pull_request_target`, `workflow_run`, indirect desktop publishing, and unpinned reusable workflows.

Before the first production release, create a disposable protected test tag from a validated `main` commit. Confirm that every signing and publishing job pauses for the `production-release` approval, then cancel the run and remove the test tag. Perform this check before storing production signing credentials in the environment.

## Rollback

If the release workflow is suspected of exposing authority, disable Actions for the repository or the release workflow, revoke the affected environment secrets, and remove deployment access from `production-release`. Validation can remain enabled because it has no protected credentials and no write permission.
