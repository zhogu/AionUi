#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { CopilotAdapter } from './adapter.mjs';
import { SessionOwnership } from './ownership.mjs';
import { SdkTransport } from './transport.mjs';

// AionCore may append native ACP flags. Do not forward them to the SDK server.
if (process.argv.includes('--help')) {
  process.stdout.write(
    'Opt-in Copilot SDK ACP adapter. Configure this absolute executable path as command_override.\nEnvironment: AIONUI_COPILOT_CLI, AIONUI_COPILOT_MODEL, AIONUI_COPILOT_ACP_STATE_DIR.\n'
  );
} else {
  const sdk = new SdkTransport({ executable: process.env.AIONUI_COPILOT_CLI || 'copilot' });
  const ownership = new SessionOwnership(
    process.env.AIONUI_COPILOT_ACP_STATE_DIR ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'aionui', 'copilot-acp')
  );
  let adapter;
  const connection = new AgentSideConnection(
    (client) => {
      adapter = new CopilotAdapter(client, sdk, ownership, { model: process.env.AIONUI_COPILOT_MODEL });
      return adapter;
    },
    ndJsonStream(
      Writable.toWeb(process.stdout),
      /** @type {ReadableStream<Uint8Array>} */ (/** @type {unknown} */ (Readable.toWeb(process.stdin)))
    )
  );
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      await adapter.close();
    } finally {
      process.exit(code);
    }
  };
  sdk.on('failure', () => {
    void stop(1);
  });
  connection.closed.then(() => stop()).catch(() => stop(1));
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  process.stdin.once('error', () => {
    void stop(1);
  });
  process.stdout.once('error', () => {
    void stop(1);
  });
}
