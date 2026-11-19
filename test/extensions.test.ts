import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, ProjectTrustStore, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Terminal } from '@earendil-works/pi-tui';
import { PiRunner } from '../src/pi-runner.js';
import { Store } from '../src/store.js';
import { Workspace } from '../src/workspace.js';
import { WorkspaceUI } from '../src/ui.js';
import { safeText } from '../src/render.js';

class TestTerminal implements Terminal {
  columns = 110; rows = 35; kittyProtocolActive = false; output = '';
  input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// Module-scoped state deliberately catches Pi's factory-cache sharing across same-cwd Agents.
const plugin = `let count = 0;
export default function(pi) {
  const show = ctx => { ctx.ui.setWidget('counter', ['COUNTER_WIDGET:' + count]); ctx.ui.setStatus('counter', 'COUNT:' + count); };
  const bump = ctx => { count++; pi.appendEntry('counter', {count}); show(ctx); return count; };
  pi.on('session_start', (_e, ctx) => {
    count = ctx.sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === 'counter').at(-1)?.data.count ?? 0;
    show(ctx);
  });
  pi.on('session_shutdown', () => pi.appendEntry('counter-shutdown', {count}));
  pi.registerTool({ name:'counter', label:'Counter', description:'Test counter', parameters:{type:'object',properties:{}},
    execute: async (_id, _args, _signal, _update, ctx) => ({content:[{type:'text',text:'COUNTER_RESULT:' + bump(ctx)}],details:{count}}) });
  pi.registerTool({ name:'nested_write', label:'Nested write', description:'Test nested guard', parameters:{type:'object',properties:{}},
    execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool('write', {path:'nested.txt',content:'reconciled'})).result });
  pi.registerCommand('bump', { description:'Bump fixture', handler:async (_args,ctx) => { bump(ctx); } });
  pi.registerCommand('reset-session', { handler:async (_args,ctx) => { await ctx.newSession(); } });
  pi.registerCommand('outside-turn', { handler:async () => { await pi.sendUserMessage('UNQUEUED_REQUEST'); } });
  pi.registerCommand('ask-fixture', { handler:async (_args,ctx) => { ctx.ui.notify('ANSWER:' + await ctx.ui.confirm('Confirm fixture', 'Choose carefully', {timeout:500})); } });
  pi.registerCommand('custom-fixture', { handler:async (_args,ctx) => {
    await ctx.ui.custom(async (_tui,_theme,_keys,done) => {
      await new Promise(resolve => setTimeout(resolve,20));
      return {render:() => ['CUSTOM_FIXTURE'], invalidate(){}, handleInput(data){if(data==='\\r') done('chosen');},
        dispose(){pi.appendEntry('custom-disposed',{});} };
    }, {overlay:true});
  } });
  pi.registerCommand('bad-widget', {handler:async (_args,ctx) => ctx.ui.setWidget('bad', () => ({render(){throw new Error('fixture render error');}, invalidate(){}, dispose(){throw new Error('fixture dispose error');}}))});
  pi.registerCommand('bad-cleanup', {handler:async (_args,ctx) => ctx.ui.setWidget('cleanup', () => ({render:()=>[], invalidate(){}, dispose(){throw new Error('fixture cleanup error');}}))});
  pi.registerShortcut('ctrl+shift+y', {handler:async ctx => { bump(ctx); }});
}`;

test('native packages, trust, tools, commands, templates and UI remain scoped to each Agent', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-workspace-extensions-'));
  const agentDir = join(root, 'pi'), cwd = join(root, 'project'), pkg = join(root, 'package');
  for (const dir of [agentDir, cwd, pkg, join(cwd, '.pi', 'extensions'), join(agentDir, 'prompts'), join(agentDir, 'skills', 'fixture')]) mkdirSync(dir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR, previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.HOME = root;
  const todoPackage = process.env.WORKSPACE_TEST_TODO_PACKAGE;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', pi: { extensions: ['index.ts'] } }));
  writeFileSync(join(pkg, 'index.ts'), plugin);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [pkg, ...(todoPackage ? [todoPackage] : [])], extensions: ['-builtin:mcp'] }));
  const originalSettings = readFileSync(join(agentDir, 'settings.json'), 'utf8');
  writeFileSync(join(cwd, '.pi', 'extensions', 'project.ts'), `export default pi => pi.registerCommand('project-only', {handler:async(_args,ctx)=>ctx.ui.notify('TRUSTED_PROJECT')});`);
  writeFileSync(join(agentDir, 'prompts', 'review.md'), '---\ndescription: Review template\n---\nTEMPLATE_MARKER: $1 / $@');
  writeFileSync(join(agentDir, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Skill for automatic discovery\n---\nSKILL_BODY_MARKER');
  const requests: { messages: unknown[]; tools?: { function: { name: string } }[] }[] = [];
  let nextTool: { name: string; args: object } | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const tool = nextTool; nextTool = undefined;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'counter-call', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: 'assistant', content: 'LOCAL_REPLY' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', apiKey: 'local-test', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [{ id: 'local', reasoning: false, contextWindow: 32000, maxTokens: 1000 }],
  } } }));
  const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, 'models.json'), authPath: join(agentDir, 'auth.json'), modelsStorePath: join(agentDir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  const store = new Store(join(root, 'state')), model = { provider: 'fixture', id: 'local' };
  const runner = new PiRunner(store, runtime, [], model, SettingsManager.inMemory(), agentDir);
  const workspace = new Workspace(store, runner);
  const terminal = new TestTerminal();
  const ui = new WorkspaceUI(workspace, terminal, { demo: false, models: [model], defaultModel: model, runtime, cwd, onQuit() {} });
  t.after(async () => {
    ui.stop(); await workspace.close(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const agent = (name: string, tools: 'code' | 'read' | 'chat' = 'code') => store.createAgent({ name, tools, role: 'fixture', provider: model.provider, model: model.id, cwd });
  const alice = agent('alice'), bob = agent('bob'), reader = agent('reader', 'read'), chatter = agent('chatter', 'chat');
  const screen = () => { terminal.output = ''; ui.tui.renderNow(true); return safeText(terminal.output); };
  const entries = (id: string) => SessionManager.open(store.agent(id).sessionFile!).getEntries();
  ui.start(); ui.select({ kind: 'agent', id: alice.id });
  const commands = await runner.commands(alice);
  assert.ok(commands.some(c => c.name === 'bump'));
  assert.ok(commands.some(c => c.name === 'review'));
  assert.ok(commands.some(c => c.name === 'skill:fixture'));
  assert.ok(!commands.some(c => c.name === 'project-only'), 'untrusted project factory never loads');
  assert.ok(!commands.some(c => c.name === 'mcp'), 'disabled builtin stays disabled');
  for (const restricted of [reader, chatter]) {
    assert.ok(!(await runner.commands(restricted)).some(c => c.name === 'bump'), 'restricted profile never loads executable extensions');
    assert.ok(!runner.inspect(restricted).tools.includes('counter'));
  }
  await ui.command('/bump');
  assert.match(screen(), /COUNTER_WIDGET:1/);
  await runner.commands(bob);
  ui.select({ kind: 'agent', id: bob.id });
  assert.match(screen(), /COUNTER_WIDGET:0/);
  await ui.command('/bump'); await ui.command('/bump');
  assert.match(screen(), /COUNTER_WIDGET:2/);
  ui.select({ kind: 'agent', id: alice.id });
  assert.match(screen(), /COUNTER_WIDGET:1/);
  assert.doesNotMatch(screen(), /COUNTER_WIDGET:2/);
  terminal.input('\x1b[121;6u'); await tick();
  assert.match(screen(), /COUNTER_WIDGET:2/);
  await assert.rejects(runner.command(alice, '/reset-session'), /Workspace owns this Agent session/);
  const before = requests.length;
  await runner.command(alice, '/outside-turn');
  assert.equal(requests.length, before, 'extension-initiated turns cannot bypass the queue');
  nextTool = { name: 'counter', args: {} };
  await ui.submit('Use the counter'); await workspace.idle();
  assert.ok(requests.at(-1)?.tools?.some(t => t.function.name === 'counter'), JSON.stringify({ requests: requests.length, tools: runner.inspect(alice).tools, deliveries: store.deliveries(alice.id), messages: runner.inspect(alice).messages.filter(m => (m as {role?:string}).role !== 'system').slice(-3) }));
  assert.ok(JSON.stringify(runner.inspect(alice).messages).includes('COUNTER_RESULT:3'));
  assert.ok(runner.inspect(alice).system.includes('Skill for automatic discovery'));
  writeFileSync(join(cwd, 'nested.txt'), 'unread original');
  nextTool = { name: 'nested_write', args: {} };
  await ui.submit('Attempt nested overwrite'); await workspace.idle();
  assert.equal(readFileSync(join(cwd, 'nested.txt'), 'utf8'), 'unread original', 'nested executeTool cannot bypass the file guard');
  assert.ok(JSON.stringify(runner.inspect(alice).messages).includes('unread or changed since your last read'));
  nextTool = { name: 'read', args: { path: 'nested.txt' } };
  await ui.submit('Read before editing'); await workspace.idle();
  nextTool = { name: 'nested_write', args: {} };
  await ui.submit('Apply reconciled nested edit'); await workspace.idle();
  assert.equal(readFileSync(join(cwd, 'nested.txt'), 'utf8'), 'reconciled');
  const file = store.agent(alice.id).sessionFile; assert.ok(file);
  await runner.release(alice.id);
  assert.ok(entries(alice.id).some(e => e.type === 'custom' && e.customType === 'counter-shutdown'));
  await runner.commands(store.agent(alice.id));
  assert.equal(store.agent(alice.id).sessionFile, file);
  assert.match(screen(), /COUNTER_WIDGET:3/);
  await ui.submit('/review "quoted words" tail'); await workspace.idle();
  assert.ok(JSON.stringify(requests.at(-1)?.messages).includes('TEMPLATE_MARKER: quoted words / quoted words tail'));
  await ui.submit('/skill:fixture inspect'); await workspace.idle();
  assert.ok(JSON.stringify(requests.at(-1)?.messages).includes('SKILL_BODY_MARKER'));
  store.post({ id: 'peer-command', channelId: null, sender: bob.id, target: alice.id, text: '/bump', chainId: 'peer-command' }, [alice.id]);
  workspace.kick(); await workspace.idle();
  assert.match(screen(), /COUNTER_WIDGET:3/, 'peer slash text never dispatches a command');
  const ask = ui.command('/ask-fixture'); await tick();
  assert.match(screen(), /Confirm fixture/);
  ui.select({ kind: 'agent', id: bob.id }); await ask;
  ui.editor.setText('BOB_DRAFT');
  await runner.command(alice, '/ask-fixture');
  assert.equal(ui.editor.getText(), 'BOB_DRAFT', 'background dialog cannot touch another Agent draft');
  assert.doesNotMatch(screen(), /Confirm fixture/);
  ui.select({ kind: 'agent', id: alice.id });
  const custom = ui.command('/custom-fixture'); await tick();
  ui.select({ kind: 'agent', id: bob.id }); await custom;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.doesNotMatch(screen(), /CUSTOM_FIXTURE/, 'late custom factory cannot reopen after selection changed');
  assert.ok(entries(alice.id).some(e => e.type === 'custom' && e.customType === 'custom-disposed'));
  ui.select({ kind: 'agent', id: alice.id });
  const timedOut = ui.command('/ask-fixture'); await timedOut;
  assert.match(screen(), /ANSWER:false/);
  assert.doesNotMatch(screen(), /Confirm fixture/);
  const accepted = ui.command('/custom-fixture'); await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(screen(), /CUSTOM_FIXTURE/);
  terminal.input('\r'); await accepted;
  assert.doesNotMatch(screen(), /CUSTOM_FIXTURE/);
  await ui.command('/bad-widget');
  assert.doesNotThrow(screen, 'extension render and disposal errors cannot crash the TUI');
  await ui.command('/bad-cleanup');
  new ProjectTrustStore(agentDir).set(cwd, true);
  const trusted = agent('trusted');
  assert.ok((await runner.commands(trusted)).some(c => c.name === 'project-only'));
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), originalSettings, 'resource loading never rewrites Pi settings');
  await t.test('installed rpiv-todo tools, /todos, widgets and restart persistence', { skip: !todoPackage }, async () => {
    assert.ok(commands.some(c => c.name === 'todos'));
    for (const [who, subject] of [[alice, 'ALICE_PRIVATE_TASK'], [bob, 'BOB_PRIVATE_TASK']] as const) {
      ui.select({ kind: 'agent', id: who.id });
      nextTool = { name: 'todo', args: { action: 'create', subject } };
      await ui.submit('Create my task'); await workspace.idle();
      await ui.command('/todos');
      assert.match(screen(), new RegExp(subject));
      assert.doesNotMatch(screen(), new RegExp(who.id === alice.id ? 'BOB_PRIVATE_TASK' : 'ALICE_PRIVATE_TASK'));
    }
    await runner.release(alice.id);
    ui.select({ kind: 'agent', id: alice.id });
    await ui.command('/todos');
    assert.match(screen(), /ALICE_PRIVATE_TASK/);
    assert.doesNotMatch(screen(), /BOB_PRIVATE_TASK/);
  });
});
