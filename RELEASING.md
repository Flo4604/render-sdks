# SDK development and releases

Edit the SDK directly under `sdks/<language>`. This repository owns all client source and tests. It has no private workspace dependency or source export step.

Run these commands from the repository root. Node 24, uv, Go, and the .NET 8 SDK are required for their respective languages.

| SDK | Build, test, and audit its package |
| --- | --- |
| TypeScript | `node scripts/release.mjs typescript` |
| Python | `node scripts/release.mjs python` |
| Go | `node scripts/release.mjs go` |
| C# | `node scripts/release.mjs csharp` |

The command writes package files and SHA-256 checksums under `artifacts/<language>/<version>`. The Go command tests the source module and produces no binary package. CI runs each SDK independently for pushes and pull requests.

## Publish a version

Update only the SDK being released. TypeScript uses `sdks/typescript/package.json`, Python uses `sdks/python/pyproject.toml`, C# uses `sdks/csharp/src/Medalbot.Render.csproj`, and Go uses `sdks/go/VERSION`. Refresh the relevant lockfile after a version or dependency change. Commit the source changes, then add `--publish` to the command above.

The release script tests and audits the package, pushes the source and version tag, then creates a public GitHub release. It refuses an existing tag or uncommitted source changes. Tags use `typescript/v<version>`, `python/v<version>`, `csharp/v<version>`, or `sdks/go/v<version>`. Go requires that last prefix because its module is under `sdks/go`.

A source-only directory move does not require a new npm, PyPI, or NuGet version. Existing registry releases remain installable. A change to package contents needs a new version before registry publication.

## Registry publishing

npm publishes through `.github/workflows/publish-registries.yml` in environment `npm`. NuGet publishes through `.github/workflows/publish-nuget.yml` in environment `nuget`. Keep these filenames and environment names unchanged because the registry policies match them. Both workflows download the audited release asset and verify its checksum before requesting short-lived credentials through GitHub OIDC.

Python source and package builds live here. Its existing PyPI policy still trusts the private service repository's `publish-registries.yml` workflow. That workflow only downloads and publishes the public wheel; it contains no SDK source. Until the policy is moved, a maintainer dispatches it after creating the Python release:

```sh
gh workflow run publish-registries.yml --repo Flo4604/skin-img -f version=python/v0.1.2
```

To retry npm or NuGet after a policy change, dispatch the matching public workflow with the existing release tag. Select the npm input when dispatching the npm workflow. NuGet also needs the `NUGET_USER` repository variable set to the profile username of the policy creator.

Never add long-lived registry tokens. Verify a fresh installation from the registry before reporting publication as complete.
