# AionUi Web prebuilt package

This branch contains a ready-to-deploy **Linux x86_64** build of AionUi Web
2.2.2, rebuilt on 2026-09-16 with the context-window selection, Copilot draft
queue and mobile-client task-completion changes from PRs #1, #2 and #3.
The packaged `build-info.json` records the exact source commit and build time.
No Node.js, Bun, dependency installation, or local build is required.
Native Copilot CLI must still be installed and authenticated separately.

## Install

```bash
git clone --branch build --single-branch https://github.com/zhogu/AionUi.git AionUi-build
cd AionUi-build/prebuilt/linux-x86_64
bash install.sh
```

If this checkout already exists, run `git pull --ff-only` on `build` first.
Stop an existing service on the **target machine** before replacing its installation.
The installer backs up the old installation but does not stop/start services or
modify conversation data. This build was prepared without updating the source
machine's running deployment.

Start the service:

```bash
~/.local/bin/aionui-web start --port 25808 --no-open
```

The installer reconstructs the archive from the GitHub-safe split files,
verifies its SHA-256 checksum, installs it under
`~/.local/share/aionui-web`, and creates `~/.local/bin/aionui-web`.

Use `INSTALL_DIR` and `BIN_DIR` to override those paths:

```bash
INSTALL_DIR=/opt/aionui-web BIN_DIR=/usr/local/bin bash install.sh
```

## Enable context selection

The archive includes a standalone `copilot-acp` binary, alongside `aionui-web`.
In **Settings → Agents**, add a separate custom agent:

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Name        | Copilot (context selection)                                                       |
| Command     | `/home/YOUR_USER/.local/share/aionui-web/copilot-acp`                             |
| Arguments   | `--acp`                                                                           |
| Environment | `AIONUI_COPILOT_CLI=/absolute/path/to/native/copilot`, if not on the service PATH |

Use the actual `INSTALL_DIR` if overridden. Select this agent in a **new
conversation**, then select a model. Only models with multiple advertised tiers
show Default / Long context. On the welcome page, the model menu now has
independent **Model**, **Thought level** and **Context window** submenus; the
phone-browser action sheet offers the same choices. A selected tier is confirmed
before sending the first prompt.

**Upgrading an existing custom agent:** after installing this package and
restarting the target service, test that agent again in **Settings → Agents**
to refresh its cached per-model capabilities, then refresh the browser. Both
the adapter binary and the frontend must come from this build.

The adapter uses the native CLI SDK; it does not
replace or automatically reconfigure the built-in Copilot agent. See the packaged
`copilot-acp-README.md` for protocol and permission limitations; its source-checkout
Node instructions are unnecessary for this compiled binary.

The built-in Copilot entry gets automatic draft queuing from PR #2. The separate
custom adapter does not inherit that backend-specific default; its existing
Draft box can be switched to automatic mode explicitly.

## Mobile scope

This is a Linux web deployment package, usable from desktop and phone browsers.
PR #3's independent Expo/React Native client fix is included in the branch source,
but this archive is **not** an Android APK or iOS application build.
