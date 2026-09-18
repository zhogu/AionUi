import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionOwnership } from './ownership.mjs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

const ownershipUrl = pathToFileURL(resolve('packages/copilot-acp/ownership.mjs')).href;
function owner(directory: string, id: string, nativePid: number, recover = false) {
  const source = `
    import { SessionOwnership } from ${JSON.stringify(ownershipUrl)};
    const owner = new SessionOwnership(${JSON.stringify(directory)}, {
      nativePid: ${nativePid}, recoverSession: ${recover ? JSON.stringify(id) : 'undefined'}
    });
    try {
      await owner.acquire(${JSON.stringify(id)}, ${JSON.stringify(process.cwd())}, ${recover});
      ${recover ? '' : `await owner.save(${JSON.stringify(id)}, ${JSON.stringify(process.cwd())});`}
      console.log('ACQUIRED');
      setInterval(() => {}, 1000);
    } catch(error) { console.log(error.message); }
  `;
  return launch(source);
}

function launch(source: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => stop(child));
  const result = new Promise<string>((resolveResult, reject) => {
    let output = '';
    child.once('error', reject);
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('\n')) resolveResult(output.trim());
    });
    child.once('exit', () => {
      if (!output) reject(new Error('Lease owner exited without a result'));
    });
  });
  return { child, result };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aionui-lease-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanups.push(() => stop(native));
  const previous = owner(directory, id, native.pid!);
  expect(await previous.result).toBe('ACQUIRED');
  const lock = join(directory, `${id}.lock`);
  const original = await readFile(lock, 'utf8');
  const recovery = () => new SessionOwnership(directory, { nativePid: process.pid, recoverSession: id });
  return { directory, id, lock, original, previous, native, recovery };
}

describe.skipIf(process.platform !== 'linux')('explicit native session lease recovery', () => {
  it('releases the kernel mutex when its holder crashes', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    const mutex = launch(`
      import { createServer } from 'node:net';
      import { createHash } from 'node:crypto';
      import { realpath } from 'node:fs/promises';
      const name = '\\0aionui-copilot-lease-' + createHash('sha256')
        .update((await realpath(${JSON.stringify(f.directory)})) + '/' + ${JSON.stringify(f.id)}).digest('hex');
      createServer(socket => socket.destroy()).listen(name, () => console.log('LOCKED'));
    `);
    expect(await mutex.result).toBe('LOCKED');
    const recovery = f.recovery();
    const acquiring = recovery.acquire(f.id, process.cwd(), true);
    await stop(mutex.child);
    await acquiring;
    await recovery.release(f.id);
  });

  it('does not steal a live owner even when recovery was explicitly requested', async () => {
    const f = await fixture();
    await expect(f.recovery().acquire(f.id, process.cwd(), true)).rejects.toThrow('COPILOT_SESSION_IN_USE');
    expect(await readFile(f.lock, 'utf8')).toBe(f.original);
  });

  it('refuses recovery while the old native SDK child survives its owner', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await expect(f.recovery().acquire(f.id, process.cwd(), true)).rejects.toThrow('COPILOT_SESSION_CHILD_ALIVE');
    expect(await readFile(f.lock, 'utf8')).toBe(f.original);
  });

  it('requires explicit intent, then reclaims a crashed owner and native child without deleting ownership', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    await expect(new SessionOwnership(f.directory).acquire(f.id, process.cwd(), true)).rejects.toThrow(
      'already leased'
    );
    const recovery = f.recovery();
    await recovery.acquire(f.id, process.cwd(), true);
    expect(JSON.parse(await readFile(f.lock, 'utf8')).pid).toBe(process.pid);
    expect((await readdir(f.directory)).filter((file) => file.includes('.recovered-'))).toHaveLength(1);
    await recovery.release(f.id);
    expect(JSON.parse(await readFile(join(f.directory, `${f.id}.json`), 'utf8')).owner).toBe('aionui-copilot-acp');
  });

  it('serializes competing recovery processes so exactly one owns the session', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    const competitors = Array.from({ length: 5 }, () => owner(f.directory, f.id, process.pid, true));
    const results = await Promise.all(competitors.map((candidate) => candidate.result));
    expect(results.filter((result) => result === 'ACQUIRED')).toHaveLength(1);
    expect(results.filter((result) => result.includes('COPILOT_SESSION_IN_USE'))).toHaveLength(4);
    expect((await readdir(f.directory)).filter((file) => file.includes('.recovered-'))).toHaveLength(1);
  });

  it('does not accept recovery intent for another session or working directory', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    const wrongSession = new SessionOwnership(f.directory, { nativePid: process.pid, recoverSession: randomUUID() });
    await expect(wrongSession.acquire(f.id, process.cwd(), true)).rejects.toThrow('already leased');
    await expect(f.recovery().acquire(f.id, tmpdir(), true)).rejects.toThrow('original working directory');
    expect(await readFile(f.lock, 'utf8')).toBe(f.original);
  });

  it.each([
    ['legacy', (record: Record<string, unknown>) => ({ pid: record.pid })],
    ['different boot', (record: Record<string, unknown>) => ({ ...record, bootId: 'other-boot' })],
    ['different namespace', (record: Record<string, unknown>) => ({ ...record, pidNamespace: 'other-namespace' })],
    ['invalid identity', (record: Record<string, unknown>) => ({ ...record, native: { pid: process.pid } })],
  ])('preserves unverifiable %s metadata', async (_name, mutate) => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    const changed = JSON.stringify(mutate(JSON.parse(f.original)));
    await writeFile(f.lock, changed);
    await expect(f.recovery().acquire(f.id, process.cwd(), true)).rejects.toThrow('COPILOT_RECOVERY_UNVERIFIED');
    expect(await readFile(f.lock, 'utf8')).toBe(changed);
  });

  it('preserves truncated metadata and allows no automatic retry loop', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    await writeFile(f.lock, '{');
    const recovery = f.recovery();
    await expect(recovery.acquire(f.id, process.cwd(), true)).rejects.toThrow('COPILOT_RECOVERY_UNVERIFIED');
    await expect(recovery.acquire(f.id, process.cwd(), true)).rejects.toThrow('COPILOT_SESSION_IN_USE');
    expect(await readFile(f.lock, 'utf8')).toBe('{');
  });

  it('does not mistake a reused PID for the previous owner', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    const record = JSON.parse(f.original);
    record.owner = { pid: process.pid, start: '0' };
    record.native = { pid: process.pid, start: '0' };
    await writeFile(f.lock, JSON.stringify(record));
    const recovery = f.recovery();
    await recovery.acquire(f.id, process.cwd(), true);
    await recovery.release(f.id);
  });

  it('refuses to delete a replacement lease when an old release arrives late', async () => {
    const f = await fixture();
    await stop(f.previous.child);
    await stop(f.native);
    const recovery = f.recovery();
    await recovery.acquire(f.id, process.cwd(), true);
    const replacement = { ...JSON.parse(await readFile(f.lock, 'utf8')), leaseId: randomUUID() };
    await writeFile(f.lock, JSON.stringify(replacement));
    await expect(recovery.release(f.id)).rejects.toThrow('Lease ownership changed');
    expect(JSON.parse(await readFile(f.lock, 'utf8')).leaseId).toBe(replacement.leaseId);
  });
});
