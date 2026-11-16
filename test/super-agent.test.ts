import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Agent } from '../src/store.js';
import { Workspace, type Runner, type Turn } from '../src/workspace.js';

class TestRunner implements Runner {
  turns: Turn[] = [];
  action: (turn: Turn) => Promise<string | void> = async () => 'Answer';
  async run(turn: Turn) { this.turns.push(turn); return this.action(turn); }
  async steer() {}
  inspect(_agent: Agent) { return { system: '', tools: [], messages: [] }; }
  async close() {}
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-super-agent-'));
  const store = new Store(join(dir, 'state'));
  const channel = store.channels()[0];
  const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'local' });
  const worker = store.createAgent({ name: 'scout', role: 'Researcher', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
  store.setMembers(channel.id, [worker.id]);
  const runner = new TestRunner(), workspace = new Workspace(store, runner);
  t.after(async () => { await workspace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, channel, assistant, worker, runner, workspace };
}

test('one permanent assistant per channel; ordinary replies do not self-trigger', async t => {
  const { dir, store, channel, assistant, runner, workspace: w } = fixture(t);
  assert.equal(store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'changed' }).id, assistant.id);
  const root = w.humanChannel(channel.id, 'hello'); await w.idle();
  assert.equal(runner.turns.length, 1); assert.equal(runner.turns[0].agent.id, assistant.id);
  assert.deepEqual(store.messages(channel.id).map(m => m.text), ['hello', 'Answer']);
  assert.equal(store.messages(channel.id)[1].chainId, root.chainId);
  store.setMembers(channel.id, []); assert.deepEqual(store.members(channel.id).map(a => a.id), [assistant.id]);
  const second = store.createChannel('research');
  const secondAssistant = store.ensureChannelAssistant(second.id, dir, { provider: 'demo', id: 'local' });
  assert.notEqual(secondAssistant.id, assistant.id);
  assert.throws(() => store.setMembers(second.id, [assistant.id]), /only to its own channel/);
  assert.throws(() => store.setAgentModel(assistant.id), /Use \/models/);
  store.setChannelModel(channel.id, { provider: 'demo', id: 'channel-model' });
  assert.equal(store.modelFor(assistant, null, { provider: 'demo', id: 'pi' }).id, 'channel-model');
});

test('directed messages skip the assistant; worker public results return to it, but DMs stay private', async t => {
  const { store, channel, assistant, worker, runner, workspace: w } = fixture(t);
  runner.action = async turn => {
    if (turn.agent.id === worker.id && turn.message.channelId) turn.send({ channel: channel.id, text: 'Research complete' });
    return 'Summary';
  };
  w.humanChannel(channel.id, '@scout research'); await w.idle();
  assert.deepEqual(runner.turns.map(t => t.agent.id), [worker.id, assistant.id]);
  assert.deepEqual(store.messages(channel.id).map(m => m.text), ['@scout research', 'Research complete', 'Summary']);
  w.humanDirect(assistant.id, 'private context'); await w.idle();
  assert.equal(store.messages(channel.id).length, 3);
  runner.action = async turn => { turn.send({ channel: channel.id, text: 'Already published' }); return 'Do not duplicate'; };
  w.humanChannel(channel.id, 'next'); await w.idle();
  assert.equal(store.messages(channel.id).at(-1)?.text, 'Already published');
});

test('private steer suppresses automatic publication, and long answers keep a source pointer', async t => {
  const { store, channel, assistant, runner, workspace: w } = fixture(t);
  let release = () => {};
  runner.action = async turn => {
    await new Promise<void>(r => { release = r; });
    assert.throws(() => turn.createWorker({ name: 'leak', role: 'Private', task: 'Do not share' }, 'private'), /unsteered/);
    return 'Private steer response';
  };
  w.humanChannel(channel.id, 'work'); await new Promise<void>(r => setImmediate(r));
  await w.steer(assistant.id, 'private guidance'); release(); await w.idle();
  assert.equal(store.messages(channel.id).length, 1);
  runner.action = async () => 'a'.repeat(40_000);
  w.humanChannel(channel.id, 'long answer'); await w.idle();
  const reply = store.messages(channel.id).at(-1)!.text;
  assert.ok(reply.length <= 32_000); assert.ok(reply.includes('full reply is in the assistant session'));
});

test('archive removes workers from routing, preserves sources, and shares only authorized public memory', async t => {
  const { store, channel, assistant, worker, runner, workspace: w, dir } = fixture(t);
  runner.action = async turn => {
    if (turn.agent.id === worker.id && turn.message.channelId) turn.send({ channel: channel.id, text: '缓存结论: use a bounded cache, never store tokens. ' + 'details '.repeat(200) });
    return 'Done';
  };
  w.humanChannel(channel.id, '@scout investigate'); await w.idle();
  const publicResult = store.messages(channel.id).find(m => m.sender === worker.id)!;
  const secret = w.humanDirect(worker.id, 'private-secret-marker'); await w.idle();
  store.setSession(worker.id, '/preserved/session.jsonl');
  await w.archive(worker.id);
  assert.equal(w.status(worker.id), 'archived');
  assert.ok(!store.agents().some(a => a.id === worker.id));
  assert.equal(store.agent(worker.id).sessionFile, '/preserved/session.jsonl');
  assert.throws(() => w.humanDirect(worker.id, 'wake'), /archived/);
  assert.throws(() => w.humanChannel(channel.id, '@scout wake'), /not a member/);
  assert.throws(() => w.resume(worker.id), /cannot resume/);
  assert.throws(() => store.setMembers(channel.id, [worker.id]), /Archived/);
  await assert.rejects(w.archive(assistant.id), /permanent/);
  const hits = store.memorySearch(assistant.id, '缓存结论 cache');
  assert.equal(hits.length, 1); assert.equal(hits[0].id, publicResult.id); assert.ok(hits[0].excerpt.length < 610);
  assert.equal(store.memoryRead(assistant.id, hits[0].id).text, publicResult.text);
  assert.equal(store.memorySearch(assistant.id, 'private-secret-marker').length, 0);
  assert.throws(() => store.memoryRead(assistant.id, secret.id), /not shared/);
  assert.equal(store.memorySearch(assistant.id, "' OR 1=1 --").length, 0);
  const outsider = store.createAgent({ name: 'outsider', role: 'Other group', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
  assert.equal(store.memorySearch(outsider.id, 'cache').length, 0);
  assert.throws(() => store.memoryRead(outsider.id, publicResult.id), /not shared/);
  store.setMembers(channel.id, [outsider.id]);
  assert.equal(store.memorySearch(outsider.id, 'cache').length, 1, 'new workers can reuse archived work');
  store.setMembers(channel.id, []);
  assert.throws(() => store.memoryRead(outsider.id, publicResult.id), /not shared/, 'revocation applies to source reads');
});

test('archive waits for a stopped turn and cancels queued deliveries', async t => {
  const { store, worker, runner, workspace: w } = fixture(t);
  runner.action = turn => new Promise(resolve => turn.signal.addEventListener('abort', () => resolve('Do not publish'), { once: true }));
  w.humanDirect(worker.id, 'running'); await new Promise<void>(r => setImmediate(r));
  w.humanDirect(worker.id, 'queued');
  await w.archive(worker.id);
  assert.ok(store.deliveries(worker.id).every(d => d.state === 'cancelled'));
});

test('assistant names workers without approval, announces roles, deduplicates and bounds creation', async t => {
  const { store, channel, assistant, runner, workspace: w } = fixture(t);
  runner.action = async turn => {
    if (turn.agent.id !== assistant.id) {
      assert.throws(() => turn.createWorker({ name: 'recursive', role: 'Bad', task: 'Expand' }, 'bad'), /channel-assistant/);
      return;
    }
    if (turn.message.sender !== 'human') return 'Received the worker result';
    const spec = { name: 'scout', role: 'Research dependency options', task: 'Compare the two options' };
    const result = turn.createWorker(spec, 'first');
    assert.equal(turn.createWorker(spec, 'first').agentId, result.agentId);
    assert.throws(() => turn.createWorker({ ...spec, task: 'different' }, 'first'), /conflict/);
    assert.equal(store.agent(result.agentId!).name, 'scout-2', 'collisions keep a readable short name');
    assert.equal(store.agent(result.agentId!).tools, 'code');
    turn.createWorker({ ...spec, name: 'tester' }, 'second');
    turn.createWorker({ ...spec, name: 'reviewer' }, 'third');
    turn.createWorker({ ...spec, name: 'fourth' }, 'fourth');
    turn.createWorker({ ...spec, name: 'fifth' }, 'fifth');
    return 'I have delegated and can keep talking.';
  };
  w.humanChannel(channel.id, 'delegate this task'); await w.idle();
  assert.equal(store.workerRequests().length, 5, 'one task can exceed both old AI-only creation limits');
  assert.ok(store.workerRequests().every(r => r.state === 'created'));
  assert.ok(store.messages(channel.id).some(m => m.text.includes('Created @scout-2 — Research dependency options')));
  assert.ok(store.messages(channel.id).some(m => m.text.includes('keep talking')));
  assert.ok(store.deliveries().every(d => d.state === 'done'), JSON.stringify(store.deliveries()));
});

test('approval is opt-in, rejects safely, and revalidates changed permissions', async t => {
  const { store, channel, assistant, runner, workspace: w } = fixture(t);
  store.setSetting(`autonomy:${channel.id}`, 'approve');
  store.setSetting(`worker-profile:${channel.id}`, 'read');
  runner.action = async turn => {
    if (turn.agent.id === assistant.id && turn.message.sender === 'human') turn.createWorker({ name: 'analyst', role: 'Read project', task: 'Summarize it' }, 'request');
  };
  w.humanChannel(channel.id, 'delegate one'); await w.idle();
  let request = store.workerRequests()[0];
  assert.equal(request.state, 'pending'); assert.equal(request.agentId, null);
  assert.equal(store.agents().length, 2);
  store.setSetting(`worker-profile:${channel.id}`, 'chat');
  assert.throws(() => w.approveWorker(request.id, true), /permissions changed/);
  w.approveWorker(request.id, false);
  assert.equal(store.workerRequests()[0].state, 'rejected');
  assert.throws(() => w.approveWorker(request.id, true), /No pending/);
  w.humanChannel(channel.id, 'delegate two'); await w.idle();
  request = store.workerRequests()[1];
  store.db.prepare('UPDATE chains SET used=budget WHERE id=?').run(request.chainId);
  assert.throws(() => w.approveWorker(request.id, true), /budget exhausted/);
  w.continueBudget(assistant.id);
  w.approveWorker(request.id, true); await w.idle();
  assert.equal(store.workerRequests()[1].state, 'created');
  assert.equal(store.agent(store.workerRequests()[1].agentId!).tools, 'chat');
});

test('two busy chat workers do not block the human assistant; @ followups queue on the named worker', async t => {
  const { store, channel, assistant, runner, workspace: w } = fixture(t);
  store.setSetting(`worker-profile:${channel.id}`, 'chat');
  const releases: (() => void)[] = [];
  let workersStarted = () => {}, answered = () => {};
  const ready = new Promise<void>(r => { workersStarted = r; }), answer = new Promise<void>(r => { answered = r; });
  runner.action = async turn => {
    if (turn.agent.id === assistant.id) {
      if (turn.message.text === 'delegate') {
        for (const name of ['builder', 'tester']) turn.createWorker({ name, role: 'Do a bounded task', task: name }, name);
      } else if (turn.message.text === 'are you here?') answered();
      return 'I am here';
    }
    if (turn.message.sender === assistant.id) await new Promise<void>(resolve => {
      releases.push(resolve); turn.signal.addEventListener('abort', () => resolve(), { once: true });
      if (releases.length === 2) workersStarted();
    });
  };
  w.humanChannel(channel.id, 'delegate'); await ready;
  w.humanChannel(channel.id, '@builder include edge cases');
  w.humanChannel(channel.id, 'are you here?'); await answer;
  assert.equal(w.status(store.agent('builder').id), 'working');
  assert.equal(store.deliveries(store.agent('builder').id).filter(d => d.state === 'queued').length, 1);
  releases.forEach(release => release()); await w.idle();
  assert.ok(runner.turns.some(turn => turn.agent.name === 'builder' && turn.message.text.includes('edge cases')));
  assert.ok(store.deliveries().every(d => d.state === 'done'));
});

test('automatic workers share the human creation limit, cannot originate from private input, and can be archived by their assistant', async t => {
  const { store, channel, assistant, worker, dir, runner, workspace: w } = fixture(t);
  for (let i = 0; i < 122; i++) store.createAgent({ ...worker, name: `human-${i}`, cwd: dir });
  let retired = '';
  runner.action = async turn => {
    if (turn.agent.id !== assistant.id) return;
    const spec = { name: 'helper', role: 'Bounded helper', task: 'Report a useful result' };
    if (!turn.message.channelId) { assert.throws(() => turn.createWorker(spec, 'private'), /channel-assistant/); return; }
    if (turn.message.text === 'first') for (let i = 0; i < 3; i++) turn.createWorker(spec, String(i));
    if (turn.message.text === 'second') {
      turn.createWorker(spec, 'fourth');
      assert.equal(store.agents().length, 128);
      assert.throws(() => turn.createWorker(spec, 'fifth'), /128 unarchived Agents/);
      assert.equal(store.workerRequests().length, 4, 'failed creation rolls back its request');
      assert.equal(store.messages(channel.id).filter(m => m.text.startsWith('Created @')).length, 4);
      assert.throws(() => store.createAgent({ ...worker, name: 'human-overflow' }), /128 unarchived Agents/);
    }
    if (turn.message.text === 'retire') {
      retired = store.workerRequests()[0].agentId!;
      await turn.archiveWorker(retired);
      turn.createWorker(spec, 'replacement');
      assert.equal(store.agents().length, 128, 'archiving frees shared capacity');
    }
  };
  w.humanDirect(assistant.id, 'private'); await w.idle();
  assert.equal(store.workerRequests().length, 0);
  w.humanChannel(channel.id, 'first'); await w.idle();
  w.humanChannel(channel.id, 'second'); await w.idle();
  w.humanChannel(channel.id, 'retire'); await w.idle();
  assert.ok(store.archived(retired));
  assert.ok(store.deliveries().every(d => d.state === 'done'));
  store.setSetting(`autonomy:${channel.id}`, 'off');
  runner.action = async turn => { assert.throws(() => turn.createWorker({ name: 'disabled', role: 'No', task: 'No' }, 'disabled'), /disabled/); };
  w.humanChannel(channel.id, 'disabled'); await w.idle();
  assert.equal(store.workerRequests().length, 5);
});

test('approval rechecks shared capacity without losing the pending request', async t => {
  const { store, channel, assistant, worker, runner, workspace: w } = fixture(t);
  store.setSetting(`autonomy:${channel.id}`, 'approve');
  runner.action = async turn => {
    if (turn.agent.id === assistant.id) turn.createWorker({ name: 'approved', role: 'Help', task: 'Review' }, 'request');
  };
  w.humanChannel(channel.id, 'propose'); await w.idle();
  const request = store.workerRequests()[0];
  for (let i = store.agents().length; i < 128; i++) store.createAgent({ ...worker, name: `human-${i}` });
  assert.throws(() => w.approveWorker(request.id, true), /128 unarchived Agents/);
  assert.equal(store.workerRequests()[0].state, 'pending');
  assert.equal(store.workerRequests()[0].agentId, null);
  assert.equal(store.agents().length, 128);
  await w.archive(worker.id);
  w.approveWorker(request.id, true); await w.idle();
  assert.equal(store.workerRequests()[0].state, 'created');
  assert.equal(store.agents().length, 128);
});

test('schema 5 upgrades existing tools once, preserving approvals, sessions, pause and identity colors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tools-migrate-'));
  let store = new Store(join(dir, 'state'));
  try {
    const channel = store.channels()[0];
    const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'local' });
    const reader = store.createAgent({ name: 'reader', role: 'Read', provider: 'demo', model: 'local', cwd: dir, tools: 'read' });
    const archived = store.createAgent({ name: 'retired', role: 'Old', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
    const ordinal = store.agentOrdinal(reader.id);
    store.setSession(reader.id, '/preserved/reader.jsonl'); store.pause(reader.id, true);
    store.archiveAgent(archived.id);
    store.setSetting(`worker-profile:${channel.id}`, 'read');
    store.setSetting(`autonomy:${channel.id}`, 'approve');
    store.post({ id: 'old', channelId: channel.id, sender: 'human', target: null, text: 'original', chainId: 'old' }, []);
    store.addWorkerRequest({ id: 'pending', channelId: channel.id, assistantId: assistant.id, chainId: 'old', name: 'proposed', role: 'Read', task: 'Read only', tools: 'read', state: 'pending', agentId: null });
    store.db.prepare("UPDATE agents SET tools='chat' WHERE id=?").run(assistant.id);
    store.db.exec('PRAGMA user_version=4');
    store.close(); store = new Store(join(dir, 'state'));
    assert.equal(store.agent(assistant.id).tools, 'code');
    assert.equal(store.agent(reader.id).tools, 'code');
    assert.equal(store.agent(reader.id).paused, 1);
    assert.equal(store.agent(reader.id).sessionFile, '/preserved/reader.jsonl');
    assert.equal(store.agent(archived.id).tools, 'chat');
    assert.equal(store.getSetting(`worker-profile:${channel.id}`), 'code');
    assert.equal(store.getSetting(`autonomy:${channel.id}`), 'approve');
    assert.equal(store.messages(channel.id)[0].text, 'original');
    assert.equal(store.workerRequests()[0].state, 'pending');
    assert.equal(store.workerRequests()[0].tools, 'read');
    assert.equal(store.agentOrdinal(reader.id), ordinal);
    const restricted = store.createAgent({ name: 'restricted', role: 'Chat', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
    store.setSetting(`worker-profile:${channel.id}`, 'read');
    store.close(); store = new Store(join(dir, 'state'));
    assert.equal(store.agent(restricted.id).tools, 'chat');
    assert.equal(store.getSetting(`worker-profile:${channel.id}`), 'read');
    assert.equal(store.agentOrdinal(reader.id), ordinal);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('schema upgrade keeps old sessions and durable approvals survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-super-migrate-'));
  let store = new Store(join(dir, 'state'));
  try {
    const legacy = store.createAgent({ name: 'legacy', role: 'Original role', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
    const channel = store.channels()[0];
    store.setSession(legacy.id, '/preserved/legacy.jsonl'); store.setMembers(channel.id, [legacy.id]);
    store.post({ id: 'old-message', channelId: channel.id, sender: 'human', target: null, text: 'Original task', chainId: 'old-message' }, []);
    store.db.exec('DROP TABLE worker_requests; DROP TABLE archives; DROP TABLE channel_assistants; PRAGMA user_version=1');
    store.close(); store = new Store(join(dir, 'state'));
    assert.equal(store.agent(legacy.id).sessionFile, '/preserved/legacy.jsonl');
    assert.equal(store.messages(channel.id)[0].text, 'Original task');
    const assistant = store.ensureChannelAssistant(channel.id, dir, { provider: 'demo', id: 'local' });
    store.addWorkerRequest({ id: 'proposal', channelId: channel.id, assistantId: assistant.id, chainId: 'old-message',
      name: 'reader', role: 'Read evidence', task: 'Check source', tools: 'chat', state: 'pending', agentId: null });
    store.archiveAgent(legacy.id); store.close(); store = new Store(join(dir, 'state'));
    assert.equal(store.channelAssistant(channel.id)?.id, assistant.id);
    assert.equal(store.workerRequests()[0].state, 'pending');
    assert.equal(store.agents().length, 1, 'restart does not approve or recreate workers');
    assert.ok(store.archived(legacy.id));
    assert.equal(store.agent(legacy.id).sessionFile, '/preserved/legacy.jsonl');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
