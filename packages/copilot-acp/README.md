# Opt-in Copilot SDK ACP adapter

This executable supplies the actual `context_window` ACP configuration used by
AionUI’s model-dependent context selector. It does **not** replace Copilot’s
native ACP implementation. Native Copilot 1.0.83 does not expose context tier
changes through ACP; this adapter uses its SDK server instead.

## Enable deliberately

Requirements: Node.js 22+, this checkout’s existing dependencies installed, and a
separately installed/authenticated native `copilot` executable on `PATH`. Tested
against Copilot **1.0.83** and `@agentclientprotocol/sdk` **0.18.2**.

In **Settings → Agents**, add a **custom agent** named, for example,
`Copilot (context selection)`. Set its command to the absolute executable:

```text
/absolute/path/to/AionUI/packages/copilot-acp/index.mjs
```

Set its arguments to `--acp`. The executable bit is required on Unix. Alternatively,
set the command to the absolute Node.js executable and the arguments to
`"/absolute/path/to/AionUI/packages/copilot-acp/index.mjs" --acp`; use this form
on Windows. Do not combine `node /path/index.mjs` into the command field.
The `--acp` argument is accepted but not forwarded to the SDK server.

Add `AIONUI_COPILOT_CLI` in the agent's environment fields if native Copilot is
not on the service's `PATH`. Save and test the custom agent, then choose it for a
**new conversation**. Select a model first; the context selector appears only
when that model advertises multiple tiers. No build or additional dependency is
needed. The AionUI frontend must include this PR's selector changes.

On the welcome page, open the model menu: **Model**, **Thinking Level**, and
**Context window** are separate submenus. Phone browsers expose the same
choices in the action sheet. Context and reasoning choices follow the selected
model, not the model used by an earlier session. A requested context tier is
confirmed before the first prompt is sent; a configuration failure leaves the
prompt unsent and reports an error.

After upgrading an existing adapter installation, **test the custom agent again**
in Settings to refresh its cached model capabilities, then refresh the welcome
page. Both the frontend and adapter must be updated: older adapters do not
publish the per-model `_meta["aionui/model-config"]` used by the welcome page.
The saved agent's connection test refreshes custom ACP catalogs using a temporary,
hidden runtime and deletes it afterwards. This compensates for AionCore 0.2.2's
health probe not caching session capabilities. No prompt is sent, no model tokens
are consumed, and existing conversations are not touched.

This is a separate custom ACP agent, not an in-place upgrade of the built-in
Copilot entry. Do **not** edit the built-in entry's `command_override` while
existing work is running. Existing native Copilot agents, conversations and
deployments remain unchanged. Backend-specific features gated on the built-in
`copilot` identity (such as PR #2's automatic draft-queue default) do not
automatically apply to a custom entry.

Optional environment variables on the adapter process:

| Variable                       | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `AIONUI_COPILOT_CLI`           | Native Copilot executable path (default: `copilot` on `PATH`)     |
| `AIONUI_COPILOT_MODEL`         | Initial model ID, validated against live metadata                 |
| `AIONUI_COPILOT_ACP_STATE_DIR` | Adapter ownership/lease directory                                 |
| `XDG_STATE_HOME`               | Default state base; otherwise `~/.local/state/aionui/copilot-acp` |

The adapter never edits `~/.copilot/config`, replaces a binary, or imports a
user’s active native session. Authentication is performed outside the adapter.
Native CLI session journals and ordinary native tool behavior remain native.
Do not point `AIONUI_COPILOT_CLI` back at this adapter.

## Behavior and safety

- The SDK process starts with `--server --stdio --no-auto-update --log-level none`.
  Built-in tools and MCPs are **not** disabled in production.
- Model metadata determines tier eligibility: separate positive default/long
  prompt budgets are required. No model-name allowlist is used. Auto and
  single-tier models explicitly publish one default option, clearing stale
  choices in AionCore’s ID-merging config cache.
- Labels are **Default / Long context**, not misleading total token counts.
  Native metadata distinguishes prompt budget from maximum output tokens;
  long context can also have different pricing.
- Model, context and reasoning changes use `session.model.switchTo`, followed by
  authoritative `session.model.getCurrent`. Changes are idle-only; overlapping
  prompts/configuration requests fail. Successful changes return the complete
  config and send `config_option_update`. Unconfirmed/failed mutations require
  closing/reloading the session rather than risking a prompt with stale state.
- The native selected model is retained when available. An uninitialized session
  uses the explicit environment selection, a metadata default, Auto, or the first
  enabled metadata model in that order. No user settings are read or rewritten.
- New and loaded sessions start in interactive/manual-permission mode.
  Autopilot and allow-all are **separate explicit choices**. The adapter never
  auto-approves an ACP permission request; native permission policy still controls
  operations already considered allowed by the CLI.
- Text, thoughts, native tool results and `task_complete` summaries are forwarded.
  `session/prompt` waits for actual native `session.idle`, not the send ACK.
  Native usage events provide context utilization. Errors fail the prompt;
  cancellation aborts native work and denies outstanding permission requests.
  If native cancellation does not finish, the session is destroyed and cannot be
  reused without loading it again.
- ACP stdio, HTTP and SSE MCP declarations are passed to the native SDK; no coding
  tools are reimplemented. Text/embedded text and local `file:` resource links are
  supported. Local attachments are handled by native Copilot, not read by the
  adapter.
- SDK and ACP processes close on EOF, signal or transport failure. Outstanding
  SDK requests fail on exit; timed-out mutations terminate the SDK transport.

Protocol option names are agent-provided English metadata, as with native ACP.
AionUI localizes the `context_window` selector label; this package adds no
renderer strings.

## Loading and ownership

Only sessions **created by this adapter** can be loaded, in the same working
directory. Loading replays native history and resets mode/permissions to safe
defaults. An exclusive lease prevents two adapter processes from resuming the
same session concurrently. Never open an adapter-owned session simultaneously
through the native CLI: native clients do not participate in adapter leases.

Empty native sessions may not be resumable until their first model turn is
persisted. A failed empty-session load returns an error, never a replacement
session. Native CLI sessions not created here are deliberately not importable.

After a crash, leases fail closed. To recover, verify the recorded PID in the
specific `<session-id>.lock` file is no longer alive and that no native process is
using that session, then remove **only that stale lock**. Do not remove another
process’s lease. Ownership `.json` files are not Copilot configuration.

## Explicit limitations

- No ACP image/audio/blob input, remote resource fetching, terminal delegation,
  session listing/forking, native session import, in-protocol login, or custom
  tool implementations. Unsupported content is rejected, not silently dropped.
- ACP has no general free-text `ask_user` response. Native multiple-choice
  questions are presented as choices; free-text-only questions are surfaced and
  rejected so the user can cancel and answer with a new prompt. MCP elicitation
  forms, OAuth dialogs and other native host callbacks are not advertised.
- `/model ID`, `/autopilot on|off`, `/allow-all on|off` use the same validated
  session configuration path. Native `/context`, `/compact`, `/diff`, `/env` and
  `/help` are offered only when returned by the SDK commands API. Other slash
  commands and host-only dialogs are rejected and **never sent verbatim to the
  model**. The native terminal UI’s complete command/dialog surface is not
  reproduced.
- The SDK RPC surface is experimental. Required model/mode/permission methods
  must be available; this adapter intentionally fails instead of silently
  switching back to native ACP or using a restart workaround.

## Verification

Focused tests (no model calls):

```bash
bun run test -- packages/copilot-acp
```

Opt-in authenticated native test, with a neutral directory **outside the repo**
containing no private instructions:

```bash
COPILOT_ACP_NATIVE_TEST=1 \
COPILOT_ACP_NATIVE_CWD=/absolute/path/to/neutral-directory \
AIONUI_COPILOT_CLI=/absolute/path/to/native/copilot \
bun run test -- packages/copilot-acp/native.test.ts
```

This creates **new isolated sessions only**, makes three minimal `OK` model
turns, verifies `assistant.usage.maxPromptTokens` against live metadata for
default → long → default, verifies a single-tier model’s config and rejection,
exercises harmless native `printf` requests with explicit approval and denial,
checks an explicit native autopilot `task_complete` summary, owned history replay
and the executable ACP/EOF boundary. The probe
disables built-in MCPs only for its in-process SDK smoke. It emits sanitized
token-budget proof, not opaque API tracking fields. Native session journals may
remain in Copilot’s normal session storage; no existing sessions are queried.

Verified on 2026-09-16 with native Copilot 1.0.83:

| Model       | Default prompt budget | Long prompt budget | Back to default |
| ----------- | --------------------- | ------------------ | --------------- |
| GPT-5.6 Sol | 272,000               | 922,000            | 272,000         |

These are effective `assistant.usage.maxPromptTokens` values from real turns,
not echoed options. GPT-5.4 mini published only the default choice and rejected
long context. Native shell permission/result forwarding, autopilot completion
content, owned-session replay, and ACP executable EOF shutdown also passed.
