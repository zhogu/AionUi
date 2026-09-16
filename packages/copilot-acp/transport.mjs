import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 32 * 1024 * 1024;

/** Content-Length JSON-RPC transport for the native Copilot SDK server. */
export class SdkTransport extends EventEmitter {
  constructor({ executable = 'copilot', args = [], timeout = 60000, spawnProcess = spawn } = {}) {
    super();
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.failure = null;
    /** @type {(method: string, params: unknown) => Promise<unknown>} */
    this.requestHandler = async (_method, _params) => {
      throw new Error('Unsupported native client request');
    };
    this.child = spawnProcess(executable, ['--server', '--stdio', '--no-auto-update', '--log-level', 'none', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    // Native diagnostics must never contaminate ACP stdout.
    this.child.stderr.on('data', (chunk) => this.emit('diagnostic', chunk));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Copilot SDK exited (${signal ?? code})`)));
  }

  write(message) {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME) throw new Error('SDK message exceeds size limit');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  rpc(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        // A timed-out mutation may still apply: stop the transport rather than reuse uncertain state.
        this.fail(new Error(`Copilot SDK request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > 8192) throw new Error('Invalid SDK frame header');
          return;
        }
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(this.buffer.subarray(0, end).toString());
        const length = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FRAME || end > 8192) {
          throw new Error('Invalid SDK frame length');
        }
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
        this.buffer = this.buffer.subarray(end + 4 + length);
        if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid SDK JSON-RPC message');
        if (typeof message.method === 'string') {
          if (message.id === undefined) this.emit('notification', message);
          else {
            Promise.resolve()
              .then(() => this.requestHandler(message.method, message.params))
              .then(
                (result) => this.reply(message.id, { result }),
                (error) => this.reply(message.id, { error: { code: -32603, message: error.message } })
              );
          }
        } else {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(
              Object.assign(new Error(message.error.message ?? 'SDK request failed'), { code: message.error.code })
            );
          } else pending.resolve(message.result);
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }

  reply(id, payload) {
    if (!this.failure) {
      try {
        this.write({ jsonrpc: '2.0', id, ...payload });
      } catch (error) {
        this.fail(error);
      }
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
    void this.close();
  }

  close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      if (!this.failure) this.fail(new Error('Copilot SDK transport closed'));
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.child.stdin.end();
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
      }
    });
    return this.closing;
  }
}
