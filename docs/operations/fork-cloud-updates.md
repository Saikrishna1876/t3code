# Fork cloud updates

Manual release requests build locally for Intel macOS with publishing disabled.
Do not publish to GitHub or dispatch a publishing workflow unless the user explicitly
requests publication. This preference was reaffirmed on 2026-10-18. The cloud-only
build restriction below applies to scheduled cloud updates, not manual releases.

The T3 scheduled task updates `Saikrishna1876/t3code` in a disposable Linux GitHub
Codespace. The `Fork Intel Mac release` workflow packages and publishes the exact
validated `main` commit on a GitHub-hosted `macos-15-intel` runner. The local Mac
only controls GitHub through `gh`; no integration, dependency installation, tests,
or release build runs there. T3's server and provider must be available when the
task is due. This is not a GitHub cron job that runs while T3 is offline.

## Enable the task

These steps assume the fork-update scheduled task already exists in T3. The
repository does not create it. Choose its time and enable it in T3's scheduled
tasks UI. It posts run results into its original thread. GitHub CLI on the T3 environment must be authenticated as `Saikrishna1876`
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

The workflow supports unsigned downloads, a persistent private certificate, or
Apple Developer signing. Configure one signing method. Partial credentials or a
mixture of private and Apple credentials fail the build.

### Private certificate, no paid Apple account

Keep the same certificate and private key across builds. macOS TCC stores an app's
designated code requirement with its permission grant. Unsigned and ad-hoc builds
can get a code-hash requirement that changes between builds. A private certificate
allows a certificate-bound requirement. See [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
and [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).
This does not transfer an old hash-bound grant to the first signed build.

1. On your Mac, open Keychain Access. Choose Certificate Assistant, Create a
   Certificate. Use name `T3 Code Fork Signing`, identity type **Self Signed Root**,
   certificate type **Code Signing**. Enable overriding defaults to choose a long
   validity period, such as 3650 days. Create it in your login keychain.
2. Open the certificate's Trust section. Set **Code Signing** to **Always Trust**.
   Leave other trust policies at their defaults. Under My Certificates, confirm
   the certificate has a private key, then export that identity as
   `T3 Code Fork Signing.p12` with a strong, nonempty export password. Back up the
   encrypted P12 and password securely. Recreating a certificate with the same
   name creates a different identity and can require new permission grants.
3. Get the certificate fingerprint and confirm it appears as a valid signing
   identity. These commands show public identity information only:

   ```sh
   security find-certificate -c 'T3 Code Fork Signing' -p |
     openssl x509 -noout -fingerprint -sha1
   security find-identity -v -p codesigning
   ```

   Copy the 40 hexadecimal characters of the SHA-1 fingerprint without colons.
   Use this certificate fingerprint, not the app's CDHash.

4. After this PR merges, add two repository Actions secrets and one variable.
   Replace the P12 path and fingerprint below. The password command prompts for
   the export password. Do not paste the P12 or password into chat, source files,
   or workflow logs.

   ```sh
   base64 -i "$HOME/Documents/T3 Code Fork Signing.p12" |
     gh secret set MACOS_PRIVATE_CERTIFICATE --repo Saikrishna1876/t3code
   gh secret set MACOS_PRIVATE_CERTIFICATE_PASSWORD --repo Saikrishna1876/t3code
   gh variable set MACOS_PRIVATE_SIGNING_IDENTITY --repo Saikrishna1876/t3code \
     --body '<40-character-certificate-SHA1>'
   ```

   Leave the Apple signing secrets and `APPLE_TEAM_ID` variable unset. The runner
   imports the P12 into a temporary keychain, trusts its certificate only for code
   signing, checks its fingerprint, and removes the keychain and temporary signing
   material even if packaging fails. Neither the private key nor its password
   belongs in a build artifact.

5. Run a trial without publishing. This command uses the current `main` SHA and
   uploads downloadable Actions artifacts. It does not create a GitHub release.

   ```sh
   source_sha=$(gh api repos/Saikrishna1876/t3code/git/ref/heads/main --jq .object.sha)
   gh workflow run fork-macos-release.yml --repo Saikrishna1876/t3code --ref main \
     -f source_sha="$source_sha" -f publish=false
   ```

   Open the resulting run in Actions. Require all verification steps to pass.
   Download its `fork-intel-mac-*` artifact. The signature check extracts the ZIP,
   verifies nested signatures, checks the signing certificate, and requires a
   certificate-bound `com.t3tools.t3code` designated requirement. The artifact
   includes `designated-requirement.txt` for comparison between builds.

6. Install the first signed build manually when ready to replace the running app.
   Keep the installed bundle path and bundle ID stable. Private signing is not
   Apple notarization; macOS may require approval through Privacy & Security,
   Open Anyway. Do not disable Gatekeeper or remove quarantine recursively.
   Before opening it, check the downloaded app:

   ```sh
   codesign --verify --deep --strict --verbose=2 '/path/to/T3 Code (Beta).app'
   codesign -d -r- '/path/to/T3 Code (Beta).app'
   ```

   Compare its requirement with the Actions artifact. It must name
   `com.t3tools.t3code` and bind to your certificate, without a `cdhash` condition.

7. Launch the signed app. The previous unsigned grant may still appear enabled.
   If capture remains denied, use System Settings to remove the old Screen &
   System Audio Recording entry and authorize this signed app once. Follow any
   macOS request to quit and reopen it. Test `agent-desktop permissions` and a
   screenshot from an agent inside this T3 instance. Require app windows in the
   image; a wallpaper-only capture is not proof of permission. No TCC reset is
   part of this procedure.
8. Repeat with a second build from a different source commit, using the same
   P12, fingerprint, bundle ID and installation path. Its code hash must differ
   while its designated requirement still matches. Without changing permissions,
   confirm capture still works. This two-build test is the acceptance check for
   permission persistence. Until it passes, do not call screenshot capture fixed
   or private-certificate automatic updates verified.

When ready to publish, explicitly request a release or dispatch the workflow with
`-f publish=true` and the current validated `main` SHA. That creates a public
GitHub release. Keep manual installation until the updater has separately passed
an install test with this signing identity.

For an authorized local build with the certificate already installed, use:

```sh
vp run dist:desktop:artifact --platform mac --target dmg --arch x64 \
  --private-signing-identity '<40-character-certificate-SHA1>'
```

`T3CODE_MACOS_PRIVATE_SIGNING_IDENTITY` is the equivalent environment setting.
Do not combine it with `--signed` or `T3CODE_DESKTOP_SIGNED=true`. Private mode
requires the exact identity and fails if it cannot sign. It disables notarization,
automatic entitlement derivation, and hardened runtime to preserve the unsigned
fork's runtime access. Apple-provisioned passkey capabilities are unavailable in
this mode. It adds no screen-capture entitlement or permission bypass.

### Apple Developer signing

For Apple signing and notarization, required repository secrets are `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and
`MACOS_PROVISIONING_PROFILE`; repository variable `APPLE_TEAM_ID` supplies the
team. The provisioning profile must support this app's Associated Domains
capability. Optional `CLERK_PASSKEY_RP_DOMAINS` can override the passkey domains.
See [release operations](release.md). Leave the private signing secrets and
variable unset. Use the same identity for the first installed fork build and
subsequent releases.

### Unsigned downloads

With no signing configuration, releases contain unsigned downloads for manual
installation. Unsigned builds do not provide a stable certificate identity for
TCC. Do not rely on permission persistence or automatic macOS installation.

Install the first fork build manually so its embedded `app-update.yml` points at
this fork. Automatic checks then find this fork's published releases. T3 still
requires clicks to download and restart/install. Hardware graphics and clipboard
acceptance on the user's Mac remain manual; compilation does not prove P001's
rendering behavior.
