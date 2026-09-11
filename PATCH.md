# T3 Code compatibility patches

## Purpose

Keep desktop usable on the user's Intel Mac running unsupported macOS 15. User reports that a newer Chromium graphics change causes CPU rendering and lag, and has downgraded Electron locally. The graphics cause and runtime improvement have not been independently verified during this documentation setup.

## Update policy

- Canonical specification: `PATCH.md`.
- Upstream URL: https://github.com/pingdotgg/t3code.git
- Upstream remote: `origin`. The `fork` remote is the user's fork, not the update source.
- Target: latest upstream default branch, resolved live to an exact commit each update. Cached default branch at setup: `main`.
- Integration: merge into a new local review branch in a separate worktree; leave uncommitted with `--no-ff --no-commit`.
- Preserve original staged, unstaged, and untracked work. Carry the pending compatibility changes below and this specification into the review result.

## Baseline

- Observed local HEAD: `bb5e824c9fcbd76c93ef15b304f89f8b6999f32c`.
- Compatibility changes are uncommitted on that base. Creating a worktree from HEAD alone omits them.
- Last behaviorally verified baseline: unknown. No install, build, test, or graphics check was run during setup.
- Observed integrated upstream baseline: `bb5e824c9fcbd76c93ef15b304f89f8b6999f32c`. Live fetch on 2026-09-11 confirmed it is an ancestor of upstream `main`. The review merge remains uncommitted, so the landed baseline is unchanged.

## P001: Preserve the compatible Electron runtime

- Status: active. Version observed in the user's existing patch, runtime result not independently verified.
- Required behavior: preserve desktop usability on the target Intel Mac. Retain exact Electron `43.6.0` until another version is verified on that machine and the constraint is deliberately revised.
- Implementation hints: `apps/desktop/package.json` changes Electron from `44.1.0` to `43.6.0`; `pnpm-workspace.yaml` aligns the minimum-release-age exception; `pnpm-lock.yaml` resolves the desktop importer and affected peer snapshots to `43.6.0`.
- Regenerate the lockfile through the current package manager when dependencies change. The current lockfile still contains `44.1.0` entries, so checking for that string globally is not a valid test of the active desktop runtime.
- Verification: confirm the desktop manifest, resolved importer, installed Electron binary, and packaged runtime agree. On the target machine, inspect Electron GPU feature status and renderer information, then check representative scrolling, chat rendering, and CPU use against the user's working baseline. Do not claim acceleration based only on compilation or a version number.
- Retirement: a newer runtime satisfies these hardware checks, or the user changes the hardware requirement. If upstream requires incompatible APIs, adapt those call sites or report the concrete blocker; do not silently upgrade Electron.

## P002: Keep clipboard behavior compatible with P001

- Status: active, observed alongside the runtime downgrade.
- Required behavior: text copying remains tolerant of clipboard failures and a synchronous return value. Preview image copying works without relying on `ClipboardItem`; invalid images and clipboard write failures retain meaningful errors.
- Implementation hints: `apps/desktop/src/electron/ElectronShell.ts` awaits `clipboard.writeText` inside try/catch without calling `.catch` on its return value. `apps/desktop/src/preview/Manager.ts` uses `clipboard.writeImage` through the synchronous error wrapper. `apps/desktop/src/preview/Manager.test.ts` covers that clipboard path and synchronous failure.
- Verification from repo root: `./node_modules/.bin/vp test run apps/desktop/src/preview/Manager.test.ts apps/desktop/src/electron/ElectronShell.test.ts` and `vp run --filter @t3tools/desktop typecheck`. Confirm text and preview-image copying in the desktop application when runtime testing is authorized.
- Retirement: the selected runtime supports an equivalent upstream implementation and clipboard checks pass.

## Validation policy

Follow AGENTS.md. Use focused checks; no repo-wide suites. Browser/computer use requires the authorization described there. Keep runtime state away from the live install. Record manual graphics and clipboard checks as pending when unavailable.

## Latest attempt

- Date: 2026-09-11.
- Status: prepared, automated checks passed; runtime acceptance pending. Merge is staged and uncommitted with `MERGE_HEAD` present.
- Starting HEAD and previous integrated upstream baseline: `bb5e824c9fcbd76c93ef15b304f89f8b6999f32c`.
- Target: `02297e3dbd896ef619d5c916938c751e343e76a8`, resolved through live `git ls-remote --symref origin HEAD` and `git fetch origin main`. Includes 34 upstream commits.
- Review branch: `patch/upstream-20260911`.
- Review worktree: `/Users/saikrishnaambeti/Documents/opensource/t3code-upstream-review-20260911`.
- Canonical review specification: this worktree's root `PATCH.md`.
- P001 and P002 carried forward with three-way application of the captured binary diff. All six pending modified files and the original specification were included. No edits excluded; no conflicts or semantic adaptations needed. Upstream's Zed URL change and mobile Reanimated patch are retained.
- `vp i`: passed. Lockfile unchanged by package-manager validation. Desktop manifest, lockfile importer, and installed Electron package resolve to `43.6.0`. Install warned that shell Node `26.8.1` differs from the declared `^24.13.1` engine.
- `./node_modules/.bin/vp test run apps/desktop/src/preview/Manager.test.ts apps/desktop/src/electron/ElectronShell.test.ts`: passed, 100 tests across two suites. Initial global `vp test` attempts failed before collecting tests because the global runner used Vitest `4.1.10` while the local installation uses `4.1.11`; using the repository-local executable passed without source changes.
- `vp run --filter @t3tools/desktop typecheck`: passed, with Effect suggestions.
- `./node_modules/.bin/vp lint apps/desktop/src/electron/ElectronShell.ts apps/desktop/src/preview/Manager.ts apps/desktop/src/preview/Manager.test.ts`: passed.
- Local patch whitespace check against the exact target: passed. Whole merge whitespace check reports upstream whitespace in `patches/react-native-reanimated@4.5.1.patch`; retained verbatim to preserve patch content and hash.
- Original staged diff, unstaged diff, status, and specification match captured bytes. Original branch and HEAD remain unchanged.
- Capture evidence: `/var/folders/26/8qwghqmn5sq9fsv3qw8_wlhm0000gn/T/t3-upstream-wuej_hi2`.
- Pending: installed Electron binary is absent in this review installation; packaged runtime, target-Mac GPU status, rendering performance, and interactive clipboard checks were not run. No application or browser launched. These checks remain required for behavioral acceptance.
- Last behaviorally verified baseline: unknown and unchanged. This is an automated-checks-passed candidate, not a landed or hardware-verified update.
