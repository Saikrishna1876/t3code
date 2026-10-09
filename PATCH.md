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

- Observed integrated upstream baseline: `33806e73555107b8ac8fb18fd15b9dfb87ec6557`, committed through merge `becb9df9f34c64976b939e9eb9ca756d1f53e562` and pushed to fork/main on 2026-10-09. Git ancestry and the live remote branch confirm integration.
- Previous integrated upstream baseline: `bfec2387b8102975c84690f99be0f5f834fd0cbe`, landed through merge `27be76116afa6baaf67620d536da4ec185e4c762`.
- Compatibility patches are committed. No pending local edits existed when this update started.
- Last behaviorally verified baseline: `56a9bf2bd7d3dcdae722a5de84578909dc11aeda` (release `0.0.42` built locally on 2026-09-18 with Electron `43.6.0` was extracted and interactively confirmed working by the user on the target Intel Mac macOS 15 system).

## P001: Preserve the compatible Electron runtime

- Status: active. Version observed in the user's existing patch, runtime result not independently verified.
- Required behavior: preserve desktop usability on the target Intel Mac. Retain exact Electron `43.6.0` until another version is verified on that machine and the constraint is deliberately revised.
- Implementation hints: `apps/desktop/package.json` pins Electron to `43.6.0` instead of upstream's `44.4.5`; `pnpm-workspace.yaml` aligns the minimum-release-age exception; `pnpm-lock.yaml` resolves the desktop importer and affected peer snapshots to `43.6.0`.
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

- Date: 2026-10-09.
- Status: landed. Integration merge `becb9df9f34c64976b939e9eb9ca756d1f53e562` was pushed to fork/main without force and verified live. Local release build and archive verification passed. The user requested updating fork/main and creating a release on the local Intel Mac. This manual release is authorized locally; the scheduled cloud policy remains unchanged.
- Starting fork HEAD and rollback reference: `9b53b9fc028b8eee682a4000b2ee6eb91e2a5b57`. Original task checkout: `33806e73555107b8ac8fb18fd15b9dfb87ec6557`, clean and upstream-only. The review starts from fork/main to include its committed patches. No pending edits were excluded.
- Previous integrated upstream baseline: `bfec2387b8102975c84690f99be0f5f834fd0cbe`.
- Exact target: `33806e73555107b8ac8fb18fd15b9dfb87ec6557`, resolved live from origin/main and fetched. Baseline ancestry verified; 187 upstream commits included.
- Review branch: `patch/upstream-20261009`. Worktree: `/Users/saikrishnaambeti/Documents/opensource/t3code-upstream-review-20261009`.
- P001 retains Electron `43.6.0`. P002 retains tolerant text copying and synchronous image writes, while incorporating upstream preview downloads, annotation permissions, tab behavior, and remote editor links. P003 retains the fork workflow, updater repository, and devcontainer.
- Conflicts in the desktop manifest, workspace age exception, preview Electron imports, and generated lockfile were resolved. The lockfile is regenerated from upstream against the preserved manifest.
- Review profile: `personal`, selected by the user. CodeRabbit reviewed nine fork-diff files and reported one finding about the root CLI missing from filtered installs. The clean installation using the workflow's exact filters created `node_modules/.bin/vp` and completed the root prepare script, so the finding is rejected with direct install evidence. Generated lockfiles are excluded by the reviewer. Greptile's committed candidate review was attempted and failed because code reviews are not enabled for the organization. CodeRabbit covers the merged fork source; Greptile coverage remains unavailable.
- Focused checks passed: 151 clipboard/browser tests, 76 packaging tests, desktop typecheck, targeted source/test lint, and fork-diff whitespace. The first packaging run inherited T3's `ELECTRON_RUN_AS_NODE=1` and failed a Windows fixture assertion; rerunning only the packaging suite with that variable removed passed. The installed and integrity-checked Electron runtime is `43.6.0`.
- The filtered install regenerated the lockfile successfully. Targeted lint initially lacked `@oxlint/plugins`; installing the lint-plugin workspace from the frozen lockfile fixed the local verification environment without source changes. Desktop typecheck reported only an upstream style suggestion in `DesktopClerk.test.ts`.
- Local unsigned Intel macOS `0.0.46` release built from `becb9df9f34c64976b939e9eb9ca756d1f53e562` with Node `24.21.0`. DMG, ZIP, blockmaps, update manifest, release metadata, and SHA-256 checksums are in `/Users/saikrishnaambeti/.t3/worktrees/t3code/t3-1146d6fc/release/20261009`.
- `hdiutil verify` and `unzip -tq` passed. Archive inspection confirms app version `0.0.46`, Electron framework `43.6.0`, x64 Mach-O executable, and `Saikrishna1876/t3code` update repository. Release package versions were aligned for the build and restored afterward; public configuration came from `.env.example` and the temporary `.env` was removed.
- No cloud release dispatched or application/browser launched. Hardware rendering and interactive native-format clipboard acceptance remain pending; the behaviorally verified baseline is unchanged. The unsigned artifacts require manual installation; automatic installation was not verified. The original task checkout and local main were not moved.
- Logs: `/tmp/t3-patch-20261009-{install,tests,typecheck,lint,coderabbit,greptile}.log` and `/tmp/t3-release-20261009.log`.
- Prior successful release: 2026-10-07, version `0.0.45`, source `49b07dc3cb8e105c69ed93885ba0e6e80990762b`. DMG and ZIP integrity, packaged Electron `43.6.0`, x64 architecture, and fork feed checks passed. CodeRabbit had zero findings; Greptile's merged review was unavailable because reviews were disabled for the organization.
