import { mkdir, open, readFile, unlink, realpath, rename, readlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve } from 'node:path';

const busy = () =>
  new Error('COPILOT_SESSION_IN_USE: Session is already leased; use Reconnect to recover an interrupted session');
const unverified = (reason) => new Error(`COPILOT_RECOVERY_UNVERIFIED: ${reason}; the existing lease was preserved`);

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw unverified('Invalid process identity');
  if (process.platform !== 'linux') return { pid, start: null };
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // /proc stat field 22 is starttime; field 3 follows the parenthesized name.
    return { pid, start: fields[19], state: fields[0] };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function isAlive(identity) {
  if (!identity || typeof identity.start !== 'string' || !/^\d+$/.test(identity.start)) {
    throw unverified('The lease has no verifiable process start time');
  }
  const current = await processIdentity(identity.pid);
  return current && current.start === identity.start && !['Z', 'X'].includes(current.state);
}

// An abstract Unix socket is a kernel-owned mutex: process death releases it,
// unlike another exclusive-create file. Every lease mutation uses this guard.
async function guard(directory, id, action) {
  if (process.platform !== 'linux') return action();
  const name =
    '\0aionui-copilot-lease-' +
    createHash('sha256')
      .update(`${await realpath(directory)}/${id}`)
      .digest('hex');
  const deadline = Date.now() + 5000;
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(name, resolveListen);
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw new Error('COPILOT_RECOVERY_BUSY: Another lease operation is in progress');
      await sleep(25);
      continue;
    }
    try {
      return await action();
    } finally {
      await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    }
  }
}

/** Restrict resume to adapter-created sessions, with a cross-process exclusive lease. */
export class SessionOwnership {
  constructor(directory, { nativePid, recoverSession } = {}) {
    this.directory = directory;
    this.leases = new Map();
    this.nativePid = nativePid;
    this.recoverSession = recoverSession;
  }

  path(id, suffix) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error('Invalid session ID');
    return join(this.directory, `${id}.${suffix}`);
  }

  async acquire(id, cwd, existing = false) {
    this.path(id, 'lock');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (existing) {
      const saved = JSON.parse(await readFile(this.path(id, 'json'), 'utf8'));
      if (saved.owner !== 'aionui-copilot-acp' || saved.cwd !== resolve(cwd)) {
        throw new Error('Only adapter-owned sessions in their original working directory may be loaded');
      }
    }
    const recover = existing && this.recoverSession === id;
    this.recoverSession = undefined;
    await guard(this.directory, id, async () => {
      const lock = this.path(id, 'lock');
      let handle;
      try {
        handle = await open(lock, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!recover) throw busy();
        await this.recover(id);
        handle = await open(lock, 'wx', 0o600);
      }
      const leaseId = randomUUID();
      try {
        const owner = await processIdentity(process.pid);
        const native = this.nativePid ? await processIdentity(this.nativePid) : null;
        if (!owner || (this.nativePid && !native))
          throw new Error('Native or adapter process exited during lease acquisition');
        await handle.writeFile(
          JSON.stringify({
            version: 2,
            leaseId,
            pid: process.pid,
            owner,
            native,
            bootId:
              process.platform === 'linux' ? (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() : null,
            pidNamespace: process.platform === 'linux' ? await readlink('/proc/self/ns/pid') : null,
          })
        );
        await handle.sync();
        this.leases.set(id, { handle, leaseId });
      } catch (error) {
        await handle.close();
        await unlink(lock);
        throw error;
      }
    });
  }

  async recover(id) {
    if (process.platform !== 'linux') throw unverified('Automatic lease recovery currently requires Linux');
    let record;
    try {
      record = JSON.parse(await readFile(this.path(id, 'lock'), 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw unverified('Incomplete lease metadata');
      throw error;
    }
    // Legacy PID-only leases cannot prove the SDK child is gone. Never guess.
    if (record?.version !== 2 || !record.leaseId || !record.bootId || !record.native || !record.pidNamespace) {
      throw unverified('Legacy lease requires an explicit ownership check');
    }
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (record.bootId !== bootId) {
      // Different boot IDs can also mean a shared state directory on another host.
      throw unverified('Lease belongs to a different system boot');
    }
    if (record.pidNamespace !== (await readlink('/proc/self/ns/pid'))) {
      throw unverified('Lease belongs to a different process namespace');
    }
    if (await isAlive(record.owner)) throw busy();
    if (await isAlive(record.native)) {
      throw new Error('COPILOT_SESSION_CHILD_ALIVE: Native Copilot is still running; the existing lease was preserved');
    }
    await rename(this.path(id, 'lock'), this.path(id, `recovered-${randomUUID()}.json`));
    console.error(`[copilot-acp] Reclaimed stale lease for session ${id}; original native session will be resumed.`);
  }

  async save(id, cwd) {
    const file = await open(this.path(id, 'json'), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ owner: 'aionui-copilot-acp', cwd: resolve(cwd) }));
    } finally {
      await file.close();
    }
  }

  async release(id) {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    await guard(this.directory, id, async () => {
      try {
        const current = JSON.parse(await readFile(this.path(id, 'lock'), 'utf8'));
        if (current.leaseId !== lease.leaseId) throw unverified('Lease ownership changed before release');
        await unlink(this.path(id, 'lock'));
      } finally {
        await lease.handle.close();
      }
    });
  }
}
