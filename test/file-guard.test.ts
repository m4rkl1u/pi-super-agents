import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { FileGuard } from '../src/file-guard.js';
import type { Agent } from '../src/store.js';

type Result = { block?: boolean; reason?: string; isError?: boolean; content?: { text?: string }[] } | undefined;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = new FileGuard();
  const client = (name: string, cwd = dir, overrides: string[] = []) => {
    const agent = { id: name, name, cwd } as Agent;
    const controller = new AbortController();
    const handlers = new Map<string, (event: unknown) => unknown>();
    const native = ['read', 'write', 'edit', 'bash', 'grep', 'ls', 'find'];
    const safe = ['send_message', 'create_agent', 'archive_agent', 'memory_read', 'memory_search'];
    const api = {
      on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
      getAllTools: () => [...native, ...safe, 'custom'].map(name => ({ name, sourceInfo: {
        source: overrides.includes(name) ? 'extension' : safe.includes(name) ? 'sdk' : 'builtin',
        path: overrides.includes(name) ? '/plugin.ts' : `builtin:${name}`,
      } })),
    } as unknown as ExtensionAPI;
    void guard.extension(agent, () => controller.signal)(api);
    let count = 0;
    const begin = async (toolName: string, path = 'a.txt', parentToolCallId?: string) => {
      const event = { toolName, toolCallId: `${name}-${++count}`, parentToolCallId, input: { path } };
      const result = await handlers.get('tool_call')!(event) as Result;
      return { event, result };
    };
    const finish = async (call: Awaited<ReturnType<typeof begin>>, isError = false) => {
      await handlers.get('tool_execution_end')!({ ...call.event, isError });
    };
    const end = async (call: Awaited<ReturnType<typeof begin>>, isError = false) => {
      const result = await handlers.get('tool_result')!({ ...call.event, isError, content: [], details: {} }) as Result;
      await finish(call, isError);
      return result;
    };
    const read = async (path = 'a.txt') => {
      const call = await begin('read', path); assert.equal(call.result, undefined);
      assert.equal(await end(call), undefined);
    };
    return { begin, end, finish, read, stop: () => controller.abort(), release: () => guard.release(name) };
  };
  return { dir, client };
}

test('different files mutate concurrently; same file conflicts only during execution, messaging stays available', async t => {
  const { dir, client } = fixture(t), a = client('alice'), b = client('bob');
  const write = await a.begin('write'); assert.equal(write.result, undefined);
  const other = await b.begin('write', 'b.txt'); assert.equal(other.result, undefined);
  assert.match((await b.begin('write')).result?.reason ?? '', /@alice/);
  assert.match((await b.begin('bash')).result?.reason ?? '', /@alice/);
  assert.equal((await b.begin('send_message')).result, undefined);
  assert.equal((await b.begin('create_agent')).result, undefined);
  writeFileSync(join(dir, 'a.txt'), 'alice'); await a.end(write); await b.end(other);
  const shell = await b.begin('bash'); assert.equal(shell.result, undefined); await b.end(shell);
  assert.match((await b.begin('write')).result?.reason ?? '', /unread or changed/);
  await b.read();
  assert.equal((await b.begin('edit')).result, undefined);
});

test('hash checks reject stale full writes and edits between tool calls, then allow reconciliation', async t => {
  const { dir, client } = fixture(t), a = client('alice'), b = client('bob');
  writeFileSync(join(dir, 'a.txt'), 'original'); await a.read(); await b.read();
  const call = await a.begin('edit'); assert.equal(call.result, undefined);
  writeFileSync(join(dir, 'a.txt'), 'peer change'); await a.end(call);
  for (const name of ['write', 'edit']) assert.match((await b.begin(name)).result?.reason ?? '', /changed since your last read/);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'peer change');
  await b.read(); assert.equal((await b.begin('edit')).result, undefined);
});

test('read leases are shared and short; changes during read invalidate the observation', async t => {
  const { dir, client } = fixture(t), a = client('alice'), b = client('bob');
  writeFileSync(join(dir, 'a.txt'), 'original');
  const one = await a.begin('read'), two = await b.begin('read');
  assert.equal(one.result, undefined); assert.equal(two.result, undefined);
  assert.match((await b.begin('write')).result?.reason ?? '', /@alice/);
  writeFileSync(join(dir, 'a.txt'), 'external change');
  assert.equal((await a.end(one))?.isError, true); await b.end(two);
  assert.match((await a.begin('write')).result?.reason ?? '', /unread or changed/);
  await a.read(); assert.equal((await a.begin('edit')).result, undefined);
});

test('opaque tools lease real parent/child trees, but not siblings; file symlinks share ownership', async t => {
  const { dir, client } = fixture(t);
  const project = join(dir, 'project'), child = join(project, 'child'), sibling = join(dir, 'project-other');
  mkdirSync(child, { recursive: true }); mkdirSync(sibling);
  symlinkSync(project, join(dir, 'alias'));
  const parent = client('parent', project), nested = client('child', child), linked = client('linked', join(dir, 'alias')), peer = client('sibling', sibling);
  assert.equal((await nested.begin('custom')).result, undefined);
  assert.match((await parent.begin('bash')).result?.reason ?? '', /@child/);
  assert.match((await linked.begin('bash')).result?.reason ?? '', /@child/);
  assert.equal((await peer.begin('bash')).result, undefined);
  nested.release(); assert.equal((await parent.begin('bash')).result, undefined);
  assert.match((await nested.begin('write')).result?.reason ?? '', /@parent/);
  parent.release();
  writeFileSync(join(project, 'target.txt'), 'target'); symlinkSync(join(project, 'target.txt'), join(sibling, 'alias.txt'));
  peer.release(); await parent.read('target.txt'); await peer.read('alias.txt');
  assert.equal((await parent.begin('edit', 'target.txt')).result, undefined);
  assert.match((await peer.begin('edit', 'alias.txt')).result?.reason ?? '', /@parent/);
});

test('new files below symlinked parents conflict, and native @ paths use the same key', async t => {
  const { dir, client } = fixture(t);
  mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'alias'));
  const a = client('alice'), b = client('bob');
  assert.equal((await a.begin('write', 'real/new/file.txt')).result, undefined);
  assert.match((await b.begin('write', '@alias/new/file.txt')).result?.reason ?? '', /@alice/);
});

test('failed calls, abort settlement and missing-file rereads permit safe recovery', async t => {
  const { dir, client } = fixture(t), a = client('alice'), b = client('bob');
  writeFileSync(join(dir, 'a.txt'), 'original'); await a.read();
  const failed = await a.begin('edit'); await a.end(failed, true);
  await b.read();
  assert.match((await a.begin('edit')).result?.reason ?? '', /unread or changed/);
  const shell = await a.begin('bash'); assert.equal(shell.result, undefined);
  a.stop(); assert.equal((await a.begin('write')).result?.block, true);
  assert.match((await b.begin('read')).result?.reason ?? '', /@alice/);
  // Aborted tools skip tool_result, but still emit tool_execution_end.
  await a.finish(shell, true); await b.read();
  rmSync(join(dir, 'a.txt'));
  assert.match((await b.begin('write')).result?.reason ?? '', /deleted/);
  const missing = await b.begin('read'); await b.end(missing, true);
  assert.equal((await b.begin('write')).result, undefined);
});

test('concurrent nested calls in one Agent cannot overwrite a still-running read or mutation', async t => {
  const { dir, client } = fixture(t), a = client('alice');
  writeFileSync(join(dir, 'a.txt'), 'original');
  const read = await a.begin('read');
  assert.match((await a.begin('edit')).result?.reason ?? '', /@alice/);
  await a.end(read);
  const edit = await a.begin('edit'); assert.equal(edit.result, undefined);
  assert.match((await a.begin('write')).result?.reason ?? '', /@alice/);
  await a.end(edit);
  assert.equal((await a.begin('write')).result, undefined);
});

test('non-regular file checks fail closed without leaving a lease behind', async t => {
  const { dir, client } = fixture(t), a = client('alice'), b = client('bob');
  mkdirSync(join(dir, 'folder'));
  assert.match((await a.begin('read', 'folder')).result?.reason ?? '', /regular file/);
  assert.equal((await b.begin('bash')).result, undefined);
});

test('same-cwd opaque tools release before either model turn settles, including failed calls', async t => {
  const { dir, client } = fixture(t), a = client('interview'), b = client('shixc');
  mkdirSync(join(dir, 'interview')); mkdirSync(join(dir, 'shixc'));
  for (const tool of ['bash', 'custom']) {
    for (const isError of [false, true]) {
      const opaque = await a.begin(tool); assert.equal(opaque.result, undefined);
      const blocked = await b.begin('write', 'shixc/task.md');
      assert.match(blocked.result?.reason ?? '', /@interview/); await b.finish(blocked, true);
      await a.end(opaque, isError);
      const write = await b.begin('write', 'shixc/task.md'); assert.equal(write.result, undefined);
      await b.end(write);
      const shell = await a.begin('bash'); assert.equal(shell.result, undefined); await a.end(shell);
    }
  }
});

test('nested tools inherit ancestor leases without admitting concurrent siblings or other Agents', async t => {
  const { dir, client } = fixture(t), a = client('alice'), b = client('bob');
  writeFileSync(join(dir, 'a.txt'), 'original');
  const parent = await a.begin('custom'); assert.equal(parent.result, undefined);
  const nested = await a.begin('custom', undefined, parent.event.toolCallId); assert.equal(nested.result, undefined);
  const read = await a.begin('read', 'a.txt', nested.event.toolCallId); assert.equal(read.result, undefined);
  const sibling = await a.begin('edit', 'a.txt', nested.event.toolCallId);
  assert.match(sibling.result?.reason ?? '', /@alice/); await a.finish(sibling, true);
  await a.end(read);
  const edit = await a.begin('edit', 'a.txt', nested.event.toolCallId); assert.equal(edit.result, undefined);
  await a.end(edit); await a.end(nested);
  assert.match((await b.begin('read')).result?.reason ?? '', /@alice/, 'child completion must not release the parent');
  assert.match((await a.begin('bash')).result?.reason ?? '', /@alice/, 'unrelated calls cannot borrow a parent lease');
  await a.end(parent); await b.read();
});

test('turn settlement is still a fallback for outstanding tool leases', async t => {
  const { client } = fixture(t), a = client('alice'), b = client('bob');
  assert.equal((await a.begin('custom')).result, undefined);
  assert.match((await b.begin('bash')).result?.reason ?? '', /@alice/);
  a.release(); assert.equal((await b.begin('bash')).result, undefined);
});

test('extension tools that shadow safe names are opaque, not exempted by name', async t => {
  const { client } = fixture(t), a = client('alice'), b = client('bob', undefined, ['read', 'send_message']);
  assert.equal((await a.begin('bash')).result, undefined);
  for (const tool of ['read', 'send_message']) assert.match((await b.begin(tool)).result?.reason ?? '', /@alice/);
});
