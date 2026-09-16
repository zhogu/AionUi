import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Restrict resume to adapter-created sessions, with a cross-process exclusive lease. */
export class SessionOwnership {
  constructor(directory) {
    this.directory = directory;
    this.leases = new Map();
  }

  path(id, suffix) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error('Invalid session ID');
    return join(this.directory, `${id}.${suffix}`);
  }

  async acquire(id, cwd, existing = false) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (existing) {
      const saved = JSON.parse(await readFile(this.path(id, 'json'), 'utf8'));
      if (saved.owner !== 'aionui-copilot-acp' || saved.cwd !== resolve(cwd)) {
        throw new Error('Only adapter-owned sessions in their original working directory may be loaded');
      }
    }
    const lock = this.path(id, 'lock');
    // Do not guess whether a previous owner is still active; crash recovery is explicit.
    const handle = await open(lock, 'wx', 0o600).catch((error) => {
      if (error.code === 'EEXIST')
        throw new Error('Session is already leased; see adapter crash-recovery documentation');
      throw error;
    });
    this.leases.set(id, handle);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      await this.release(id);
      throw error;
    }
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
    const handle = this.leases.get(id);
    if (!handle) return;
    this.leases.delete(id);
    await handle.close();
    await unlink(this.path(id, 'lock'));
  }
}
