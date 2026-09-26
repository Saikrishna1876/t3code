# T3 Code compatibility patches

## Purpose

Keep desktop usable on the user's Intel Mac running unsupported macOS 15. User reports that a newer Chromium graphics change causes CPU rendering and lag, and has downgraded Electron locally. The graphics cause and runtime improvement have not been independently verified during this documentation setup.

## Update policy

- Canonical specification: `PATCH.md`.
- Upstream URL: https://github.com/pingdotgg/t3code.git
- Upstream remote: `origin`. The `fork` remote is the user's fork, not the update source.
- Target: latest upstream default branch, resolved live to an exact commit each update. Cached default branch at setup: `main`.
- Integration: prepare with `--no-ff --no-commit` in a separate worktree. Commit and push when the user requests updating `fork/main`; otherwise leave the result for review.
- Preserve original staged, unstaged, and untracked work. Carry the pending compatibility changes below and this specification into the review result.

## Baseline

- Observed integrated upstream baseline: `95030dc674883f0f2a7fd034b32ce742c8cf55d0`, landed on `fork/main` through merge `371e3bf00112eb2341d37f15c05f9cb027a929b5`.
- Previous integrated upstream baseline: `7c2702d68ae2e10fa9d3a08c996ed47c393dcffd`, landed through merge `c29ae7907`.
- Compatibility patches are committed. No pending local edits existed when this update started.
- Last behaviorally verified baseline: `56a9bf2bd7d3dcdae722a5de84578909dc11aeda` (release `0.0.42` built locally on 2026-09-18 with Electron `43.6.0` was extracted and interactively confirmed working by the user on the target Intel Mac macOS 15 system).

## P001: Preserve the compatible Electron runtime

- Status: active. Version observed in the user's existing patch, runtime result not independently verified.
- Required behavior: preserve desktop usability on the target Intel Mac. Retain exact Electron `43.6.0` until another version is verified on that machine and the constraint is deliberately revised.
- Implementation hints: `apps/desktop/package.json` changes Electron from `44.1.0` to `43.6.0`; `pnpm-workspace.yaml` aligns the minimum-release-age exception; `pnpm-lock.yaml` resolves the desktop importer and affected peer snapshots to `43.6.0`.
- Regenerate the lockfile through the current package manager when dependencies change. The current lockfile still contains `44.1.0` entries, so checking for that string globally is not a valid test of the active desktop runtime.
- Verification: confirm the desktop manifest, resolved importer, installed Electron binary, and packaged runtime agree. On the target machine, inspect Electron GPU feature status and renderer information, then check representative scrolling, chat rendering, and CPU use against the user's working baseline. Do not claim acceleration based only on compilation or a version number.
- Retirement: a newer runtime satisfies these hardware checks, or the user changes the hardware requirement. If upstream requires incompatible APIs, adapt those call sites or report the concrete blocker; do not silently upgrade Electron.

## P002: Keep clipboard behavior compatible with P001

- Status: active, observed alongside the runtime downgrade.
- Required behavior: text copying remains tolerant of clipboard failures and a synchronous return value. Preview image copying works without relying on `ClipboardItem`; invalid images and clipboard write failures retain meaningful errors. Automated preview paste preserves text, HTML, RTF, PNG, and custom formats using the pinned runtime, excluding Electron internal formats.
- Implementation hints: `apps/desktop/src/electron/ElectronShell.ts` awaits `clipboard.writeText` inside try/catch without calling `.catch` on its return value. `apps/desktop/src/preview/Manager.ts` uses `clipboard.writeImage` through the synchronous error wrapper. `apps/desktop/src/preview/Manager.test.ts` covers that clipboard path and synchronous failure.
- Paste implementation: `apps/desktop/src/preview/Clipboard.ts` uses synchronous format readers. `Manager.ts` wraps read failures with the existing operation error wrapper. Upstream's zero-argument `clipboard.read()` requires the newer API and cannot run on Electron 43.
- Verification from repo root: `./node_modules/.bin/vp test run apps/desktop/src/preview/Clipboard.test.ts apps/desktop/src/preview/Manager.test.ts apps/desktop/src/electron/ElectronShell.test.ts` and `vp run --filter @t3tools/desktop typecheck`. Confirm text and preview-image copying in the desktop application when runtime testing is authorized.
- Retirement: the selected runtime supports an equivalent upstream implementation and clipboard checks pass.

## Validation policy

Follow AGENTS.md. Use focused checks; no repo-wide suites. Browser/computer use requires the authorization described there. Keep runtime state away from the live install. Record manual graphics and clipboard checks as pending when unavailable.

## Previous update and release

- Date: 2026-09-11.
- Status: landed on `main` through merge commit `7318d06b6` after explicit user approval. Automated checks passed; runtime acceptance pending.
- Starting HEAD and previous integrated upstream baseline: `bb5e824c9fcbd76c93ef15b304f89f8b6999f32c`.
- Target: `02297e3dbd896ef619d5c916938c751e343e76a8`, resolved through live `git ls-remote --symref origin HEAD` and `git fetch origin main`. Includes 34 upstream commits.
- Review branch: `patch/upstream-20260911`.
- Review worktree: `/Users/saikrishnaambeti/Documents/opensource/t3code-upstream-review-20260911`.
- Canonical specification after landing: `/Users/saikrishnaambeti/Documents/opensource/t3code/PATCH.md`.
- P001 and P002 carried forward with three-way application of the captured binary diff. All six pending modified files and the original specification were included. No edits excluded; no conflicts or semantic adaptations needed. Upstream's Zed URL change and mobile Reanimated patch are retained.
- `vp i`: passed. Lockfile unchanged by package-manager validation. Desktop manifest, lockfile importer, and installed Electron package resolve to `43.6.0`. Install warned that shell Node `26.8.1` differs from the declared `^24.13.1` engine.
- `./node_modules/.bin/vp test run apps/desktop/src/preview/Manager.test.ts apps/desktop/src/electron/ElectronShell.test.ts`: passed, 100 tests across two suites. Initial global `vp test` attempts failed before collecting tests because the global runner used Vitest `4.1.10` while the local installation uses `4.1.11`; using the repository-local executable passed without source changes.
- `vp run --filter @t3tools/desktop typecheck`: passed, with Effect suggestions.
- `./node_modules/.bin/vp lint apps/desktop/src/electron/ElectronShell.ts apps/desktop/src/preview/Manager.ts apps/desktop/src/preview/Manager.test.ts`: passed.
- Local patch whitespace check against the exact target: passed. Whole merge whitespace check reports upstream whitespace in `patches/react-native-reanimated@4.5.1.patch`; retained verbatim to preserve patch content and hash.
- Before landing, original staged diff, unstaged diff, status, and specification matched captured bytes. The original edits remain in a backup stash named `backup: local compatibility patches before reviewed upstream merge`; main was fast-forwarded to the reviewed merge.
- Capture evidence: `/var/folders/26/8qwghqmn5sq9fsv3qw8_wlhm0000gn/T/t3-upstream-wuej_hi2`.
- Release build on main: `vp run dist:desktop:dmg:x64` passed under Node `24.21.0`. Unsigned Intel macOS app version `0.0.40`; packaged Electron framework `43.6.0` confirmed in staged app and final ZIP metadata. `hdiutil verify release/T3-Code-0.0.40-x64.dmg` passed. Artifacts: `release/T3-Code-0.0.40-x64.dmg` and `release/T3-Code-0.0.40-x64.zip`, with blockmaps. Build log: `/tmp/t3-release-20260911.log`.
- Pending: target-Mac GPU status, rendering performance, and interactive clipboard checks. No application or browser launched. These checks remain required for behavioral acceptance.
- Last behaviorally verified baseline: unknown and unchanged. Integration is landed; hardware acceptance remains unverified.

### Previous update: 2026-09-15

- Date: 2026-09-15.
- Status: landed on `fork/main` and local `main` at `873dc60601a74249afcee2a334efcffc15aaee9f`, including merge `8928da0d4c10fb614bb6cc51197173215686a6af`. Remote SHA verified after pushing.
- Starting fork HEAD and rollback reference: `1bb440d58eae64070c5fa98366a18448bf16ba64`. Original local `main`: `a87a284c7c307c45404fbe8597ac15852112654a`. Both checkouts were clean.
- Previous upstream baseline: `2ec59ca1fad6d9eb6ae36714b76b6130e63201e6`.
- Exact target: `50ff4c371eab927a9650c114975241999f4cd7b1`, fetched live from the explicitly requested `origin/main`. Baseline ancestry verified; 99 upstream commits included.
- Review branch: `patch/upstream-20260915`. Worktree: `/Users/saikrishnaambeti/Documents/opensource/t3code-upstream-review-20260915`.
- One lockfile conflict resolved by retaining upstream Clerk `0.0.42` and regenerating with `vp i` for Electron `43.6.0`. No source adaptations needed. All existing desktop compatibility files match the starting fork.
- `vp i`: passed. Desktop manifest, lockfile importer, installed Electron package, and framework `CFBundleVersion` agree on `43.6.0`. Runtime integrity script passed without launching the application. Installation warned about shell Node `26.8.1` versus required `^24.13.1` and peer dependencies.
- Repository-local `vp test run` for `Clipboard.test.ts`, `Manager.test.ts`, and `ElectronShell.test.ts`: passed, 103 tests in three suites.
- `vp run --filter @t3tools/desktop typecheck`: passed with Effect suggestions. Targeted lint for the five compatibility source and test files passed. Patch whitespace check against the exact upstream target passed.
- Logs: `/tmp/t3-patch-20260915-install.log`, `/tmp/t3-patch-20260915-tests.log`, `/tmp/t3-patch-20260915-typecheck.log`.
- Scope: no new fork UI, contracts, providers, or connection behavior. Existing desktop copy/paste paths preserved, including remotely requested preview automation. Upstream changes across all clients retained.
- Release built from `873dc60601a74249afcee2a334efcffc15aaee9f` with Node `24.21.0` using `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch x64 --output-dir /Users/saikrishnaambeti/Documents/opensource/t3code/release/20260915`. Unsigned macOS `0.0.40` DMG and ZIP, with blockmaps, are in `release/20260915` in the main checkout. Packaged Electron framework is `43.6.0`; ZIP integrity and `hdiutil verify` passed. Logs: `/tmp/t3-release-20260915.log` and `/tmp/t3-release-20260915-verify.log`.
- Target-Mac GPU status, rendering performance, and interactive clipboard acceptance remain pending. Last behaviorally verified baseline remains unknown.

### Previous update: 2026-09-18

- Date: 2026-09-18.
- Status: landed on `fork/main` and local `main` through merge `2af1dc896` and docs commit `91c92440a`. Remote SHA verified after pushing.
- Starting fork HEAD and rollback reference: `7d22399511914e0ea6f4b96cabadb7996d5b1b2e`. Both checkouts were clean.
- Previous upstream baseline: `50ff4c371eab927a9650c114975241999f4cd7b1`.
- Exact target: `56a9bf2bd7d3dcdae722a5de84578909dc11aeda`, fetched live from the explicitly requested `origin/main`. Baseline ancestry verified; 143 upstream commits included.
- Review branch: `patch/upstream-20260918`. Worktree: `/Users/saikrishnaambeti/Documents/opensource/t3code-upstream-review-20260918`.
- One lockfile conflict resolved by retaining upstream catalog updates (Effect rc.115, Clerk, Reanimated) and regenerating with `vp i` for Electron `43.6.0`. No source adaptations needed. All existing desktop compatibility files match the starting fork.
- `vp i`: passed. Desktop manifest, lockfile importer, and installed Electron package agree on `43.6.0`.
- Repository-local `vp test run` for `Clipboard.test.ts`, `Manager.test.ts`, and `ElectronShell.test.ts`: passed, 103 tests in three suites.
- `vp run --filter @t3tools/desktop typecheck`: passed with Effect suggestions. Targeted lint for compatibility source and test files passed.
- Scope: no new fork UI, contracts, providers, or connection behavior. Existing desktop copy/paste paths preserved, including preview automation. Upstream changes across all clients retained.
- Release build: `0.0.42` built locally via `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch x64 --output-dir /Users/saikrishnaambeti/Documents/opensource/t3code/release/20260918`. `hdiutil verify` on DMG and `unzip -tq` on ZIP passed. Packaged Electron framework `43.6.0` confirmed. User extracted the release on the target Intel Mac and confirmed interactive functionality and rendering performance work properly.

### Previous update: 2026-09-22

- Date: 2026-09-22.
- Status: verified and landed on `fork/main` and local `main` through merges `6f0eabe0e` and `c29ae7907`.
- Starting fork HEAD and rollback reference: `91c92440af309afd12de4b158ddf1a3bada226f3`. Both checkouts clean.
- Previous upstream baseline: `56a9bf2bd7d3dcdae722a5de84578909dc11aeda`.
- Exact target: `7c2702d68ae2e10fa9d3a08c996ed47c393dcffd`, fetched live from `origin/main`. Baseline ancestry verified; 129 upstream commits included. Origin advanced by one commit after the initial `da6a85b13` landing, so the final merge also includes upstream's composer panel-animation fix.
- Review branch: `patch/upstream-20260922`. Worktree: `/Users/saikrishnaambeti/Documents/opensource/t3code-upstream-review-20260922`.
- Conflicts resolved:
  - `apps/desktop/package.json`: retained `"electron": "43.6.0"` (P001) while adopting upstream `"electron-updater": "^6.8.9"`.
  - `pnpm-workspace.yaml`: retained `- electron@43.6.0` in `minimumReleaseAgeExclude` (P001) while adopting upstream SDK updates and removal of `msgpackr-extract`.
  - `pnpm-lock.yaml`: taken from upstream baseline and regenerated via `vp i` to lock Electron to `43.6.0`.
- `vp i`: passed in 6m 24s.
- Final manifest, lockfile importer, and installed Electron package resolve to `43.6.0`.
- Repository-local `vp test run` for `Clipboard.test.ts`, `Manager.test.ts`, and `ElectronShell.test.ts`: passed against the final target, 106 tests across three suites (0 failures).
- `vp run --filter @t3tools/desktop typecheck`: passed against the final target (0 errors, Effect suggestions only).
- Targeted lint for all six compatibility source and test files: passed against the final target (0 errors, 0 warnings).
- Final follow-up merge changed only `apps/web/src/components/chat/ChatComposer.tsx`; no P001 or P002 files required adaptation.
- Scope: upstream changes across all clients retained; compatibility patches P001 and P002 intact.
- Release build: unsigned Intel macOS `0.0.42` built from `e5434039e` with Node `24.21.0` via `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch x64 --output-dir /Users/saikrishnaambeti/Documents/opensource/t3code/release/20260922`. `hdiutil verify` on the DMG and `unzip -tq` on the ZIP passed. Packaged Electron framework `43.6.0` confirmed. Build log: `/tmp/t3-release-20260922.log`. Target-Mac interactive acceptance remains pending.

## Latest attempt

- Date: 2026-09-26.
- Status: landed on `fork/main` through merge `371e3bf00112eb2341d37f15c05f9cb027a929b5`; remote SHA verified after push. Focused checks and local release build passed.
- Starting fork HEAD and rollback reference: `9e947368987ae4a0366cc273501fcdac5ea13d23`. Original checkout clean.
- Previous upstream baseline: `7c2702d68ae2e10fa9d3a08c996ed47c393dcffd`.
- Exact target: `95030dc674883f0f2a7fd034b32ce742c8cf55d0`, resolved through live `git ls-remote --symref origin HEAD` and `git fetch origin main`. Baseline ancestry verified; 199 upstream commits included.
- Review branch: `patch/upstream-20260926`. Worktree: `/private/tmp/t3code-upstream-review-20260926`.
- Merge had no conflicts. P001 retains Electron `43.6.0` in the desktop manifest, release-age exception, and desktop lockfile importer. P002 retains synchronous clipboard reads and image writes while accepting upstream's changes to preview manager. Upstream's `boot.cjs` desktop entry point is retained.
- `vp i`: passed. Lockfile regenerated for transitive dependencies. Installed Electron package resolves to `43.6.0`.
- Repository-local `vp test run` for `Clipboard.test.ts`, `Manager.test.ts`, and `ElectronShell.test.ts`: passed, 106 tests across three suites. Desktop typecheck and targeted lint for all six compatibility source and test files passed.
- Release: unsigned Intel macOS `0.0.42` DMG and ZIP built from the merged tree with Node `24.21.0` using `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch x64 --output-dir /Users/saikrishnaambeti/Documents/opensource/t3code/release/20260926`. `hdiutil verify` and `unzip -tq` passed. The packaged Electron framework reports `43.6.0`. Artifacts are in `release/20260926` in the main checkout.
- No browser or application launched. Target-Mac GPU status, rendering performance, and interactive clipboard checks remain pending.
