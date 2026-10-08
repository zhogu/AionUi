# AionUi Web prebuilt package

This branch contains a ready-to-deploy **Linux x86_64** build of AionUi Web
2.2.2, rebuilt on 2026-10-08 with hostname/session browser tab titles, quiet-stream HTTP catch-up, workspace-relative Markdown file previews with line navigation, persistent startup recovery, completion-message reconciliation, interrupted-download recovery, recoverable initial Copilot Allow all setup, context-window selection, Copilot draft
queuing, native session titles, configuration-command routing, verified session
recovery, graceful idle shutdown, realtime message reconciliation, duplicate final
message fixes, single-message copying and CLI session ID display/copying from the
conversation list's **… → CLI session ID** menu. The session dialog reads persisted
metadata on demand without starting the agent; it works with built-in Copilot and
the custom adapter (and other ACP sessions). It also includes the mobile-client
task-completion changes from PR #3.
The packaged `build-info.json` records the exact frontend/build source commit,
backend source commit, backend checksum, build profile and build time.
This package uses AionCore `65bb22a`, including the session identity detail API
(Rust dev profile with debug information disabled and symbols stripped).
Logo assets are embedded even in dev builds, fixing AionCore issue #1009 on
machines without the backend source checkout.
No Node.js, Bun, dependency installation, or local build is required.
Native Copilot CLI must still be installed and authenticated separately.

Deployment sections: [Install](#install), [Standard service](#standard-linux-service),
[Migration](#migrate-an-existing-user-service), [Upgrade](#upgrade-an-existing-service),
[nginx / HTTPS](#nginx--https), [Missing icons](#diagnosing-missing-icons).

## Install

```bash
git clone --branch build --single-branch https://github.com/zhogu/AionUi.git AionUi-build
cd AionUi-build/prebuilt/linux-x86_64
bash install.sh
```

If this checkout already exists, run `git pull --ff-only` on `build` first.
Stop an existing service on the **target machine** before replacing its installation.
The installer backs up the old installation but does not stop/start services or
modify conversation data.

For a temporary foreground run only (not a registered service):

```bash
~/.local/bin/aionui-web start --port 25808 --no-open
```

For a permanent Linux deployment, follow [Standard Linux service](#standard-linux-service).
Do not run the foreground command alongside an existing service.

The installer reconstructs the archive from the GitHub-safe split files,
verifies its SHA-256 checksum, installs it under
`~/.local/share/aionui-web`, and creates `~/.local/bin/aionui-web`.

Use `INSTALL_DIR` and `BIN_DIR` to override those paths:

```bash
INSTALL_DIR=/opt/aionui-web BIN_DIR=/usr/local/bin bash install.sh
```

Run the installer as the account that owns the installation, not with `sudo`
unless you intentionally use system-wide paths. Use `sudo` only for service/nginx
management. The default data directory is `~/.aionui-web`, outside the installation;
keep your existing `--data-dir` / `AIONUI_DATA_DIR` settings when upgrading.
Do not put conversation data inside `INSTALL_DIR`.

The installation contains:

```text
~/.local/share/aionui-web/
├── aionui-web
├── copilot-acp
├── build-info.json
├── static/                              # Browser JS/CSS and frontend assets
└── bundled-aioncore/linux-x64/aioncore   # Backend, with logo bytes embedded
```

**`/api/assets/logos/tools/github.svg` is a backend HTTP endpoint, not a file
under `static/`.** There is deliberately no requirement for a separate
`tools/github.svg` file in the installation. The bundled backend serves these
logos without an AionCore source checkout. Do not copy only `static/`, point nginx
at a source-tree logo directory, or download individual logos as an upgrade fix.

The installer checks the archive checksum, backs up the previous installation
beside it as `aionui-web.backup.<timestamp>`, and replaces the installation as a
unit. It does **not** configure systemd, nginx, TLS certificates, firewall rules,
or agent authentication. The archive checksum validates the downloaded package,
not which executable an already-running service is using.

## Standard Linux service

This is the canonical deployment convention for this fork's standalone Linux
WebUI package, not the Electron `.deb` / Xvfb installer. New deployments use:

| Setting                          | Convention                                                               |
| -------------------------------- | ------------------------------------------------------------------------ |
| Service name / manager           | `aionui-webui.service`, **system** systemd                               |
| Service file                     | `/etc/systemd/system/aionui-webui.service`                               |
| Runtime identity                 | Ordinary installation owner, never root                                  |
| Program                          | `/home/YOUR_USER/.local/share/aionui-web/aionui-web`                     |
| Home / initial working directory | The installation owner's actual home                                     |
| Persistent data                  | Explicit `--data-dir`, default `/home/YOUR_USER/.aionui-web`             |
| Listen address / port            | `127.0.0.1:25808`, behind nginx HTTPS                                    |
| Status / logs                    | `sudo systemctl` / `sudo journalctl`, **without** `--user`               |
| Startup                          | Enabled at boot; independent of interactive login, no user linger needed |

Existing ports and data directories are **not renamed** by this convention.
For example, preserve port `25818` and
`/home/ggspace/.config/AionUi/aionui` when migrating that deployment; changing
the data directory can make existing conversations appear missing. A service
managed by the system can still run entirely as an ordinary user.

### Register a new deployment

Install the package and authenticate Copilot as the intended runtime user first.
Systemd does not source Conda, NVM or shell startup files: add the actual CLI
directory to the template's `PATH` if it is not already included. Preserve any
required `COPILOT_HOME`, `AIONUI_COPILOT_CLI` or other environment settings when
migrating. Do not copy credentials into a world-readable unit or post them in logs.

Before creating a service, check both managers and the chosen port:

```bash
systemctl list-unit-files --type=service --no-pager | grep -Ei 'aion' || true
systemctl --user list-unit-files --type=service --no-pager | grep -Ei 'aion' || true
sudo ss -ltnp 'sport = :25808'
```

An existing service or listener requires inspection/migration, not a second
instance. The user-manager command only checks the current user; installations
owned by another account must be checked under that account too.

From `prebuilt/linux-x86_64`, copy the supplied template into a staging directory:

```bash
mkdir -p ~/.config/aionui-service-staging
cp -i aionui-webui.service ~/.config/aionui-service-staging/aionui-webui.service
```

Edit that staged file before proceeding. Replace **every** `YOUR_USER` /
`YOUR_GROUP` (`id -un` / `id -gn` identify the current account), use the actual
absolute home and installation paths, and set the intended port/data directory.
Systemd unit values do not expand `~` or shell `$HOME`. Quote paths containing
spaces using systemd syntax. Keep any existing explicit `--log-dir`; otherwise
use journald for service stdout/stderr.

The following block deliberately refuses to overwrite an existing system unit:

```bash
(
  set -e
  unit="$HOME/.config/aionui-service-staging/aionui-webui.service"
  if grep -qE 'YOUR_USER|YOUR_GROUP' "$unit"; then
    echo 'Edit the service template placeholders first.' >&2
    exit 1
  fi
  sudo -v
  if sudo systemctl cat aionui-webui.service >/dev/null 2>&1 ||
     sudo test -e /etc/systemd/system/aionui-webui.service ||
     sudo test -L /etc/systemd/system/aionui-webui.service; then
    echo 'Existing system unit found; inspect it instead of overwriting it.' >&2
    exit 1
  fi
  systemd-analyze verify "$unit"
  sudo install -m 0644 "$unit" /etc/systemd/system/aionui-webui.service
  sudo systemctl daemon-reload
)
```

For a **new deployment with no old instance**, start and check it:

```bash
sudo systemctl enable --now aionui-webui.service
sudo systemctl status aionui-webui.service --no-pager -l
sudo journalctl -u aionui-webui.service -n 100 --no-pager
curl --noproxy '*' -fsS --max-time 15 -o /dev/null \
  -w 'HTTP %{http_code}, %{size_download} bytes, %{time_total}s\n' \
  http://127.0.0.1:25808/
```

`active (running)` alone is insufficient: the full HTTP request must complete.
Then check authenticated browser API requests and `/ws` (101 handshake) through
nginx. If startup fails, inspect the journal before enabling any other instance.
`NoNewPrivileges=true` intentionally prevents agents from gaining privileges
through `sudo`; administer the service from an SSH/admin shell, not an agent tool.

### Memory budget

The template enables accounting but does **not** impose a universal memory cap.
Limits apply to the whole service tree: WebUI, AionCore, Copilot and tool subprocesses.
Budget for concurrent agents and other services on the host. A 384 MiB high /
512 MiB maximum budget caused continuous reclaim and an unresponsive listening
port in a real deployment; restarting or increasing nginx timeouts is not the fix.

Where host capacity supports it, an example (not a required default) is:

```bash
sudo systemctl set-property aionui-webui.service MemoryHigh=1536M MemoryMax=2G
sudo systemctl show aionui-webui.service \
  -p MemoryCurrent -p MemoryHigh -p MemoryMax -p ControlGroup -p DropInPaths
```

This persists resource overrides without restarting. For an existing user service,
use `systemctl --user set-property ACTUAL_NAME.service ...` instead. Its generated
`~/.config/systemd/user.control/` settings are **not** inherited by a new system
service. Inspect effective limits, ancestor cgroup limits and host memory; carry
the intended budget across migration, not the old restrictive drop-in.

## Migrate an existing user service

Migration is manual and requires a maintenance window. **Stop interrupts agent
work.** Do not migrate during running requests, and do not run both managers
against the same data directory, even on different ports.

1. As the existing installation owner, inspect `systemctl --user cat aionui.service`
   and `systemctl --user show aionui.service -p ExecStart -p Environment -p DropInPaths -p MemoryHigh -p MemoryMax`.
   Record whether it was enabled, and preserve its unit/drop-ins for rollback.
   These outputs can contain secrets: keep them local.
2. Prepare/register the system unit as above, **without starting or enabling it**.
   Preserve the runtime user, HOME, executable, PATH, data/log directories, port,
   agent environment and reviewed resource budget. Do not reinstall the program
   or change nginx at the same time as changing managers.
3. Wait for work to finish. Stop the old unit, take a consistent backup of the
   actual data directory, and confirm the old service's child processes and port
   listener have exited. Do not force-kill them to proceed.
4. Start the new unit; verify direct HTTP, nginx, login, existing conversations
   and WebSocket connectivity. Only then disable the old unit and enable the new.

For the known legacy **user** service `aionui.service` on port **25818**:

```bash
# Run as its owner. Stop here for the data backup and process/listener checks.
systemctl --user stop aionui.service
systemctl --user is-active aionui.service
sudo ss -ltnp 'sport = :25818'

# Proceed only after the old instance has fully stopped and backup is complete.
sudo systemctl start aionui-webui.service
sudo systemctl status aionui-webui.service --no-pager -l
curl --noproxy '*' -fsS --max-time 15 -o /dev/null \
  -w 'HTTP %{http_code}, %{size_download} bytes, %{time_total}s\n' \
  http://127.0.0.1:25818/

# After browser verification succeeds:
systemctl --user disable aionui.service
sudo systemctl enable aionui-webui.service
```

If verification fails, **stop and confirm the new instance has exited first**,
then roll back to the preserved user unit:

```bash
sudo systemctl disable --now aionui-webui.service
sudo ss -ltnp 'sport = :25818'
# Only after the port and new service process tree are clear:
systemctl --user start aionui.service
# If the old unit was enabled before migration, restore that setting:
systemctl --user enable aionui.service
```

Do not remove the old configuration/data as part of migration. Do not disable
user linger globally: other user services may rely on it.

### Routine operations

| Operation                 | Standard system service                                     | Legacy user service (example)                           |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Status                    | `sudo systemctl status aionui-webui.service`                | `systemctl --user status aionui.service`                |
| Recent logs               | `sudo journalctl -u aionui-webui.service -n 100 --no-pager` | `journalctl --user -u aionui.service -n 100 --no-pager` |
| Follow logs               | `sudo journalctl -u aionui-webui.service -f`                | `journalctl --user -u aionui.service -f`                |
| Restart (interrupts work) | `sudo systemctl restart aionui-webui.service`               | `systemctl --user restart aionui.service`               |

Never put `sudo` before `systemctl --user` to manage another user's service.
`Unit ... could not be found` may mean the wrong manager/name, not a missing
installation.

## Upgrade an existing service

Wait for running requests to finish: stopping the service interrupts active work.
For an existing systemd service named `aionui-webui.service`, run as the same
installation owner (adjust the checkout, service name and install paths if needed):

```bash
(
  set -e
  cd ~/repo/AionUI-build
  git switch build
  git pull --ff-only origin build
  sudo -v
  sudo systemctl stop aionui-webui.service
  bash prebuilt/linux-x86_64/install.sh
  sudo systemctl start aionui-webui.service
  sudo systemctl status aionui-webui.service --no-pager -l
)
```

If installation fails, the block stops before starting the service. Inspect the
error and retain the backup; do not remove data directories. Installation backups
are **not database backups**. Use your normal data backup procedure before upgrades.
For a legacy user service, use its actual `systemctl --user` stop/start/status
commands instead. Keep `INSTALL_DIR` and `BIN_DIR` overrides consistent with its
current installation. An upgrade does not migrate service managers or resource
limits; migration is a separate maintenance operation.

Check `sudo systemctl cat aionui-webui.service` locally: `ExecStart` must reference
the intended installation. `--backend-bin` or `AIONUI_BACKEND_BIN` can override the
bundled backend, and `--static-dir` can select an old renderer. Updating the package
does not change those overrides. Startup logs print the resolved `backend bin`
and `static dir`; inspect them without sharing credentials from unit files/logs.
Restart after replacement, then reload the browser.

## nginx / HTTPS

### Requirements

Use a dedicated hostname, for example `aionui.example.com`, with the application
at the hostname's **root `/`**. Run nginx on the same host as WebUI for the example
below. WebUI listens on `127.0.0.1:25808` by default; `--remote` is not needed for
a same-host reverse proxy. Do not expose that port publicly to bypass HTTPS or
access controls. A containerized nginx needs a reachable, private upstream address
instead of its own container's `127.0.0.1`.

Proxy to the **WebUI port**, not the backend's internal dynamically chosen port.
Preserve the URI, query string, cookies, authorization headers and WebSocket
upgrade. HTTPS is also needed for reliable browser clipboard access outside
localhost.

| Browser path                               | Destination / purpose                 |
| ------------------------------------------ | ------------------------------------- |
| `/` and frontend files such as `/assets/*` | WebUI HTML, JS, CSS and static assets |
| `/api/*`, including `/api/assets/logos/*`  | WebUI forwards to the bundled backend |
| `/login`, `/logout`                        | Backend authentication, via WebUI     |
| `/ws`, `/api/stt/stream`                   | WebSocket/stream upgrades, via WebUI  |

Do not handle `/api/assets/logos/*.svg` with `root`, `alias`, `try_files`, or a
generic `location ~* \.(svg|png|...)` static-file rule. Do not replace upstream
API errors with `index.html`; an HTML response with status 200 is not an SVG.

### Dedicated-host example

This configuration belongs inside nginx's `http {}` context (for example an
included `/etc/nginx/conf.d/aionui.conf`). Replace the hostname and certificate
paths with your actual values; provision a valid certificate separately before
running `nginx -t`. If you already have an equivalent WebSocket `map`, reuse it
instead of defining it twice. Do not replace unrelated virtual hosts.

```nginx
map $http_upgrade $aionui_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name aionui.example.com;
    return 301 https://aionui.example.com$request_uri;
}

server {
    listen 443 ssl;
    server_name aionui.example.com;
    ssl_certificate     /etc/letsencrypt/live/aionui.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aionui.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 100m;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $aionui_connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_cache off;
    proxy_intercept_errors off;

    # ^~ prevents a generic extension regex from capturing API logo requests.
    location ^~ /api/ {
        proxy_pass http://127.0.0.1:25808;
    }

    # Includes frontend assets, /login, /logout and /ws.
    location ^~ / {
        proxy_pass http://127.0.0.1:25808;
    }
}
```

There is **no trailing URI `/`** after the upstream address in `proxy_pass`;
in particular, do not strip `/api/`. If adding locations later, check nginx's
location precedence and header inheritance rather than assuming this catch-all
still handles them. Adjust upload limits/timeouts to your needs; long timeouts do
not provide heartbeat detection for half-open WebSockets.

Apply only after checking syntax:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### `/aionui` entry pages and authentication

This build is not a complete path-prefixed application. A landing page or iframe
at `/aionui` does **not** move the application's requests under `/aionui/`.
The iframe document's origin and URL determine where its root-relative
`/api/`, `/assets/`, `/ws`, `/login` and `/logout` requests go.
Proxying only `location /aionui/` is therefore insufficient. Prefer a dedicated
hostname with the configuration above. A simple `/aionui` entry link can redirect
to `/`; that is an entry alias, not subpath isolation. If retaining an existing
same-origin iframe wrapper, the application root routes must still reach WebUI;
resolve any conflicts with other apps instead of adding blind path rewrites.

The example uses AionUi's own login and does not add nginx Basic authentication.
If your environment already uses Basic auth or another gateway, verify access to
**all** application paths and WebSocket handshakes after both gateway and AionUi
login. Basic and Bearer authentication can compete for the `Authorization`
header; do not blindly overwrite or clear it. Do not disable authentication on
all of `/api/` as an icon workaround.

An unauthenticated curl receiving `401` with `WWW-Authenticate: Basic` only proves
the gateway requires authentication. It does **not** prove the package lacks icons
or that an authenticated browser's failure has the same cause.

## Diagnosing missing icons

First compare the installed package metadata and backend hash:

```bash
INSTALL_DIR="${HOME}/.local/share/aionui-web"
cat "$INSTALL_DIR/build-info.json"
sha256sum "$INSTALL_DIR/bundled-aioncore/linux-x64/aioncore"
```

The hash must match `backendSha256` in that installation's `build-info.json`.
For the 2026-10-06 package documented here (unchanged backend), `backendSourceCommit` is
`65bb22a8447e5350645b29e6b1883710732acf13`; its backend SHA-256 is
`e2b5af59b96d96b03e7f1111004d89d0c66ad11314937d439bd4c143d7263656`.
The visible version `2.2.2` alone cannot distinguish our rebuilds.
Also check the running service's executable/overrides as described above:
metadata on disk does not prove the process has restarted.

On the target machine, compare the same path directly and via nginx:

```bash
curl -sS -i --max-time 15 \
  http://127.0.0.1:25808/api/assets/logos/tools/github.svg
curl -sS -i --max-time 15 \
  https://aionui.example.com/api/assets/logos/tools/github.svg
```

For a Basic-auth gateway, repeat the second command with `--user YOUR_USERNAME`;
curl prompts for the password rather than putting it in shell history. Do not
share passwords, cookies or authorization headers. In the browser's Network tab,
inspect the **actual failed request** while logged in, including its URL, status,
content type and response.

| Result                               | Next check                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Direct 200 SVG, public 404 or HTML   | nginx location matching, URI rewriting, wrong virtual host/upstream                       |
| Direct 200 SVG, public 401/403       | Gateway/application authentication; distinguish authenticated browser from anonymous curl |
| Direct 404 for the known GitHub logo | Running backend version/path; upgrade the whole package and restart if stale              |
| 502/connection failure               | WebUI/backend process, upstream port and service logs                                     |
| 200 `text/html`                      | Wrong route or SPA fallback; not a valid icon response                                    |
| Both return 200 SVG                  | Browser request URL, authentication, cache, CSP/mixed-content errors                      |

Expected response: `200`, `Content-Type: image/svg+xml`, and an SVG body.
Known logos also include `/api/assets/logos/brand/aion.svg` and
`/api/assets/logos/ai-major/claude.svg`. A conditional cache request can validly
return `304`; a nonexistent logo should return backend `404 NOT_FOUND`.

The current split archive was reconstructed and installed into an isolated
directory, then its backend was copied to a temporary location with fresh data:
all three known logos returned SVG, ETag/cache headers and valid 304 responses.
No AionCore source-tree logo directory is required at runtime. This verifies the
package, not a different machine's deployed process or nginx configuration.

## Enable context selection

The archive includes a standalone `copilot-acp` binary, alongside `aionui-web`.
In **Settings → Agents**, add a separate custom agent:

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Name        | Copilot (context selection)                                                       |
| Command     | `/home/YOUR_USER/.local/share/aionui-web/copilot-acp`                             |
| Arguments   | `--acp`                                                                           |
| Environment | `AIONUI_COPILOT_CLI=/absolute/path/to/native/copilot`, if not on the service PATH |

Use the actual `INSTALL_DIR` if overridden. Save the agent, then click
**Test Connection on its saved agent card** to load its model capabilities.
The connection test inside the unsaved editor only checks the executable.
Select this agent in a **new
conversation**, then select a model. Only models with multiple advertised tiers
show Default / Long context. On the welcome page, the model menu now has
independent **Model**, **Thinking Level** and **Context window** submenus; the
phone-browser action sheet offers the same choices. A selected tier is confirmed
before sending the first prompt.

Each tier displays its native **input token budget**, for example
`Default (272K)` / `Long context (872K)` for
the currently advertised GPT-6 Astra metadata. Values vary by model and CLI
metadata; these are not character counts or total input-plus-output limits.
K means 1,000 and M means 1,000,000 (for example `1.05M`). The compact
label rounds to at most two decimal places; option descriptions show the exact count.

**Upgrading an existing custom agent:** after installing this package and
restarting the target service, test that saved agent again in **Settings → Agents**
to refresh its cached per-model capabilities, then refresh the browser. Both
the adapter binary and the frontend must come from this build.

The adapter uses the native CLI SDK; it does not
replace or automatically reconfigure the built-in Copilot agent. See the packaged
`copilot-acp-README.md` for protocol and permission limitations; its source-checkout
Node instructions are unnecessary for this compiled binary.

The built-in Copilot entry gets automatic draft queuing from PR #2. The separate
custom adapter does not inherit that backend-specific default; its existing
Draft box can be switched to automatic mode explicitly.

## Session lifecycle and recovery

### Duplicate completion replies after returning to a tab

History reconciliation now matches ACP tools (including `task_complete`) by
their stable tool-call ID, not the live turn's envelope message ID. Returning
to the tab, reconnecting or loading history no longer appends a second copy of
the same completion. Different tool calls remain separate even if their text
is identical. Existing stored messages are not deleted or rewritten.

### Slow networks and interrupted asset downloads

This package adds Service Worker v3: complete content-hashed JS/CSS is reused by
exact URL without another download, interrupted cold downloads retry once, and
optional precache failures do not block installation. Each asset download has a
60-second deadline including body reads. Missing assets return 404 rather than
SPA HTML. HTML and the worker require revalidation.

Before the main JavaScript loads, the page displays a localized loading message
and exposes a manual reload link on load failure or after 15 seconds. Worker
activation does not forcibly reload existing tabs; manually reload after upgrade.
If an old worker prevents startup, bypass/unregister only this application's
worker in browser DevTools and reload; do not clear all site data or drafts.

`ERR_CONTENT_LENGTH_MISMATCH 200` means a response body was incomplete even though
headers succeeded. Compare full local/public GET bodies, and inspect nginx errors
for upstream disconnects, disk space, timeouts, compression/Content-Length errors
and `proxy_temp_path` permissions. Keep `proxy_buffering off` from the example,
or ensure the nginx worker can write its temporary directory. Do not disable
authentication or use `chmod 777`. Browser-extension `contentscript.js` warnings
are not evidence that the AionUi backend leaked listeners.

### Initial Copilot permissions

On the new-conversation page, **Allow all** is a separate control beside the mode
selector; mobile users can select it in the **+** action sheet. It defaults to
**Off** for each new creation page and resets when switching assistants. Enabling
it automatically approves tool, path and URL requests in the new session; use it
only for trusted work. It does not change agent/plan/autopilot mode.

Both built-in Copilot and the custom adapter are supported when their cached
capabilities advertise `allow_all`. If the control is missing, test the saved
agent's connection in Settings to refresh its capabilities. Creation starts the
runtime and confirms the selected setting before sending the first message,
including for empty conversations. A failed or unconfirmed setting blocks the
first message and displays an error. Existing sessions and global CLI settings
are not changed.

The creation page now shows which setup step is running. Runtime startup has a
90-second client deadline; each config update has a 45-second deadline, including
auth refresh and response-body reads. Assistant-cache refresh no longer blocks
entry to the conversation. On failure, input and attachments are kept. Pressing
Send again with unchanged creation parameters retries the same conversation.
**Open created conversation** opens the already-created session with an unsent
draft, so you can inspect agent errors instead of being trapped on the start page.
Check permissions before sending manually: a client timeout does not necessarily
cancel the server-side operation. No first prompt is automatically sent after an
unconfirmed setting, timeout, or late completion after leaving the creation page.
If setup still fails, record the displayed step/error and the matching backend
logs (`runtime/ensure` versus `config-options/allow_all`); this distinguishes agent
startup/authentication issues from permission confirmation or proxy/network stalls.

Normal idle collection closes the ACP transport before terminating the process,
allowing the custom adapter to stop its native child and release its session
lease. Returning to an idle-collected conversation loads the original session
without requiring a manual reconnect. Active-tab and background-task protections
remain enabled; idle collection is not disabled.

After an abnormal exit, use **Reconnect agent**. Recovery verifies ownership
before reclaiming a stale lease; it does not steal a live session, create an empty
replacement, or resend the previous prompt. Unverifiable legacy leases still
require manual ownership verification. See `copilot-acp-README.md` for details.

The built-in Copilot agent's `/allow-all`, `/allow-all on` and `/allow-all off`
commands now use its advertised `on` / `off` values. The custom adapter continues
to use its advertised `true` / `false` values.

## Realtime message recovery

Accepted single-agent sends reconcile saved messages and restore a disconnected
WebSocket. Open connections are not replaced; stalled connection attempts time
out after 10 seconds and retry with backoff. Reconnect, network recovery and
returning to a visible tab reconcile messages and running state without replaying
prompts or restarting the agent. History gaps spanning multiple pages are filled
and duplicate user-message notifications are ignored.

This build does not add heartbeat-based detection of half-open sockets.

Final text replacements update their original segment instead of appending a
duplicate after tool calls. Each user/assistant text message and Copilot
`task_complete` answer has a copy button: hover or focus on desktop, always visible
on mobile. Whole-reply copying remains a separate action for split replies.

## Mobile scope

This is a Linux web deployment package, usable from desktop and phone browsers.
PR #3's independent Expo/React Native client fix is included in the branch source,
but this archive is **not** an Android APK or iOS application build.
