# AionUi Web prebuilt package

This branch contains a ready-to-deploy **Linux x86_64** build of AionUi Web
2.2.2, built from source commit `a27e46ecd`. No Node.js, Bun, dependency
installation, or local build is required.

## Install

```bash
git clone --branch build --single-branch https://github.com/zhogu/AionUi.git AionUi-build
cd AionUi-build/prebuilt/linux-x86_64
bash install.sh
```

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
