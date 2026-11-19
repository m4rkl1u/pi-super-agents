import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { overlaps, type Agent } from './store.js';
import { resolveReadPath, resolveToCwd } from './pi-resources.js';

interface Lease { owner: Agent; path: string; write: boolean; call: string }
interface Observation { path: string; hash: string | null; read: boolean }

// Resolve existing symlinks and the nearest existing parent of a new file.
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}
async function fingerprint(path: string, signal?: AbortSignal): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    if (!(await stat(path)).isFile()) throw new Error(`File version checks require a regular file: ${path}`);
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Cooperative, process-local leases; not a filesystem sandbox. */
export class FileGuard {
  private leases = new Set<Lease>();
  private calls = new Map<string, Map<string, Observation>>();

  private acquire(owner: Agent, path: string, write: boolean, call: string, ancestors: Set<string>): Lease {
    const conflict = [...this.leases].find(lease => (lease.owner.id !== owner.id || (lease.call !== call && !ancestors.has(lease.call)))
      && (write || lease.write) && overlaps(path, lease.path));
    if (conflict) throw new Error(`Workspace file conflict: ${path} is in use by @${conflict.owner.name} (${conflict.path}). No change was made. Coordinate with that Agent or the human; do not poll, force an overwrite, or bypass this guard with another tool.`);
    const existing = [...this.leases].find(lease => lease.owner.id === owner.id && lease.path === path && lease.write === write && lease.call === call);
    if (existing) return existing;
    const lease = { owner, path, write, call };
    this.leases.add(lease);
    return lease;
  }
  release(agentId: string): void {
    for (const lease of this.leases) if (lease.owner.id === agentId) this.leases.delete(lease);
    this.calls.delete(agentId);
  }

  extension(agent: Agent, signal: () => AbortSignal | undefined): ExtensionFactory {
    const seen = new Map<string, string | null>();
    const parents = new Map<string, string | undefined>();
    return pi => {
      pi.on('tool_call', async event => {
        const active = signal();
        if (!active || active.aborted) return { block: true, reason: 'No active workspace turn; file access is disabled' };
        parents.set(event.toolCallId, event.parentToolCallId);
        const ancestors = new Set<string>();
        for (let parent = event.parentToolCallId; parent && !ancestors.has(parent); parent = parents.get(parent)) ancestors.add(parent);
        const source = pi.getAllTools().find(tool => tool.name === event.toolName)?.sourceInfo;
        // Names alone are not authority: an extension can override even read or send_message.
        if (source?.source === 'sdk' && ['send_message', 'memory_search', 'memory_read', 'create_agent', 'archive_agent'].includes(event.toolName)) return;
        const native = source?.path === `builtin:${event.toolName}`;
        try {
          if (native && ['grep', 'find', 'ls'].includes(event.toolName)) return;
          if (native && ['read', 'write', 'edit'].includes(event.toolName)) {
            if (!('path' in event.input) || typeof event.input.path !== 'string') throw new Error('File path must be a string');
            const read = event.toolName === 'read';
            const path = await canonical(read ? resolveReadPath(event.input.path, agent.cwd) : resolveToCwd(event.input.path, agent.cwd));
            active.throwIfAborted();
            const lease = this.acquire(agent, path, !read, event.toolCallId, ancestors);
            try {
              const hash = await fingerprint(path, active);
              active.throwIfAborted();
              if (!read && hash !== null && (!seen.has(path) || seen.get(path) !== hash)) {
                throw new Error(`Workspace file conflict: ${path} is unread or changed since your last read. No change was made. Read it again with the native read tool and reconcile the current content with your intended change; coordinate with the human or peer before overwriting their work.`);
              }
              if (!read && hash === null && seen.has(path) && seen.get(path) !== null) throw new Error(`Workspace file conflict: ${path} was deleted since your last read. Confirm the deletion with the human before recreating it.`);
              let calls = this.calls.get(agent.id);
              if (!calls) { calls = new Map(); this.calls.set(agent.id, calls); }
              calls.set(event.toolCallId, { path, hash, read });
            } catch (error) { this.leases.delete(lease); throw error; }
          } else {
            // shortcut: opaque tools cannot declare a trustworthy write set; use a cwd lease until Pi exposes enforced effects.
            const path = await canonical(agent.cwd);
            active.throwIfAborted();
            this.acquire(agent, path, true, event.toolCallId, ancestors);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { block: true, reason };
        }
      });
      pi.on('tool_result', async event => {
        const observed = this.calls.get(agent.id)?.get(event.toolCallId);
        if (!observed) return;
        try {
          if (event.isError) {
            seen.delete(observed.path);
            // A missing read acknowledges deletion; a subsequent write can intentionally recreate it.
            if (observed.read && observed.hash === null) seen.set(observed.path, null);
            return;
          }
          const hash = await fingerprint(observed.path, signal());
          if (observed.read && hash !== observed.hash) {
            seen.delete(observed.path);
            return { isError: true, content: [{ type: 'text', text: `Workspace file conflict: ${observed.path} changed during read. Read again before editing.` }] };
          }
          seen.set(observed.path, hash);
        } catch (error) {
          seen.delete(observed.path);
          return { isError: true, content: [{ type: 'text', text: `Could not verify file version: ${String(error)}. Read again before editing.` }] };
        }
      });
      pi.on('tool_execution_end', event => {
        this.calls.get(agent.id)?.delete(event.toolCallId);
        parents.delete(event.toolCallId);
        // Tool results are verified before this event; never hold a lease while the model is thinking.
        for (const lease of this.leases) if (lease.owner.id === agent.id && lease.call === event.toolCallId) this.leases.delete(lease);
      });
    };
  }
}
