# Releases

## How to prepare a release

> [!NOTE]  
> Relevant for maintainers with write access only.

1. Switch to a new branch from `v5`.
1. Run `npm ci --ignore-scripts`, `npm run lint`, and `npm test -- --runInBand`.
1. Update the version in [`package.json`](package.json) and both root version fields in `package-lock.json`.
1. Run `npm run build` to update the compiled files.
1. Update this [`RELEASES.md`](RELEASES.md) with the new version and changes in the `## Changelog` section.
1. Run `licensed cache` to update the license report.
1. Run `licensed status` and resolve any warnings by updating the [`.licensed.yml`](.licensed.yml) file with the exceptions.
1. Commit your changes and push your branch upstream.
1. Open a pull request against `v5` and get it reviewed and merged.
1. After all release PRs are merged, run the [Release workflow](https://github.com/qiniu/actions-cache/actions/workflows/release.yml) on `v5` with the new `vX.Y.Z` tag. Publish one release for the combined changes.
    1. The workflow uses the built-in GitHub token and OIDC identity; no GitHub App or GPG secrets are required.
    1. It verifies the package version, lint, tests, dependency audit, and all four committed bundles before packaging them with their licenses.
    1. It generates GitHub artifact provenance and verifies the repository, release workflow, `v5` source ref, and exact source commit before creating the version tag and publishing the release.
    1. Confirm the workflow and the archive, `SHA256SUMS`, and `provenance.sigstore.json` release assets. Keep `v5` as the maintained branch; do not create a same-named tag.

To verify a downloaded release, run the following in an empty directory, replacing the tag and source commit with the release you intend to use:

```sh
TAG=v5.0.8
SOURCE_COMMIT='replace-with-full-release-commit-sha'
gh release download "$TAG" --repo qiniu/actions-cache --pattern 'qiniu-actions-cache-*.tar.gz' --pattern SHA256SUMS --pattern provenance.sigstore.json
sha256sum -c SHA256SUMS
gh attestation verify "qiniu-actions-cache-${TAG}.tar.gz" --bundle provenance.sigstore.json --repo qiniu/actions-cache --source-digest "$SOURCE_COMMIT" --source-ref refs/heads/v5 --signer-workflow qiniu/actions-cache/.github/workflows/release.yml
```

The provenance proves the archive's origin and source identity. Version tags and checksum files are not GPG-signed.

## Changelog

### 5.0.8 (Qiniu)

- Refresh scoped STS credentials for long-running runnerd jobs and post-job cache saves, including proxy-aware refresh and renewed download signatures.
- Update runtime and development dependencies from #4, #6, #7, #8, #9, #11 and #12. The Babel update also supersedes #2 and #3.
- Preserve S3 XML compatibility for UTF-8 BOMs and supplementary Unicode entities by pinning the AWS XML adapter while retaining the updated XML parser dependency. Add real SDK response regression tests.
- Update the Jest ESLint plugin to support TypeScript ESLint 8 without peer dependency conflicts.
- Rebuild all four Action entrypoints and enforce Node.js 24 lint, tests and bundle consistency in CI.
- Publish the Action before deploying the companion runnerd update. Real regional and 24-hour workflow acceptance remains a deployment check.

### 5.0.4

- Bump `minimatch` to v3.1.5 (fixes ReDoS via globstar patterns)
- Bump `undici` to v6.24.1 (WebSocket decompression bomb protection, header validation fixes)
- Bump `fast-xml-parser` to v5.5.6

### 5.0.3

- Bump `@actions/cache` to v5.0.5 (Resolves: https://github.com/actions/cache/security/dependabot/33)
- Bump `@actions/core` to v2.0.3

### 5.0.2

- Bump `@actions/cache` to v5.0.3 [#1692](https://github.com/actions/cache/pull/1692)

### 5.0.1

- Update `@azure/storage-blob` to `^12.29.1` via `@actions/cache@5.0.1` [#1685](https://github.com/actions/cache/pull/1685)

### 5.0.0

> [!IMPORTANT]
> `actions/cache@v5` runs on the Node.js 24 runtime and requires a minimum Actions Runner version of `2.327.1`.
> If you are using self-hosted runners, ensure they are updated before upgrading.

### 4.3.0

- Bump `@actions/cache` to [v4.1.0](https://github.com/actions/toolkit/pull/2132)

### 4.2.4

- Bump `@actions/cache` to v4.0.5

### 4.2.3

- Bump `@actions/cache` to v4.0.3 (obfuscates SAS token in debug logs for cache entries)

### 4.2.2

- Bump `@actions/cache` to v4.0.2

### 4.2.1

- Bump `@actions/cache` to v4.0.1

### 4.2.0

TLDR; The cache backend service has been rewritten from the ground up for improved performance and reliability. [actions/cache](https://github.com/actions/cache) now integrates with the new cache service (v2) APIs.

The new service will gradually roll out as of **February 1st, 2025**. The legacy service will also be sunset on the same date. Changes in these release are **fully backward compatible**.

**We are deprecating some versions of this action**. We recommend upgrading to version `v4` or `v3` as soon as possible before **February 1st, 2025.** (Upgrade instructions below).

If you are using pinned SHAs, please use the SHAs of versions `v4.2.0` or `v3.4.0`

If you do not upgrade, all workflow runs using any of the deprecated [actions/cache](https://github.com/actions/cache) will fail.

Upgrading to the recommended versions will not break your workflows.

### 4.1.2

- Add GitHub Enterprise Cloud instances hostname filters to inform API endpoint choices - [#1474](https://github.com/actions/cache/pull/1474)
- Security fix: Bump braces from 3.0.2 to 3.0.3 - [#1475](https://github.com/actions/cache/pull/1475)

### 4.1.1

- Restore original behavior of `cache-hit` output - [#1467](https://github.com/actions/cache/pull/1467)

### 4.1.0

- Ensure `cache-hit` output is set when a cache is missed - [#1404](https://github.com/actions/cache/pull/1404)
- Deprecate `save-always` input - [#1452](https://github.com/actions/cache/pull/1452)

### 4.0.2

- Fixed restore `fail-on-cache-miss` not working.

### 4.0.1

- Updated `isGhes` check

### 4.0.0

- Updated minimum runner version support from node 12 -> node 20

### 3.4.0

- Integrated with the new cache service (v2) APIs

### 3.3.3

- Updates @actions/cache to v3.2.3 to fix accidental mutated path arguments to `getCacheVersion` [actions/toolkit#1378](https://github.com/actions/toolkit/pull/1378)
- Additional audit fixes of npm package(s)

### 3.3.2

- Fixes bug with Azure SDK causing blob downloads to get stuck.

### 3.3.1

- Reduced segment size to 128MB and segment timeout to 10 minutes to fail fast in case the cache download is stuck.

### 3.3.0

- Added option to lookup cache without downloading it.

### 3.2.6

- Fix zstd not being used after zstd version upgrade to 1.5.4 on hosted runners.

### 3.2.5

- Added fix to prevent from setting MYSYS environment variable globally.

### 3.2.4

- Added option to fail job on cache miss.

### 3.2.3

- Support cross os caching on Windows as an opt-in feature.
- Fix issue with symlink restoration on Windows for cross-os caches.

### 3.2.2

- Reverted the changes made in 3.2.1 to use gnu tar and zstd by default on windows.

### 3.2.1

- Update `@actions/cache` on windows to use gnu tar and zstd by default and fallback to bsdtar and zstd if gnu tar is not available. ([issue](https://github.com/actions/cache/issues/984))
- Added support for fallback to gzip to restore old caches on windows.
- Added logs for cache version in case of a cache miss.

### 3.2.0

- Released the two new actions - [restore](restore/action.yml) and [save](save/action.yml) for granular control on cache

### 3.2.0-beta.1

- Added two new actions - [restore](restore/action.yml) and [save](save/action.yml) for granular control on cache.

### 3.1.0-beta.3

- Bug fixes for bsdtar fallback if gnutar not available and gzip fallback if cache saved using old cache action on windows.

### 3.1.0-beta.2

- Added support for fallback to gzip to restore old caches on windows.

### 3.1.0-beta.1

- Update `@actions/cache` on windows to use gnu tar and zstd by default and fallback to bsdtar and zstd if gnu tar is not available. ([issue](https://github.com/actions/cache/issues/984))

### 3.0.11

- Update toolkit version to 3.0.5 to include `@actions/core@^1.10.0`
- Update `@actions/cache` to use updated `saveState` and `setOutput` functions from `@actions/core@^1.10.0`

### 3.0.10

- Fix a bug with sorting inputs.
- Update definition for restore-keys in README.md

### 3.0.9

- Enhanced the warning message for cache unavailablity in case of GHES.

### 3.0.8

- Fix zstd not working for windows on gnu tar in issues [#888](https://github.com/actions/cache/issues/888) and [#891](https://github.com/actions/cache/issues/891).
- Allowing users to provide a custom timeout as input for aborting download of a cache segment using an environment variable `SEGMENT_DOWNLOAD_TIMEOUT_MINS`. Default is 60 minutes.

### 3.0.7

- Fixed [#810](https://github.com/actions/cache/issues/810) - download stuck issue. A new timeout is introduced in the download process to abort the download if it gets stuck and doesn't finish within an hour.

### 3.0.6

- Fixed [#809](https://github.com/actions/cache/issues/809) - zstd -d: no such file or directory error
- Fixed [#833](https://github.com/actions/cache/issues/833) - cache doesn't work with github workspace directory

### 3.0.5

- Removed error handling by consuming actions/cache 3.0 toolkit, Now cache server error handling will be done by toolkit. ([PR](https://github.com/actions/cache/pull/834))

### 3.0.4

- Fixed tar creation error while trying to create tar with path as `~/` home folder on `ubuntu-latest`. ([issue](https://github.com/actions/cache/issues/689))

### 3.0.3

- Fixed avoiding empty cache save when no files are available for caching. ([issue](https://github.com/actions/cache/issues/624))

### 3.0.2

- Added support for dynamic cache size cap on GHES.

### 3.0.1

- Added support for caching from GHES 3.5.
- Fixed download issue for files > 2GB during restore.

### 3.0.0

- Updated minimum runner version support from node 12 -> node 16
