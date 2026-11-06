# Fork repository status

Status snapshot: **2026-11-06**

This document records the relationship between the AionUi repositories maintained
under the `zhogu` GitHub account, their active branches, and the standalone Linux
WebUI package. It is a point-in-time maintenance reference; verify remote heads
before publishing a new release.

## Repository inventory

| Repository                                            | Upstream                                                      | Default branch | Verified product baseline | Local checkout    |
| ----------------------------------------------------- | ------------------------------------------------------------- | -------------- | ------------------------- | ----------------- |
| [`zhogu/AionUi`](https://github.com/zhogu/AionUi)     | [`iOfficeAI/AionUi`](https://github.com/iOfficeAI/AionUi)     | `main`         | `f38599d2a`               | `~/repo/AionUI`   |
| [`zhogu/AionCore`](https://github.com/zhogu/AionCore) | [`iOfficeAI/AionCore`](https://github.com/iOfficeAI/AionCore) | `aionui`       | `03e354b`                 | `~/repo/AionCore` |

These are the only Aion-related repositories currently present under the `zhogu`
GitHub account and in `~/repo`.

## AionUi

### Active branches

| Branch                                      | Head                                  | State                                                                                                       |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `main`                                      | `f38599d2a` plus this status document | Clean at the snapshot; contains all source feature and fix branches                                         |
| `build`                                     | `17e641066`                           | Clean and identical to `origin/build`; contains `main` plus prebuilt Linux artifacts and deployment scripts |
| `experiment/copilot-session-recovery-build` | `891742647`                           | Historical packaging branch; already an ancestor of `build`                                                 |

`build` is intentionally not merged back into `main`: its additional commits are
generated archives, package metadata, and deployment tooling. Source changes flow
from `main` into `build`, not in the reverse direction.

All local `feat/*` and `fix/*` branches are ancestors of `main`:

- `feat/copilot-context-window`
- `feat/copilot-prompt-queue`
- `feat/copilot-session-recovery`
- `fix/acp-config-command-routing`
- `fix/copilot-allow-all-command`
- `fix/copilot-auto-catalog-refresh`
- `fix/copilot-native-allow-all`
- `fix/copilot-native-session-title`
- `fix/message-duplicates-and-copy`
- `fix/mobile-copilot-task-complete`
- `fix/realtime-message-reconciliation`

The `~/repo/AionUI-mobile` worktree is clean and points at the already-merged
`fix/mobile-copilot-task-complete` branch. The deleted `~/repo/AionUI-queue`
directory still has a prunable worktree record, but its
`feat/copilot-prompt-queue` branch is merged and no code is missing.

### Current standalone Linux package

The `build` branch package under `prebuilt/linux-x86_64` records:

| Field                   | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| AionUi version          | `2.2.2`                                                            |
| Frontend/source commit  | `f38599d2a7500b7833dd47a555f92f7e30908f1b`                         |
| AionCore source commit  | `65bb22a8447e5350645b29e6b1883710732acf13`                         |
| AionCore profile        | `dev, debug=0, stripped`                                           |
| AionCore binary SHA-256 | `e2b5af59b96d96b03e7f1111004d89d0c66ad11314937d439bd4c143d7263656` |
| Package SHA-256         | `26e702425f9a750971d13e28d84333195925ca15852180c762d814d6c2c3987a` |

The package's AionCore commit contains all functional backend changes listed
below. The later fork head `03e354b` only adds a test for the session identity
serialization introduced by `65bb22a`.

## AionCore

Local `main` tracks the fork's default branch, `origin/aionui`. Both point to
`03e354b`, and the worktree is clean. All local AionCore feature/fix branches are
ancestors of this `main`:

- `feat/copilot-session-recovery`
- `fix/acp-idle-shutdown`
- `fix/packaged-embedded-logos`

The fork carries these six commits that are not in the official upstream branch:

| Commit    | Change                                                           |
| --------- | ---------------------------------------------------------------- |
| `fa15857` | Recover persisted ACP sessions only on explicit reconnect        |
| `5dd68e4` | Surface safe and actionable recovery failures                    |
| `0f0164a` | Close ACP protocol transport during idle shutdown                |
| `0af9d16` | Embed logos in distributed dev-profile binaries                  |
| `65bb22a` | Expose persisted backend session identity on conversation detail |
| `03e354b` | Cover optional backend session identity serialization            |

At this snapshot, official `iOfficeAI/AionCore/main` is at `503a871`. It has 27
commits not yet merged into the fork, while the fork has the six commits above
that are not upstream. The maintainer account does not have push permission to
the official repository; upstream publication requires a pull request or
maintainer action.

## Maintenance rules

1. Develop AionUi source changes on a feature/fix branch and merge them into
   `main`.
2. Keep `main` free of generated prebuilt archives.
3. Merge `main` into `build`, regenerate and verify the portable package, then
   commit package artifacts only on `build`.
4. Develop AionCore changes against its local `main` and push them to
   `zhogu/AionCore:aionui`; do not report them as merged upstream unless the
   official repository contains them.
5. Record the exact AionUi source commit, AionCore source commit, profile, and
   checksums in `build-info.json` for every package refresh.

Useful verification commands:

```bash
# AionUi source and package branches
git -C ~/repo/AionUI fetch origin main:refs/remotes/origin/main \
  build:refs/remotes/origin/build
git -C ~/repo/AionUI rev-list --left-right --count origin/main...main
git -C ~/repo/AionUI rev-list --left-right --count origin/build...build

# Every source feature/fix branch should be an ancestor of main
for branch in $(git -C ~/repo/AionUI for-each-ref \
  --format='%(refname:short)' refs/heads/feat refs/heads/fix); do
  git -C ~/repo/AionUI merge-base --is-ancestor "$branch" main ||
    echo "Not merged: $branch"
done

# AionCore fork and upstream divergence
git -C ~/repo/AionCore fetch --all --prune
git -C ~/repo/AionCore rev-list --left-right --count origin/aionui...main
git -C ~/repo/AionCore rev-list --left-right --count upstream/main...main
```
