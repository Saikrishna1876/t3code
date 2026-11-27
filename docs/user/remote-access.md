# Remote access

Drive T3 Code from your phone, browser (`app.t3.codes`), or another desktop app while your agents run on a host computer or server. The host must stay awake and running while you work.

## T3 Connect (recommended)

T3 Connect links your host to your other devices without router port-forwarding.

- **Desktop host**: Open **Settings → Sharing & access**, sign in, and turn on **T3 Connect** (note: closing the desktop app's last window stops its local server—use the [background service](./background-service.md) for unattended access).
- **CLI / headless host**: Run `t3 up` (or `t3 connect` / `t3 up --connect --lan --yes` for non-interactive scripts) and complete the printed sign-in link on any device. Check status with `t3 status [--json]`.
- **Other devices**: Sign in to the same T3 Connect account and pick the environment.

### Approve new devices

By default, any device signed into your T3 Connect account can connect. Turn on **Require approval for new devices** in **Settings → Sharing & access** on the host so new devices must present a short code (valid 10 minutes) that you approve from an existing device or via `t3 auth connect-device approve <code>`. Revoke devices anytime in **Settings → Sharing & access** or `t3 auth connect-device revoke <code>`.

### More machines with T3 Chat

Free T3 Connect accounts can link up to **3 host machines** (phones and browsers don't count). Link a paid T3 Chat account from your account menu → **T3 Chat → Link T3 Chat** to raise the limit to **10** (Pro) or **100** (Premier).

## Pair over a LAN or private network

- **Desktop host**: Enable **Settings → Sharing & access → Network access** (restarts desktop) and create a one-time pairing link.
- **CLI host**: Run `t3 up --lan` (background service) or `t3 serve --lan` (foreground), then run `t3 pair` to generate a QR code / pairing URL (`t3code://pair` opens directly in the desktop app).
- **Hosted web app (`app.t3.codes`)**: Requires an HTTPS endpoint (T3 Connect or Tailscale HTTPS). For plain HTTP on a LAN, open the direct pairing URL in a local browser or pair from the desktop/mobile app. For custom CAs on Android, install the CA certificate in Android security settings.
- **Session lifetime**: Paired devices stay signed in while active; sessions unused for 30 days must re-pair.

### Reach one machine several ways

A host can have multiple routes (LAN, Tailscale, VPN, public URL, SSH, T3 Connect). T3 Code automatically learns LAN and Tailscale routes when network access is enabled, connects over the fastest working route, and switches back to higher-priority routes when you return home. Reorder or add routes in **Settings → Environments** (**Add route**).

### Tailscale HTTPS

Join both devices to a tailnet with [MagicDNS and HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) enabled (on Linux, grant [operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)).

- **Desktop**: Enable **Settings → Sharing & access → Tailscale HTTPS**.
- **CLI**: Run `t3 serve --tailscale-serve` or `t3 pair --tailscale` (use `--tailscale-serve-port` if 443 is taken; remove with `tailscale serve --https=443 --set-path=/ off`).

### Balance new threads across machines

On web and desktop with 2+ connected machines, enable **Settings → Environments → Load balancing** (per client) to auto-select a host for new threads in shared projects. Set each machine to **Prefer**, **Normal**, **Less often**, or **Manual only**.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment → SSH** and enter a host or SSH alias (e.g. `user@example.com`). T3 Code downloads its runtime to `~/.t3/runtime` on the Linux or Apple Silicon macOS host, starts or reuses a server, and manages port forwarding automatically.

- Provider CLIs must be on a non-interactive login shell's `PATH` (check with `ssh user@example.com 'sh -lc "command -v claude codex"'`).
- For 2FA/Duo hosts on macOS/Linux, enable SSH `ControlMaster` in `~/.ssh/config` and open a terminal SSH session first.
- Revoke unused SSH sessions in **Settings → Sharing & access** or `t3 auth session revoke <id>`.

## GitHub Codespaces

Open **Settings, Environments, Codespaces** to create a cloud computer or add an
existing Codespace. New computers use GitHub's blank template. Choose a machine,
review the compute and storage charges, then create it. A computer can hold
several projects, each in `/workspaces/{project_name}`. Creation does not require
a project, GitHub repository, or devcontainer configuration.
In browser VS Code, open `/workspaces` to see every project's folder.
Rename, rebuild, or change a computer's machine size from the same settings
section. Stop the computer before changing its machine size. Rebuilding can
remove files outside `/workspaces` and affects every project on the computer.

Choose a project in the same settings section, then choose **Prepare project**.
The first connection copies the project's current committed branch and Git
history from your T3 host. Commit local changes first. A GitHub origin is optional.
Reconnecting preserves the remote checkout and any uncommitted remote changes.
Projects with the same folder name receive separate folders automatically.
Choose **New worktree** to give a thread its own branch and checkout on the
selected computer. Worktrees, file edits, terminals and checkpoints stay there;
your host's worktree directory setting applies only to local work.
Worktree setup and settle scripts run there too. Automatic cleanup follows the
same rules for local changes and submodules as local projects.
To open a remote worktree in an external editor, use VS Code or VS Code Insiders
with the GitHub Codespaces extension.

The **Run on** picker lists computers added in settings. Stopped computers stay
visible with a **Start** button. Start resumes the existing computer and its
files. Choose the host or a Codespace before creating a thread. That choice stays
fixed for the thread. The same project can have host and Codespace threads running
at once. Switching a draft between prepared computers does not move existing threads.
Scheduled and webhook tasks that create fresh threads have their own **Run on**
choice. Tasks that post into an existing thread keep that thread's computer.

A devcontainer is optional. When present, T3 attempts its lifecycle setup commands
with memory, process and CPU limits. If the computer cannot enforce those limits,
or setup fails, your project files remain available and T3 reports what needs
manual setup. Container images and features do not rebuild the shared computer.
Choose **Don't warn again for this project** to hide setup notices. Restore them
with **Show setup warnings** in the project's settings.

Use **Prepare cloud setup** in project settings to open instructions for your
agent. Review and send the draft when ready. It preserves existing draft text
and asks the agent to prepare setup without rebuilding the shared computer or
running an unrestricted dependency installation.

Your T3 host keeps thread history, the agent and provider login. It must stay
online with GitHub CLI signed in:

```sh
gh auth refresh -h github.com -s codespace
```

You can also choose **Sign in for Codespaces access** in Codespaces settings,
then enter the displayed code on GitHub. Existing GitHub permissions are retained.
If your host uses a token from Settings or its environment, add Codespaces
permission to that token instead.

Remote execution supports Claude Code and Codex 0.160.1 or later in the main
checkout or a worktree. No provider sign-in is required in the Codespace.
Commands, file browsing, terminals, Git and checkpoints use its filesystem.
Preview URLs are forwarded privately through your T3 host. Other providers are
not supported for this execution target.
The thread's **Servers** section shows the Codespace's CPU and memory usage and
servers running in its checkout. Open or stop those servers there. Servers
without a known thread owner appear as workspace servers.

Claude uses remote tools for reading, searching, editing and shell commands.
The agent reads skills and their text references from your T3 host through
`host_skills_list` and `host_skills_read`. Host skill paths do not exist in the
Codespace. A skill's scripts still need the runtime and accounts they use.
Native Claude subagents and background shell commands are unavailable.
Use the project terminal for persistent commands such as development servers.

For an MCP tool that needs your host, ask the agent to use `host_mcp_list` and
`host_mcp_call` with that server and tool. Each call uses the host connection;
other MCP tools keep their existing execution location. This bridge currently
requires an active Codex or Claude session. Claude may omit tool descriptions and input schemas; provide known arguments
when requesting a call. Other providers keep their native MCP tools.
Host MCP calls require a full-access thread in Default mode.

Finish or stop active turns on a Codespace before stopping, rebuilding or deleting it.
Host threads can keep running.
Stopping affects every project on that computer. Agents cannot stop, rebuild or
delete a computer shared with other projects; use Settings for those actions.
Local and remote edits are not
copied back automatically. Commit and push changes to use them in another checkout. Checkpoint refs belong to the checkout where they were captured.
Private repository pushes may require granting that Codespace access to the
repository through GitHub.

GitHub may charge for compute and retained storage. Deleting a computer removes
all its projects and unpushed files. Local thread history remains. Creation uses
a 30-minute idle timeout and one-day retention.

Web, desktop and mobile control computers through your T3 host's normal
connection. No separate pairing is needed. Agent management must be enabled in
Codespaces settings and is available only to full-access agents.

## Browser on a remote environment

Browser tabs belong to the host environment so you and your agents share them from any device.

- **Streaming & local loading**: Web and mobile stream tabs from the host. In the desktop app, tabs you open for a remote environment load locally while routing `localhost` requests to the host over the **preview tunnel** (so element picker and annotations work locally).
- **Port forwarding (desktop)**: Forward any remote host port to your local `localhost` via the thread's **Servers** list or **Forwarded ports** in the command palette (`Cmd/Ctrl-click` forwards and opens in your browser).
- **Open on this device (mobile)**: Tap **Open on this device** on a streamed `localhost` tab or long-press a `localhost` link in chat for native touch scrolling.
- **Disable preview tunnel**: Turn off **Settings → Sharing & access → Preview tunnel** on the host (or via [managed policy](./managed-policy.md#other-capabilities)) to disable port forwarding and **Open on this device** (streamed tabs continue working).
- **Take control**: Click **Take control** before typing into an agent's tab, and release control when done.
- **Local servers**: T3 Code lists listening ports from your terminals and agents as `http://localhost:<port>` (set a script's **Preview URL** for HTTPS or subpaths). Disable discovery with `T3CODE_PORT_DISCOVERY=0`.

### Browser host setup

The first server browser tab downloads ~120 MB headless Chromium (shared with [HTML renders](./html-renders.md)). On Ubuntu 23.10+ or minimal Linux containers, run the one-time setup command on the host:

```sh
sudo t3 browser setup
```

This installs an AppArmor profile for Chrome's sandbox plus missing libraries and fonts. Never run the T3 server as root (Chrome's sandbox rejects root); if sandboxing is impossible on your host, set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the server environment and restart.

## Link another environment

Link two T3 Code machines (beta) so agents on one can launch, message, delegate to, and manage threads on the other.

1. Enable **Settings → Labs → Linked environments** on **both** machines (or `"linkedEnvironmentsEnabled": true` in `userdata/settings.json`).
2. On the source machine, open **Settings → Environments → Linked environments → Link** (or drag from one machine's `+` to another on the Environments map, or run `t3 environment link <address> --pairing-code <code> --access <mode>`). Use **Link several…** or `--from <file>` for batch linking.
3. Links are one-way (tick **Also link … back** for two-way) and do not chain. Links expire after 30 days of inactivity and can be revoked in **Settings → Sharing & access** or **Forget**.

- **Access boundary**: Agents never get more permissions on the target than the link's access level or their own thread mode. Below Full access, linked agents can only modify threads they started and skip project setup scripts.
- **Delegation**: Agents can target a linked machine with `delegate_task`, or ask you to link an unlinked machine via an in-thread approval card.

### Read a linked machine's threads

Open a delegated task or thread link on a linked machine to follow it live (read-only) in the right panel without pairing your client directly. Click **Connect to interact** to pair and take action (one-click if the link has Full access and you can manage access). Files, images, and HTML renders stay on the remote machine until you connect directly.

## Manage or revoke access

Manage pairing links and active client sessions in **Settings → Sharing & access** or via `t3 auth --help`.

- **Scoped tokens**: Pass `--scope <scope>` (repeatable) to `t3 pair`, `t3 auth pairing create`, or `t3 auth session issue` to restrict permissions (e.g. `orchestration:read`, `source-control:write`, `filesystem:read`, `filesystem:write`, `terminal:operate`, `relay:configure`). Re-pair with a fresh link to change an existing client's scopes.
- **Deregister from T3 Connect**: Open your account menu → **T3 Connect → Deregister** (or `t3 connect unlink` / `t3 connect logout` on CLI hosts). Idle tunnels are automatically cleaned up after 5–10 minutes offline and recreated on reconnect (hosts on older versions offline for 7+ days need an update first).
- Treat pairing URLs and codes as passwords—never paste them into logs or screenshots.

## Desktop app as a remote only

Switch off **Settings → Environments → Local environment** in the desktop app to run with no local server, WSL backend, or incoming connections while continuing to drive remote hosts (if a local background service uses the same T3 home, **Open in** still works locally).

## Troubleshooting

See [T3 Connect troubleshooting](./t3-connect-troubleshooting.md) for step-by-step connection diagnostics, and [Outside agents](./outside-agents.md) for MCP connections.
