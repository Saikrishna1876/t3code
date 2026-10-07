# T3 Code compatibility patches

## Purpose

Keep desktop usable on the user's Intel Mac running unsupported macOS 15. User reports that a newer Chromium graphics change causes CPU rendering and lag, and has downgraded Electron locally. The graphics cause and runtime improvement have not been independently verified during this documentation setup.

## Update policy

- Canonical specification: `PATCH.md`.
- Upstream URL: https://github.com/pingdotgg/t3code.git
- Upstream remote: `origin`. The `fork` remote is the user's fork, not the update source.
- Target: latest upstream default branch, resolved live to an exact commit each update. Cached default branch at setup: `main`.
- Integration: manual updates prepare with `--no-ff --no-commit` in a separate worktree. The user also authorizes the T3 scheduled cloud task to integrate in a disposable GitHub Codespace, preserve every patch, run focused checks, commit, push `Saikrishna1876/t3code` main without force, and dispatch `fork-macos-release.yml`. Scheduled integration and release builds must not run on the local Mac. See [cloud update operation](docs/operations/fork-cloud-updates.md).
- Preserve original staged, unstaged, and untracked work. Carry the pending compatibility changes below and this specification into the review result.

## Baseline

- Observed integrated upstream baseline: `4ee6bfd50ef4a089440d5c3662db2298da9cc50e`, landed on `fork/main` and local `main` through merge `9a869ff32704edeb267abc558de44611edf7c815`. Remote SHA verified after pushing.
- Previous integrated upstream baseline: `bd89c1302026255c62cc09278207bfaf2664da4a`, landed through merge `a2f6cbabc1279ca3815345e85cfbb5442de39e08`.
- Compatibility patches are committed. No pending local edits existed when this update started.
- Last behaviorally verified baseline: `56a9bf2bd7d3dcdae722a5de84578909dc11aeda` (release `0.0.42` built locally on 2026-09-18 with Electron `43.6.0` was extracted and interactively confirmed working by the user on the target Intel Mac macOS 15 system).

## P001: Preserve the compatible Electron runtime

- Status: active. Version observed in the user's existing patch, runtime result not independently verified.
- Required behavior: preserve desktop usability on the target Intel Mac. Retain exact Electron `43.6.0` until another version is verified on that machine and the constraint is deliberately revised.
- Implementation hints: `apps/desktop/package.json` pins Electron to `43.6.0` instead of upstream's `44.4.2`; `pnpm-workspace.yaml` aligns the minimum-release-age exception; `pnpm-lock.yaml` resolves the desktop importer and affected peer snapshots to `43.6.0`.
- Regenerate the lockfile through the current package manager when dependencies change. The current lockfile still contains `44.1.0` entries, so checking for that string globally is not a valid test of the active desktop runtime.
- Verification: confirm the desktop manifest, resolved importer, installed Electron binary, and packaged runtime agree. On the target machine, inspect Electron GPU feature status and renderer information, then check representative scrolling, chat rendering, and CPU use against the user's working baseline. Do not claim acceleration based only on compilation or a version number.
- Retirement: a newer runtime satisfies these hardware checks, or the user changes the hardware requirement. If upstream requires incompatible APIs, adapt those call sites or report the concrete blocker; do not silently upgrade Electron.

## P002: Keep clipboard behavior compatible with P001

- Status: active, observed alongside the runtime downgrade.
- Required behavior: text copying remains tolerant of clipboard failures and a synchronous return value. Preview image copying works without relying on `ClipboardItem`; invalid images and clipboard write failures retain meaningful errors. Desktop preview paste uses native Chromium clipboard handling through upstream server-owned browser automation, preserving native formats without Electron 44 clipboard APIs.
- Implementation hints: `apps/desktop/src/electron/ElectronShell.ts` awaits `clipboard.writeText` inside try/catch without calling `.catch` on its return value. `apps/desktop/src/preview/Manager.ts` uses `clipboard.writeImage` through the synchronous error wrapper. `apps/desktop/src/preview/Manager.test.ts` covers that clipboard path and synchronous failure.
- Paste implementation: upstream `ac8e9453c` moved automation to `apps/server/src/preview/ServerBrowserPage.ts`, whose `press` uses Playwright keyboard events against desktop tabs through the CDP relay. The old synchronous format reader and its tests are retired because that Electron clipboard API path no longer exists. Interactive native-format paste acceptance remains pending.
- Verification from repo root: `./node_modules/.bin/vp test run apps/desktop/src/preview/Manager.test.ts apps/desktop/src/electron/ElectronShell.test.ts apps/desktop/src/preview/DesktopBrowserHost.test.ts apps/server/src/preview/ServerBrowser.test.ts` and `vp run --filter @t3tools/desktop typecheck`. Confirm text and preview-image copying in the desktop application when runtime testing is authorized.
- Retirement: the selected runtime supports an equivalent upstream implementation and clipboard checks pass.

## P003: Cloud releases for the Intel Mac fork

- Status: active automation configuration. Hardware acceptance remains subject to P001 and P002.
- Required behavior: the T3 scheduled task performs integration and validation in a disposable GitHub Codespace. GitHub Actions builds the Intel Mac release, embeds `Saikrishna1876/t3code` as the update repository, verifies the packaged Electron `43.6.0` runtime, and publishes a DMG, ZIP, channel manifest, blockmaps, and checksums. Preserve the custom workflow and updater devcontainer across upstream merges.
- Implementation: `.github/workflows/fork-macos-release.yml` and `.devcontainer/fork-update/devcontainer.json`. Releases use increasing stable numeric versions and retain the exact source SHA in their notes. Duplicate source releases are skipped; partial uploads stay draft.
- Signing: builds remain downloadable without Apple credentials. Automatic macOS installation requires signing configured through the repository's Apple secrets and team variable. Do not claim an unsigned artifact has verified automatic installation.
- Verification: focused clipboard tests and desktop typecheck in the Codespace and Mac runner; archive integrity, packaged runtime, and embedded update repository in the workflow. Runtime graphics and clipboard acceptance on the target Mac stay separate.
- Retirement: the user replaces the cloud release process or no longer needs the Intel compatibility fork.

## Validation policy

Follow AGENTS.md. Use focused checks; no repo-wide suites. Browser/computer use requires the authorization described there. Keep runtime state away from the live install. Record manual graphics and clipboard checks as pending when unavailable.

## Latest attempt

- Date: 2026-10-07.
- Status: focused checks and CodeRabbit review passed in the isolated worktree; fork push and local release pending.
- Starting fork HEAD and rollback reference: `ba4aa5855a9ef6a453b443b9f9a9225419fd823a`. Original local main: `3ea74dcbad0c6d22f6e3507874996a990bde24b9`. Both clean. The fork's cloud-release configuration is included.
- Previous integrated upstream baseline: `4ee6bfd50ef4a089440d5c3662db2298da9cc50e`.
- Exact target: `bfec2387b8102975c84690f99be0f5f834fd0cbe`, resolved live from origin/main and fetched. Baseline ancestry verified; 196 upstream commits included.
- Review branch: `patch/upstream-20261007`. Worktree: `/private/tmp/t3code-upstream-review-20261007`.
- P001 retains Electron `43.6.0`. P002 retains tolerant text copying and synchronous image writes. The obsolete preview automation block and clipboard format helper were removed in favor of upstream's server-owned browser and native clipboard handling. P003 retains the workflow and devcontainer; workflow tests follow the new automation path.
- Review profile: `personal`, selected by the user. CodeRabbit reviewed all ten fork-diff files against the exact upstream target and reported zero findings. Greptile reviewed the pre-merge committed fork diff and reported two documentation findings, both addressed. Its merged-candidate review failed because code reviews are not enabled for this organization. The merged source is covered by CodeRabbit.
- `vp i` regenerated the lockfile and passed. Desktop manifest, importer, and installed Electron package resolve to `43.6.0`.
- Focused tests passed: 208 tests across desktop preview, ElectronShell, DesktopBrowserHost, mocked ServerBrowser, and packaging suites. Desktop typecheck and targeted source/test lint passed. Patch whitespace check passed.
- Local Intel macOS release requested. No cloud release dispatched. Hardware rendering and interactive clipboard acceptance remain pending; the behaviorally verified baseline is unchanged.
