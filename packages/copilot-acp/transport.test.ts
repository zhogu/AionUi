import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkTransport } from './transport.mjs';

const transports: SdkTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

function fixture(timeout = 1000) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn((_signal: string) => true),
  });
  child.kill.mockImplementation((signal: string) => {
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close');
    });
    return true;
  });
  const transport = new SdkTransport({ timeout, spawnProcess: (() => child) as unknown as typeof spawn });
  transports.push(transport);
  const send = (message: unknown) => {
    const body = JSON.stringify(message);
    child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  return { child, transport, send };
}

describe('native SDK framing and process lifecycle', () => {
  it('handles fragmented UTF-8 Content-Length frames and coalesced notifications', async () => {
    const f = fixture();
    const request = f.transport.rpc('ping');
    const notify = vi.fn();
    f.transport.on('notification', notify);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: '你好' } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    for (const byte of frame) f.child.stdout.write(Buffer.from([byte]));
    f.send({ jsonrpc: '2.0', method: 'session.event', params: {} });
    expect(await request).toEqual({ text: '你好' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('rejects all pending requests on child exit', async () => {
    const f = fixture();
    const result = expect(f.transport.rpc('pending')).rejects.toThrow('exited');
    f.child.emit('exit', 1, null);
    await result;
    expect(f.transport.pending.size).toBe(0);
  });

  it('fails closed on malformed framing instead of hanging an outstanding request', async () => {
    const f = fixture();
    const result = expect(f.transport.rpc('pending')).rejects.toThrow('frame length');
    f.child.stdout.write('Content-Length: 999999999\r\n\r\n');
    await result;
    await f.transport.close();
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects pending requests and closes the child when an RPC times out', async () => {
    const f = fixture(10);
    await expect(f.transport.rpc('mutation')).rejects.toThrow('timed out');
    await expect(f.transport.rpc('subsequent')).rejects.toThrow('timed out');
    await f.transport.close();
  });

  it('answers native client requests and propagates RPC errors without inventing results', async () => {
    const f = fixture();
    const output: Buffer[] = [];
    f.child.stdin.on('data', (chunk: Buffer) => output.push(chunk));
    f.transport.requestHandler = async () => ({ result: { kind: 'denied-interactively-by-user' } });
    f.send({ jsonrpc: '2.0', id: 'native-1', method: 'permission.request', params: {} });
    await vi.waitFor(() => expect(Buffer.concat(output).toString()).toContain('denied-interactively-by-user'));
    const failed = expect(f.transport.rpc('bad')).rejects.toMatchObject({ code: -32601 });
    f.send({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unavailable' } });
    await failed;
  });

  it('makes close idempotent and rejects requests still pending at shutdown', async () => {
    const f = fixture();
    const pending = expect(f.transport.rpc('pending')).rejects.toThrow('closed');
    await Promise.all([f.transport.close(), f.transport.close()]);
    await pending;
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  });
});
