import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Agent } from '../src/store.js';
import { Workspace, mentions, type Runner, type Turn } from '../src/workspace.js';

class FakeRunner implements Runner {
  calls: Turn[] = [];
  action: (turn: Turn) => Promise<void> = async () => {};
  async run(turn: Turn): Promise<void> { this.calls.push(turn); await this.action(turn); }
  async steer(): Promise<void> {}
  inspect(_a: Agent) { return { system: '', tools: [], messages: [] }; }
  async close(): Promise<void> {}
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-test-'));
  const store = new Store(join(dir, 'state'));
  const make = (name: string) => store.createAgent({ name, role: 'test', provider: 'demo', model: 'demo', cwd: dir, tools: 'chat' });
  const alice = make('alice'), bob = make('bob'), outsider = make('outsider');
  const channel = store.channels()[0];
  store.setMembers(channel.id, [alice.id, bob.id]);
  const runner = new FakeRunner();
  const workspace = new Workspace(store, runner);
  t.after(async () => { await workspace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, alice, bob, outsider, channel, runner, workspace };
}

test('mentions ignore quoted, fenced, inline, escaped and email text', () => {
  assert.deepEqual(mentions('hello @alice @bob @alice\n> @quoted\n`@inline` x@y.com \\@escaped\n```ts\n@code\n```\n@carol'), ['alice', 'bob', 'carol']);
  assert.deepEqual(mentions('~~~\n@inside\n~~~\n@alice'), ['alice']);
  assert.deepEqual(mentions('```\n@unfinished'), []);
});

test('plain group messages go to its assistant; explicit recipients override the default', async t => {
  const { workspace: w, runner, channel, alice, store, dir } = fixture(t);
  const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'demo' });
  w.humanChannel(channel.id, 'background'); await w.idle();
  assert.equal(runner.calls.shift()?.agent.id, assistant.id);
  const first = w.humanChannel(channel.id, '@alice work'); await w.idle();
  assert.equal(runner.calls.length, 1); assert.equal(runner.calls[0].agent.id, alice.id);
  assert.equal(runner.calls[0].context.length, 2);
  w.humanChannel(channel.id, '@alice work', first.id); await w.idle(); assert.equal(runner.calls.length, 1);
  w.humanChannel(channel.id, '@alice next'); await w.idle(); assert.equal(runner.calls[1].context.length, 1);
  assert.throws(() => w.humanChannel(channel.id, '@unknown work'), /not a member/);
});

test('human direct inputs never appear in the group or another Agent context', async t => {
  const { workspace: w, runner, store, channel, alice } = fixture(t);
  w.humanDirect(alice.id, 'private prompt'); await w.idle();
  assert.equal(runner.calls.length, 1); assert.equal(runner.calls[0].context[0].text, 'private prompt');
  assert.equal(store.messages(channel.id).length, 0);
});

test('peer messages bind sender, retain causality, do not recurse or implicitly reply', async t => {
  const { workspace: w, runner, store, channel, alice, bob, outsider } = fixture(t);
  runner.action = async turn => {
    if (turn.agent.id === alice.id) {
      assert.throws(() => turn.send({ to: [outsider.id], text: 'bad' }), /shared channel/);
      assert.throws(() => turn.send({ channel: channel.id, to: [alice.id], text: 'self' }), /Self-wake/);
      const one = turn.send({ channel: channel.id, to: ['bob'], text: 'check this' }, 'tool-1');
      const two = turn.send({ channel: channel.id, to: ['bob'], text: 'check this' }, 'tool-1');
      assert.equal(one.id, two.id);
    } else turn.send({ channel: channel.id, text: 'done without recipients' });
  };
  const root = w.humanChannel(channel.id, '@alice start'); await w.idle();
  assert.deepEqual(runner.calls.map(c => c.agent.id), [alice.id, bob.id]);
  assert.ok(store.messages(channel.id).every(m => m.chainId === root.id));
  assert.equal(store.messages(channel.id)[1].sender, alice.id);
});

test('per-Agent serialization and global concurrency', async t => {
  const { workspace: w, runner, channel, alice } = fixture(t);
  const releases: (() => void)[] = [];
  runner.action = () => new Promise(resolve => releases.push(resolve));
  w.humanChannel(channel.id, '@alice @bob first'); w.humanDirect(alice.id, 'second');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.calls.length, 2);
  releases.shift()!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.calls.length, 3);
  releases.splice(0).forEach(resolve => resolve()); await w.idle();
});

test('128 slots are shared by human and AI messages with no extra assistant slot', async t => {
  const { workspace: w, runner, store, dir, channel, alice } = fixture(t);
  const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'demo' });
  for (let i = store.agents().length; i < 128; i++) store.createAgent({ ...alice, name: `worker-${i}` });
  // A pre-limit workspace may already have more than 128 Agents; preserve them but bound execution.
  store.db.prepare('INSERT INTO agents(id,name,role,provider,model,cwd,tools) VALUES(?,?,?,?,?,?,?)')
    .run('legacy', 'legacy', 'Existing worker', 'demo', 'demo', dir, 'chat');
  store.setMembers(channel.id, store.agents().map(a => a.id));
  const releases = new Map<string, () => void>();
  runner.action = turn => new Promise(resolve => {
    releases.set(turn.agent.id, resolve);
    turn.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  for (const [i, agent] of store.agents().filter(a => a.id !== assistant.id).entries()) {
    if (i % 2 === 0) w.humanDirect(agent.id, 'human task');
    else store.post({ id: `ai-${i}`, channelId: channel.id, sender: assistant.id, target: null,
      text: 'AI task', chainId: `ai-${i}` }, [agent.id]);
  }
  const waiting = w.humanChannel(channel.id, 'assistant must wait too');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.concurrency, 128);
  assert.equal(store.deliveryCount(['running']), 128);
  assert.equal(runner.calls.filter(turn => turn.message.sender === 'human').length, 64);
  assert.equal(runner.calls.filter(turn => turn.message.sender === assistant.id).length, 64);
  assert.equal(w.status(assistant.id), 'queued');
  assert.equal(store.db.prepare('SELECT used FROM chains WHERE id=?').get(waiting.chainId)?.used, 0);
  releases.get(runner.calls[0].agent.id)!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.status(assistant.id), 'working');
  assert.equal(store.deliveryCount(['running']), 128);
  releases.forEach(release => release()); await w.idle();
  assert.equal(runner.calls.length, 129);
  assert.equal(store.deliveryCount(['done']), 129);
  assert.equal(store.agents().length, 129, 'legacy Agents are not silently removed');
});

test('custom concurrency cannot bypass the shared maximum or stall scheduling', t => {
  const { store, runner } = fixture(t);
  for (const limit of [0, -1, 1.5, 129, Infinity, NaN]) {
    assert.throws(() => new Workspace(store, runner, limit), /Concurrency must be an integer between 1 and 128/);
  }
  assert.equal(new Workspace(store, runner, 1).concurrency, 1);
});

test('stop aborts active work and blocks queued peer/human wakes until resume', async t => {
  const { workspace: w, runner, store, alice } = fixture(t);
  runner.action = turn => new Promise(resolve => turn.signal.addEventListener('abort', () => {
    assert.throws(() => turn.send({ to: ['bob'], text: 'too late' }), /stopped/); resolve();
  }, { once: true }));
  w.humanDirect(alice.id, 'work'); await new Promise(resolve => setImmediate(resolve));
  w.stop(alice.id); w.humanDirect(alice.id, 'queued'); await w.idle();
  assert.equal(runner.calls.length, 1); assert.equal(w.status(alice.id), 'paused');
  assert.equal(store.deliveries(alice.id)[0].state, 'interrupted');
  runner.action = async () => {}; w.resume(alice.id); await w.idle(); assert.equal(runner.calls.length, 2);
});

test('one shared persistent budget bounds automatic mutual chat', async t => {
  const { workspace: w, runner, store, channel, alice, bob } = fixture(t);
  runner.action = async turn => { turn.send({ to: [turn.agent.id === alice.id ? bob.id : alice.id], text: 'continue' }); };
  const root = w.humanChannel(channel.id, '@alice start'); await w.idle();
  assert.equal(runner.calls.length, 12); assert.equal(store.chainExhausted(root.id), true);
  const blocked = store.deliveries().find(d => d.state === 'queued')!;
  runner.action = async () => {}; w.continueBudget(blocked.agentId); await w.idle();
  assert.equal(runner.calls.length, 13);
});

test('membership is rechecked when queued messages are delivered', async t => {
  const { workspace: w, runner, store, channel, alice } = fixture(t);
  w.setPaused(true); w.humanChannel(channel.id, '@alice start'); store.setMembers(channel.id, []);
  w.setPaused(false); await w.idle();
  assert.equal(runner.calls.length, 0); assert.equal(store.deliveries(alice.id)[0].state, 'cancelled');
});

test('failures pause Agent and require explicit retry', async t => {
  const { workspace: w, runner, store, alice } = fixture(t);
  runner.action = async () => { throw new Error('provider failed'); };
  w.humanDirect(alice.id, 'work'); await w.idle();
  const d = store.deliveries(alice.id)[0]; assert.equal(d.state, 'failed'); assert.equal(w.status(alice.id), 'paused');
  runner.action = async () => {}; w.retry(d.id); await w.idle(); assert.equal(store.deliveries(alice.id)[0].state, 'done');
});

test('restart restores exact session mapping and interrupts uncertain turns without replay', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  const a = store.createAgent({ name: 'alice', role: 'test', provider: 'demo', model: 'demo', cwd: dir, tools: 'chat' });
  store.setSession(a.id, join(dir, 'alice.jsonl'));
  store.setChannelModel(store.channels()[0].id, { provider: 'demo', id: 'group-model' });
  store.setAgentModel(a.id);
  store.post({ id: 'root', channelId: null, sender: 'human', target: a.id, text: 'work', chainId: 'root' }, [a.id]);
  const d = store.deliveries()[0]; store.claim(d.id); store.close();
  store = new Store(dir);
  assert.equal(store.agent(a.id).sessionFile, join(dir, 'alice.jsonl'));
  assert.equal(store.inheritsModel(a.id), true);
  assert.equal(store.modelFor(store.agent(a.id), store.channels()[0].id).id, 'group-model');
  assert.equal(store.agent(a.id).paused, 1); assert.equal(store.deliveries()[0].state, 'interrupted');
  assert.equal(store.claim(d.id), false); store.close();
});

test('model precedence is per delivery and invalid saved settings cannot silently fall back', t => {
  const { store, alice, channel } = fixture(t);
  const piDefault = { provider: 'demo', id: 'pi-default' };
  const second = store.createChannel('second');
  store.setChannelModel(channel.id, { provider: 'demo', id: 'group-one' });
  store.setChannelModel(second.id, { provider: 'demo', id: 'group-two' });
  assert.equal(store.modelFor(alice, channel.id, piDefault).id, 'demo', 'legacy Agent remains explicit');
  store.setAgentModel(alice.id);
  assert.equal(store.modelFor(alice, channel.id, piDefault).id, 'group-one');
  assert.equal(store.modelFor(alice, second.id, piDefault).id, 'group-two');
  assert.equal(store.modelFor(alice, null, piDefault).id, 'pi-default');
  assert.throws(() => store.setChannelModel(channel.id, { provider: '', id: 'broken' }), /Provider/);
  assert.equal(store.channelModel(channel.id)?.id, 'group-one');
  store.setSetting(`channel-model:${channel.id}`, '{bad');
  assert.throws(() => store.modelFor(alice, channel.id, piDefault), /Invalid saved channel model/);
  store.setChannelModel(channel.id);
  assert.deepEqual(store.modelFor(alice, channel.id, piDefault), piDefault);
});

test('same, parent, child, symlink and sibling writable directories all start concurrently', async t => {
  const { store, dir, runner, workspace: w } = fixture(t);
  assert.throws(() => new Store(store.dir), /locked/);
  const project = join(dir, 'project'); mkdirSync(project);
  mkdirSync(join(project, '..not-a-parent'));
  const sibling = join(dir, 'project-other'); mkdirSync(sibling);
  const link = join(dir, 'linked'); symlinkSync(project, link);
  const make = (name: string, cwd: string) => store.createAgent({ name, role: 'code', provider: 'demo', model: 'demo', cwd });
  const agents = [make('parent', project), make('same', project), make('child', join(project, '..not-a-parent')), make('linked', link), make('sibling', sibling)];
  const releases = new Map<string, () => void>();
  runner.action = turn => new Promise(resolve => {
    releases.set(turn.agent.name, resolve);
    turn.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const messages = agents.map(a => w.humanDirect(a.id, 'work'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runner.calls.map(c => c.agent.name), ['parent', 'same', 'child', 'linked', 'sibling']);
  for (const message of messages) assert.equal(store.db.prepare('SELECT used FROM chains WHERE id=?').get(message.chainId)?.used, 1);
  releases.forEach(release => release()); await w.idle();
  assert.ok(store.deliveries().every(d => d.state === 'done'));
});

test('channel assistant responds while a same-directory worker runs; failure and cancellation stay isolated', async t => {
  const { store, dir, runner, workspace: w, channel } = fixture(t);
  const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'demo' });
  const worker = store.createAgent({ name: 'coder', role: 'write', provider: 'demo', model: 'demo', cwd: dir });
  runner.action = turn => turn.agent.id === worker.id
    ? new Promise(resolve => turn.signal.addEventListener('abort', () => resolve(), { once: true }))
    : Promise.reject(new Error('failed assistant turn'));
  w.humanDirect(worker.id, 'hold tree'); await new Promise(resolve => setImmediate(resolve));
  w.humanChannel(channel.id, 'assistant responds now'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runner.calls.map(c => c.agent.id), [worker.id, assistant.id]);
  assert.equal(w.status(worker.id), 'working');
  assert.equal(store.deliveries(assistant.id)[0].state, 'failed');
  w.stop(worker.id); await w.idle();
  assert.equal(store.deliveries(worker.id)[0].state, 'interrupted');
  assert.equal(store.deliveries(assistant.id)[0].state, 'failed');
  runner.action = async () => {};
  w.retry(store.deliveries(worker.id)[0].id); await w.idle();
  w.retry(store.deliveries(assistant.id)[0].id); await w.idle();
  assert.ok(store.deliveries().every(d => d.state === 'done'));
});
