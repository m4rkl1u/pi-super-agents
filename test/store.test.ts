import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('one shared lock excludes other processes and demo stores without losing workspace history', t => {
  const home = mkdtempSync(join(tmpdir(), 'super-agents-shared-'));
  const dir = join(home, '.pi-workspaces'), project = join(home, 'project');
  mkdirSync(project);
  let store = new Store(dir, dir);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = store.createAgent({ name: 'alice', role: 'test', provider: 'demo', model: 'local', cwd: project });
  assert.equal(JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')).pid, process.pid);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}; new Store(${JSON.stringify(dir)});`],
    { cwd: project, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Workspace locked/);
  assert.throws(() => new Store(join(dir, 'demo'), dir), /Workspace locked/);
  store.close(); store.close();
  assert.equal(existsSync(join(dir, 'owner.lock')), false);
  const demo = new Store(join(dir, 'demo'), dir);
  assert.equal(demo.agents().length, 0, 'demo data is separate but shares exclusive ownership');
  assert.throws(() => new Store(dir, dir), /Workspace locked/);
  demo.close();
  store = new Store(dir, dir);
  assert.equal(store.agent(agent.id).cwd, agent.cwd);
  assert.equal(store.agent(agent.id).name, 'alice');
});

test('the 128-Agent limit includes assistants and paused Agents, survives restart, and excludes archives', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-limit-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const channel = store.channels()[0];
  const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'local' });
  const input = { name: 'worker', role: 'test', provider: 'demo', model: 'local', cwd: dir };
  for (let i = 1; i < 128; i++) store.createAgent({ ...input, name: `worker-${i}` });
  const worker = store.agent('worker-1');
  store.pause(worker.id, true);
  const settings = store.db.prepare('SELECT COUNT(*) AS n FROM settings').get()?.n;
  assert.equal(store.agents().length, 128);
  assert.throws(() => store.createAgent(input), /128 unarchived Agents/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM settings').get()?.n, settings);
  assert.equal(store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'local' }).id, assistant.id);
  const second = store.createChannel('second');
  assert.throws(() => store.ensureChannelAssistant(second.id, dir, { provider: 'demo', id: 'local' }), /128 unarchived Agents/);
  assert.equal(store.channelAssistant(second.id), undefined);
  store.close(); store = new Store(dir);
  assert.throws(() => store.createAgent(input), /128 unarchived Agents/);
  store.archiveAgent(worker.id);
  store.createAgent(input);
  assert.equal(store.agents().length, 128);
  assert.equal(store.agents(true).length, 129, 'archived history remains intact');
});

test('startup failures release the lock; abandoned locks are never silently stolen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agents-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'workspace.sqlite'));
  assert.throws(() => new Store(dir));
  assert.equal(existsSync(join(dir, 'owner.lock')), false);
  rmSync(join(dir, 'workspace.sqlite'), { recursive: true });
  writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ pid: 2147483647 }));
  assert.throws(() => new Store(dir), /Confirm the recorded PID has stopped/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')).pid, 2147483647);
});

test('thinking preferences validate, inherit independently of models, and survive restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-thinking-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const alice = store.createAgent({ name: 'alice', role: 'test', provider: 'demo', model: 'local', cwd: dir });
  const channel = store.channels()[0], other = store.createChannel('other');
  const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'local' });
  assert.equal(store.thinkingFor(alice, null), 'medium');
  assert.equal(store.thinkingFor(alice, channel.id, 'high'), 'high');
  store.setThinkingLevel('channel', channel.id, 'low');
  assert.equal(store.thinkingFor(alice, channel.id), 'low');
  assert.equal(store.thinkingFor(alice, null), 'medium');
  assert.equal(store.thinkingFor(alice, other.id), 'medium');
  assert.equal(store.thinkingFor(assistant, null), 'low');
  assert.equal(store.thinkingFor(assistant, other.id), 'low', 'assistant always uses its home channel');
  store.setThinkingLevel('agent', alice.id, 'off');
  assert.equal(store.thinkingFor(alice, channel.id), 'off', 'off is an explicit override, not inheritance');
  store.setThinkingLevel('agent', assistant.id, 'max');
  assert.equal(store.thinkingLevel('channel', channel.id), 'max');
  assert.throws(() => store.setThinkingLevel('channel', 'missing', 'low'), /Unknown channel/);
  // @ts-expect-error also validate callers outside TypeScript
  assert.throws(() => store.setThinkingLevel('agent', alice.id, 'bogus'), /Invalid thinking level/);
  assert.equal(store.thinkingFor(alice, null), 'off');
  store.close(); store = new Store(dir);
  assert.equal(store.thinkingFor(alice, channel.id), 'off');
  assert.equal(store.thinkingFor(assistant, null), 'max');
  store.setThinkingLevel('agent', alice.id);
  assert.equal(store.thinkingFor(alice, channel.id), 'max');
  store.setThinkingLevel('channel', channel.id);
  assert.equal(store.thinkingFor(alice, channel.id, 'minimal'), 'minimal');
  store.setSetting(`thinking:agent:${alice.id}`, 'corrupt');
  assert.throws(() => store.thinkingFor(alice, null), /Invalid saved thinking level/);
});

test('indexed activity queries preserve counts, scope and delivery order beyond the transcript window', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-store-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const alice = store.createAgent({ name: 'alice', role: 'test', provider: 'demo', model: 'local', cwd: dir });
  const bob = store.createAgent({ name: 'bob', role: 'test', provider: 'demo', model: 'local', cwd: dir });
  const channel = store.channels()[0], empty = store.createChannel('empty');
  const states = ['queued', 'done', 'failed', 'interrupted', 'cancelled'];
  store.atomic(() => {
    for (let i = 0; i < 340; i++) {
      const id = `message-${i}`;
      store.post({ id, channelId: channel.id, sender: 'human', target: null, text: id, chainId: id }, [alice.id, bob.id]);
    }
    for (const [i, delivery] of store.deliveries().entries()) store.finish(delivery.id, states[i % states.length]);
    store.post({ id: 'direct', channelId: null, sender: 'human', target: alice.id, text: 'private', chainId: 'direct' }, [alice.id]);
  });
  assert.equal(store.messages(channel.id).length, 300);
  assert.equal(store.unreadCount(channel.id, 0), 340);
  assert.equal(store.unreadCount(channel.id, store.messages(channel.id)[0].seq), 299);
  assert.equal(store.unreadCount(empty.id, 0), 0);
  assert.equal(store.lastMessageSeq(empty.id), 0);
  assert.equal(store.lastMessageSeq(channel.id), store.message('message-339').seq);
  const all = store.deliveries();
  for (const agent of [undefined, alice.id, bob.id]) for (const filter of [[], ['queued'], ['done', 'failed', 'interrupted']]) {
    const expected = all.filter(d => (!agent || d.agentId === agent) && filter.includes(d.state));
    assert.deepEqual(store.deliveries(agent, filter), expected);
    assert.equal(store.deliveryCount(filter, agent), expected.length);
  }
  const ids = store.messages(channel.id).map(m => m.id);
  assert.deepEqual(store.messageDeliveries(ids), all.filter(d => ids.includes(d.messageId)));
  assert.deepEqual(store.messageDeliveries([]), []);
  assert.deepEqual(store.messageDeliveries(["x') OR 1=1 --"]), []);
  assert.equal(store.deliveryCount(["queued') OR 1=1 --"]), 0);
  assert.ok(!store.messageDeliveries(ids).some(d => d.messageId === 'direct'));

  // Existing databases acquire the indexes on reopen without rewriting history.
  store.db.exec('DROP INDEX message_channel_seq; DROP INDEX delivery_agent_state');
  store.close(); store = new Store(dir);
  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name);
  assert.ok(indexes.includes('message_channel_seq'));
  assert.ok(indexes.includes('delivery_agent_state'));
  assert.equal(store.unreadCount(channel.id, 0), 340);
  assert.deepEqual(store.deliveries(), all);
});
