# Fork cloud updates

The T3 scheduled task updates `Saikrishna1876/t3code` in a disposable Linux GitHub
Codespace. The `Fork Intel Mac release` workflow packages and publishes the exact
validated `main` commit on a GitHub-hosted `macos-15-intel` runner. The local Mac
only controls GitHub through `gh`; no integration, dependency installation, tests,
or release build runs there. T3's server and provider must be available when the
task is due. This is not a GitHub cron job that runs while T3 is offline.

## Enable the task

The task is initially disabled with a daily placeholder schedule. Choose its time
and enable it in T3's scheduled tasks UI. It posts run results into the original
thread. GitHub CLI on the T3 environment must be authenticated as `Saikrishna1876`
with repository, workflow, and Codespaces access:

```sh
gh auth refresh -h github.com -s codespace
```

The task creates its own Codespace using
`.devcontainer/fork-update/devcontainer.json`, with a short idle timeout and
retention period. It must retain the returned name, use that exact Codespace for
SSH, and delete only that Codespace after its validated changes are pushed. Failed
or dirty integration work must be preserved by stopping that Codespace, recording
its name and failure, and reporting its retention deadline. Never delete another
Codespace or reuse one belonging to interactive work.

All merge commands, patch adaptations, dependency installation, and focused checks
run inside the Codespace. `PATCH.md` is the compatibility contract. On success,
commit and push to fork `main` without force, then dispatch:

```sh
gh workflow run fork-macos-release.yml --repo Saikrishna1876/t3code --ref main -f source_sha=<full-validated-commit-sha>
```

A Codespace's default token may not permit pushing updated workflow files. If it
cannot, pass the controlling environment's existing GitHub credential through SSH
stdin for that one push, using `gh auth git-credential` as the temporary Git
credential helper. Do not print the credential, save it in a file, put it in a URL,
or change the account's repository secrets.

## Releases

The workflow skips a source SHA already present in a published fork release. It
chooses a stable numeric version greater than the checked-out base version and
existing stable release versions. It creates a draft with all assets before
publishing it as latest. Failed drafts remain available for diagnosis; they are
excluded from the update feed. Retry a failed build with a new workflow dispatch;
do not rerun an old attempt whose source no longer matches `main`.

Before creating cloud resources, check for an active fork release run. Skip
creation if an existing run is building the current source; resume monitoring that
run instead. Once integration succeeds, delete the Codespace without waiting for
the Mac build. The scheduled agent tracks the exact Actions run through completion
and reports its release URL or failure. Do not start overlapping integrations or
claim success from workflow dispatch alone.

## macOS signing

Without signing credentials, releases contain unsigned downloads for manual
installation. For automatic macOS installation, configure the same Apple Developer
identity for the first installed fork build and subsequent releases. Required
repository secrets are `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `MACOS_PROVISIONING_PROFILE`; repository
variable `APPLE_TEAM_ID` supplies the team. The provisioning profile must support
this app's Associated Domains capability. Optional `CLERK_PASSKEY_RP_DOMAINS` can
override the passkey domains. See the Apple setup in [release operations](release.md).
A partially configured signing setup fails instead of silently publishing an
unsigned build.

Install the first fork build manually so its embedded `app-update.yml` points at
this fork. Automatic checks then find this fork's published releases. T3 still
requires clicks to download and restart/install. Hardware graphics and clipboard
acceptance on the user's Mac remain manual; compilation does not prove P001's
rendering behavior.
