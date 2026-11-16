import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Markdown, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { loadSkillsFromDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { statusLine, ink, messageBlock, renderEntry } from '../src/appearance.js';
import { Store } from '../src/store.js';
import { Workspace } from '../src/workspace.js';
import { DemoRunner } from '../src/demo-runner.js';
import { WorkspaceUI } from '../src/ui.js';
import { lines, safeText, messageText, messageView } from '../src/render.js';
import { AGENT_COLORS, agentInk, colorTable } from '../src/agent-colors.js';
import { colorToHex } from '@earendil-works/pi-tui';

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; stopped = false;
  input: (s: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function fixture(t: TestContext, options: { runtime?: ModelRuntime; settings?: SettingsManager } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-ui-'));
  const store = new Store(join(dir, 'state'));
  const alice = store.createAgent({ name: 'alice', role: 'test', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
  const channel = store.channels()[0]; store.setMembers(channel.id, [alice.id]);
  const workspace = new Workspace(store, new DemoRunner(store));
  const terminal = new TestTerminal(); let quit = false;
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: review-test\ndescription: Review fixture skill\n---\nInspect the requested change.');
  const { skills } = loadSkillsFromDir({ dir, source: 'test' });
  const ui = new WorkspaceUI(workspace, terminal, { demo: true, models: [{ provider: 'demo', id: 'local' }, { provider: 'demo', id: 'reasoner' }], defaultModel: { provider: 'demo', id: 'local' }, ...options, skills, cwd: dir, onQuit: () => { quit = true; } });
  ui.start();
  t.after(async () => { ui.stop(); await workspace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, alice, channel, workspace, terminal, ui, quit: () => quit };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('255 unique RGB colors have numbered swatches and a bounded fallback', () => {
  assert.equal(AGENT_COLORS.length, 255);
  assert.equal(new Set(AGENT_COLORS.map(colorToHex)).size, 255);
  assert.equal(colorTable().length, 255);
  assert.match(safeText(colorTable()[0]), /^001  #[0-9a-f]{6}  ████ Agent$/i);
  assert.match(safeText(colorTable()[254]), /^255 /);
  assert.equal(agentInk(255)('speaker'), agentInk(0)('speaker'));
});

test('speaker colors agree across channel, direct, streaming and peer messages', async t => {
  const { ui, store, channel, alice, workspace } = fixture(t);
  const prefix = ui.speakerInk(alice.id)('MARK').split('MARK')[0];
  const assistant = store.channelAssistant(channel.id)!;
  assert.notEqual(prefix, ui.speakerInk(assistant.id)('MARK').split('MARK')[0]);
  workspace.humanChannel(channel.id, '@alice color check'); await workspace.idle();
  assert.ok(ui.body(80).some(line => safeText(line).startsWith('╭ alice ·') && line.startsWith(prefix)));
  ui.select({ kind: 'agent', id: alice.id });
  assert.ok(ui.body(80).some(line => safeText(line).startsWith('╭ alice ') && line.startsWith(prefix)));
  const namedAi = store.createAgent({ name: 'ai', role: 'worker named ai', provider: 'demo', model: 'local', cwd: alice.cwd });
  workspace.runner.inspect = () => ({ system: '', tools: [], messages: [
    { role: 'assistant', stopReason: 'pending', content: [{ type: 'text', text: 'streaming' }] },
    { role: 'user', senderName: 'alice', content: 'peer message' },
    { role: 'user', senderName: 'ai', content: 'worker, not the assistant alias' },
  ] });
  ui.select({ kind: 'agent', id: assistant.id });
  const body = ui.body(80);
  assert.ok(body.some(line => safeText(line).startsWith('╭ alice ') && line.startsWith(prefix)));
  assert.ok(body.some(line => safeText(line).startsWith('╭ ai · streaming') && line.startsWith(ui.speakerInk(assistant.id)('MARK').split('MARK')[0])));
  assert.ok(body.some(line => safeText(line).startsWith('╭ ai ') && line.startsWith(ui.speakerInk(namedAi.id)('MARK').split('MARK')[0])));
  store.archiveAgent(alice.id);
  store.createAgent({ name: 'aaa', role: 'new', provider: 'demo', model: 'local', cwd: alice.cwd });
  assert.equal(ui.speakerInk(alice.id)('MARK').split('MARK')[0], prefix);
});

test('outline frames retain Markdown, strip terminal injection and have exact visible widths', t => {
  fixture(t);
  for (const human of [true, false]) for (const width of [0, 1, 3, 4, 5, 6, 20, 80]) {
    const rendered = messageBlock('you\x1b]52;c;bad\x07', '**bold** 中文🙂\n\n```ts\nconst x = 1;\n```', width, human);
    assert.ok(!rendered.join('\n').includes('\x1b]52;'));
    for (const line of rendered) assert.ok(visibleWidth(line) <= width);
    if (width >= 5) {
      assert.ok(rendered.every(line => visibleWidth(line) === width));
      assert.ok(safeText(rendered[0]).startsWith('╭'));
      assert.ok(safeText(rendered.at(-1)!).endsWith('╯'));
      assert.ok(rendered.slice(1, -1).every(line => safeText(line).startsWith('│ ') && safeText(line).endsWith(' │')));
    }
  }
});

test('safe rendering strips terminal control strings and keeps Chinese/emoji in width', () => {
  assert.ok(!safeText('a\x1b]52;c;secret\x07\x1b[31mb\x1b[0m\u202ec').includes('\x1b'));
  for (const width of [1, 3, 12, 40]) for (const line of lines('中文🙂 hello 世界\n下一行', width)) assert.ok(visibleWidth(line) <= width);
  assert.ok(messageText({ role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(500) }] }).length < 400);
  assert.ok(messageText({ role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(500) }] }, true).length > 500);
});

test('transcript reuses unchanged Markdown and invalidates changed text, width and theme', t => {
  const { ui, workspace, alice } = fixture(t);
  const assistant = { role: 'assistant', stopReason: 'pending', content: [{ type: 'text', text: '**streaming**' }] };
  workspace.runner.inspect = () => ({ system: '', tools: [], messages: [
    { role: 'user', content: 'unchanged history' }, assistant,
  ] });
  ui.select({ kind: 'agent', id: alice.id });
  const render = t.mock.method(Markdown.prototype, 'render');
  const first = ui.body(80);
  assert.equal(render.mock.callCount(), 2);
  assert.deepEqual(ui.body(80), first);
  assert.equal(render.mock.callCount(), 2, 'unchanged history does not run Markdown layout again');
  assistant.content[0].text = '**updated**';
  assert.match(safeText(ui.body(80).join('\n')), /updated/);
  assert.equal(render.mock.callCount(), 3, 'only the changed streaming block is redrawn');
  ui.body(60);
  assert.equal(render.mock.callCount(), 5, 'resize reflows both blocks');
  ui.tui.invalidate();
  ui.body(60);
  assert.equal(render.mock.callCount(), 7, 'theme invalidation discards styled lines');
});

test('view switching retains independent drafts and direct prompt enters actual context only', async t => {
  const { ui, alice, channel, workspace: w, store, terminal, quit } = fixture(t);
  ui.editor.setText('群聊草稿🙂'); ui.select({ kind: 'agent', id: alice.id });
  assert.equal(ui.editor.getText(), ''); ui.editor.setText('Agent draft');
  ui.select({ kind: 'channel', id: channel.id }); assert.equal(ui.editor.getText(), '群聊草稿🙂');
  ui.select({ kind: 'agent', id: alice.id }); assert.equal(ui.editor.getText(), 'Agent draft');
  await ui.submit('private-ui-prompt'); await w.idle();
  assert.equal(store.messages(channel.id).length, 0);
  assert.ok(ui.body(80).join('\n').includes('private-ui-prompt'));
  w.stop(alice.id); await ui.submit('queued-visible-marker');
  assert.ok(ui.body(80).join('\n').includes('you: queued-visible-marker'));
  w.resume(alice.id); await w.idle();
  for (const width of [30, 80]) { terminal.columns = width; terminal.resize(); ui.tui.renderNow(true); }
  assert.ok(terminal.output.includes('Pi Workspace'));
  terminal.input('\x11'); assert.equal(quit(), true);
});

test('keyboard sends group text, navigates, and creates Agent through actual input overlays', async t => {
  const { ui, store, terminal, channel, quit } = fixture(t);
  terminal.input('plain group message'); terminal.input('\r'); await tick();
  assert.equal(store.messages(channel.id)[0].text, 'plain group message');
  assert.equal(store.deliveries()[0].agentId, store.channelAssistant(channel.id)?.id);
  terminal.input('@unknown keep this draft'); terminal.input('\r'); await tick();
  assert.equal(ui.editor.getText(), '@unknown keep this draft'); ui.editor.setText('');
  terminal.input('\t'); terminal.input('\x1b[B'); terminal.input('\r');
  assert.equal(ui.selected.kind, 'agent');
  const creating = ui.createAgent(); await tick();
  terminal.input('bob'); terminal.input('\r'); await tick(); // name
  terminal.input('\r'); await tick(); // role default
  terminal.input('\r'); await tick(); // model default
  terminal.input('\r'); await tick(); // cwd default
  terminal.input('\r'); await creating; // Pi native profile
  assert.equal(store.agent('bob').tools, 'code');
  assert.equal(store.inheritsModel(store.agent('bob').id), true);
  assert.equal(ui.selected.id, store.agent('bob').id);
  assert.equal(store.members(channel.id).length, 3);
  terminal.input('\x11'); assert.equal(quit(), true);
});

test('channel creation at capacity leaves no orphan channel and succeeds after an archive', async t => {
  const { ui, terminal, store, alice } = fixture(t);
  for (let i = store.agents().length; i < 128; i++) store.createAgent({ ...alice, name: `worker-${i}` });
  const create = async () => {
    const creating = ui.createChannel(); await tick();
    terminal.input('overflow'); terminal.input('\r'); await tick();
    terminal.input('\r'); await creating;
  };
  await create();
  assert.deepEqual(store.channels().map(c => c.name), ['general']);
  assert.equal(store.agents().length, 128);
  store.archiveAgent(alice.id);
  await create();
  assert.ok(store.channelAssistant(store.channel('overflow').id));
  assert.equal(store.agents().length, 128);
});

test('click selects sidebar Agent and quit does not render session into shell scrollback', async t => {
  const { ui, terminal, alice } = fixture(t);
  ui.tui.renderNow(true);
  terminal.input('\x1b[<0;4;7M'); terminal.input('\x1b[<0;4;7m');
  assert.equal(ui.selected.id, alice.id);
  terminal.output = ''; ui.stop();
  assert.equal(terminal.stopped, true);
  assert.ok(!terminal.output.includes('No conversation yet'));
});

async function menu(ui: WorkspaceUI): Promise<void> {
  for (let i = 0; i < 50 && !ui.editor.capturesViewportInput; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ui.editor.capturesViewportInput, 'native completion menu should open');
  ui.tui.renderNow(true);
}

test('native slash skill and @ Agent menus are visible, complete with Tab, and keep editor focus', async t => {
  const { ui, terminal, channel, store, workspace, alice } = fixture(t);
  terminal.input('/rev'); await menu(ui);
  assert.ok(terminal.output.includes('skill:review-test'));
  terminal.input('\t'); assert.equal(ui.editor.getText(), '/skill:review-test ');
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  terminal.input('@ali'); await menu(ui);
  assert.ok(terminal.output.includes('@alice'));
  terminal.input('\t'); assert.equal(ui.editor.getText(), '/skill:review-test @alice ');
  terminal.input('check this'); terminal.input('\r'); await tick(); await workspace.idle();
  assert.equal(store.messages(channel.id)[0].text, '/skill:review-test @alice check this');
  assert.equal(store.deliveries(alice.id).length, 1);
  // Catalog is live after creation, and menu height is not clipped at a narrow viewport.
  store.createAgent({ name: 'bob', role: 'test', provider: 'demo', model: 'local', cwd: alice.cwd, tools: 'chat' });
  terminal.columns = 40; terminal.rows = 18; terminal.resize();
  terminal.output = ''; terminal.input('@bo'); await menu(ui);
  assert.ok(terminal.output.includes('@bob'));
  terminal.input('\x1b'); await tick();
  assert.equal(ui.editor.capturesViewportInput, false);
  assert.equal(ui.editor.getText(), '@bo');
});

test('unaddressed skills go to channel assistant and direct invocation stays private', async t => {
  const { ui, terminal, channel, store, workspace, alice } = fixture(t);
  await ui.submit('/skill:review-test inspect'); await workspace.idle();
  assert.equal(store.messages(channel.id).length, 2);
  assert.equal(store.deliveries()[0].agentId, store.channelAssistant(channel.id)?.id);
  ui.select({ kind: 'agent', id: alice.id });
  await ui.submit('/skill:review-test private'); await workspace.idle();
  assert.equal(store.messages(channel.id).length, 2);
  assert.ok(ui.body(80).join('\n').includes('/skill:review-test private'));
  ui.editor.setText(''); terminal.input('/skill:missing task'); terminal.input('\r'); await tick();
  assert.equal(ui.editor.getText(), '/skill:missing task');
});

test('Pi theme renders colored, width-safe chrome without font-dependent separators', t => {
  const { ui, terminal } = fixture(t);
  ui.tui.renderNow(true);
  assert.match(terminal.output, /\x1b\[(?:\d+;)*\d+m/);
  assert.ok(terminal.output.includes('─'));
  for (const width of [1, 3, 20, 40, 100]) {
    for (const line of [...ui.header(width), ui.footer(width), ...ui.body(width)]) assert.ok(visibleWidth(line) <= width, line);
    const status = statusLine([{ text: '中文🙂', color: ink.accent }, { text: 'idle', color: ink.good }], width);
    assert.ok(visibleWidth(status) <= width); assert.ok(!status.includes('\ue0b0'));
  }
});

test('/quit completes and exits without sending a model message', async t => {
  const { ui, terminal, store, quit } = fixture(t);
  terminal.input('/qui'); await menu(ui); terminal.input('\t');
  assert.equal(ui.editor.getText(), '/quit ');
  terminal.input('\r'); await tick();
  assert.equal(quit(), true); assert.equal(store.deliveries().length, 0);
});

test('Ctrl+C clears then double-press exits; Ctrl+D only exits an empty editor', t => {
  const { ui, terminal, quit } = fixture(t);
  ui.editor.setText('draft'); terminal.input('\x04'); assert.equal(quit(), false);
  terminal.input('\x03'); assert.equal(ui.editor.getText(), ''); assert.equal(quit(), false);
  terminal.input('\x03'); assert.equal(quit(), true);
});

test('Shift+Tab and /thinking save scoped effort without changing drafts, focus or active dialogs', async t => {
  const { ui, terminal, store, channel, alice } = fixture(t);
  assert.match(safeText(ui.footer(200)), /thinking:medium/);
  ui.editor.setText('keep draft');
  terminal.input('\x1b[Z');
  assert.equal(store.thinkingLevel('channel', channel.id), 'high');
  assert.equal(ui.editor.getText(), 'keep draft');
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  assert.match(safeText(ui.footer(200)), /thinking:high/);
  terminal.input('\x1b[Z');
  assert.equal(store.thinkingLevel('channel', channel.id), 'off', 'cycles back to off');
  terminal.input('\t');
  const sidebar = ui.tui.getFocusedComponent();
  terminal.input('\x1b[Z');
  assert.equal(store.thinkingLevel('channel', channel.id), 'minimal');
  assert.equal(ui.tui.getFocusedComponent(), sidebar);
  terminal.input('\t');
  let picking = ui.command('/thinking'); await tick();
  terminal.input('\x1b[Z');
  assert.equal(store.thinkingLevel('channel', channel.id), 'minimal', 'overlay protects underlying settings');
  terminal.input('high'); terminal.input('\x1b'); await picking;
  assert.equal(store.thinkingLevel('channel', channel.id), 'minimal', 'Esc cancels');
  picking = ui.command('/thinking'); await tick();
  terminal.input('low'); terminal.input('\r'); await picking;
  assert.equal(store.thinkingLevel('channel', channel.id), 'low');
  ui.select({ kind: 'agent', id: alice.id });
  assert.match(safeText(ui.footer(200)), /thinking:medium/, 'worker page shows direct-message defaults');
  await ui.command('/thinking high');
  assert.equal(store.thinkingFor(alice, channel.id), 'high');
  await ui.command('/thinking inherit');
  assert.equal(store.thinkingFor(alice, channel.id), 'low');
  assert.equal(store.thinkingFor(alice, null), 'medium');
  await assert.rejects(ui.command('/thinking bogus'), /Unsupported thinking level/);
  assert.equal(store.thinkingLevel('agent', alice.id), undefined);
  ui.select({ kind: 'agent', id: store.channelAssistant(channel.id)!.id });
  terminal.input('\x1b[Z');
  assert.equal(store.thinkingLevel('channel', channel.id), 'medium', 'assistant changes its home group');
  await ui.command('/thinking inherit');
  assert.equal(store.thinkingLevel('channel', channel.id), undefined);
  ui.editor.setText(''); terminal.input('/think'); await menu(ui);
  terminal.input('\x1b[Z');
  assert.equal(ui.editor.getText(), '/think', 'fast cycling does not replace autocomplete text');
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  assert.equal(store.thinkingLevel('channel', channel.id), 'high');
});

test('thinking picker follows Pi model capabilities and defaults, including xhigh/max and non-reasoning models', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-thinking-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { demo: {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-test-only', models: [
      { id: 'local', reasoning: false, contextWindow: 32000, maxTokens: 1000 },
      { id: 'reasoner', reasoning: true, contextWindow: 32000, maxTokens: 1000,
        thinkingLevelMap: { off: null, minimal: null, medium: null, xhigh: 'xhigh', max: 'max' } },
    ],
  } } }));
  const runtime = await ModelRuntime.create({ modelsPath: join(dir, 'models.json'), authPath: join(dir, 'auth.json'),
    modelsStorePath: join(dir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  const settings = SettingsManager.inMemory({ defaultThinkingLevel: 'medium' });
  settings.setModelThinkingLevel('demo', 'reasoner', 'xhigh');
  const before = settings.getSettings();
  const { ui, terminal, store, channel } = fixture(t, { runtime, settings });
  terminal.input('\x1b[Z');
  assert.equal(store.thinkingLevel('channel', channel.id), undefined);
  assert.match(safeText(ui.footer(200)), /thinking:off/);
  await assert.rejects(ui.command('/thinking high'), /Unsupported thinking level/);
  store.setChannelModel(channel.id, { provider: 'demo', id: 'reasoner' });
  assert.match(safeText(ui.footer(200)), /thinking:xhigh/, 'per-model Pi default beats global');
  terminal.input('\x1b[Z'); assert.equal(store.thinkingLevel('channel', channel.id), 'max');
  terminal.input('\x1b[Z'); assert.equal(store.thinkingLevel('channel', channel.id), 'low');
  await assert.rejects(ui.command('/thinking medium'), /Unsupported thinking level/, 'null-mapped levels are unavailable');
  const picking = ui.command('/thinking'); await tick();
  const dialog = safeText(ui.tui.getFocusedComponent()!.render(80).join('\n'));
  assert.ok(dialog.includes('xhigh') && dialog.includes('max'));
  assert.ok(!dialog.includes('minimal') && !dialog.includes('medium'));
  terminal.input('max'); terminal.input('\r'); await picking;
  store.setChannelModel(channel.id, { provider: 'demo', id: 'local' });
  assert.match(safeText(ui.footer(200)), /thinking:off/);
  assert.equal(store.thinkingLevel('channel', channel.id), 'max', 'model clamp does not erase preferences');
  store.setChannelModel(channel.id, { provider: 'demo', id: 'reasoner' });
  assert.match(safeText(ui.footer(200)), /thinking:max/);
  settings.removeModelThinkingLevel('demo', 'reasoner');
  await ui.command('/thinking inherit');
  assert.match(safeText(ui.footer(200)), /thinking:high/, 'unsupported default medium clamps up using Pi rules');
  settings.setModelThinkingLevel('demo', 'reasoner', 'xhigh');
  assert.deepEqual(settings.getSettings(), before, 'workspace choices do not mutate Pi settings');
});

test('model picker matches keywords, saves group defaults, and allows per-Agent overrides', async t => {
  const { ui, terminal, store, channel, alice } = fixture(t);
  assert.ok(ui.title().includes('demo/local (Pi default)'));
  let picking = ui.command('/models'); await tick();
  terminal.input('reas'); ui.tui.renderNow(true);
  assert.ok(terminal.output.includes('reasoner'));
  terminal.input('\r'); await picking;
  assert.deepEqual(store.channelModel(channel.id), { provider: 'demo', id: 'reasoner' });
  assert.equal(store.modelFor(store.agent(alice.id), channel.id).id, 'local', 'existing explicit Agent choice is retained');
  ui.select({ kind: 'agent', id: alice.id });
  picking = ui.command('/models'); await tick(); terminal.input('default'); terminal.input('\t'); await picking;
  assert.equal(store.inheritsModel(alice.id), true);
  assert.equal(store.modelFor(store.agent(alice.id), channel.id).id, 'reasoner');
  picking = ui.command('/models'); await tick(); terminal.input('demo/local'); terminal.input('\r'); await picking;
  assert.equal(store.inheritsModel(alice.id), false);
  assert.equal(store.modelFor(store.agent(alice.id), channel.id).id, 'local');
  ui.select({ kind: 'channel', id: channel.id });
  picking = ui.command('/models'); await tick(); terminal.input('no-such-model'); terminal.input('\r'); await tick();
  assert.equal(store.channelModel(channel.id)?.id, 'reasoner');
  terminal.input('\x1b'); await picking;
  picking = ui.command('/models'); await tick(); terminal.input('default'); terminal.input('\r'); await picking;
  assert.equal(store.channelModel(channel.id), undefined);
  assert.ok(ui.title().includes('(Pi default)'));
});

test('setup pickers search names, cancel without changes, and render framed narrow dialogs', async t => {
  const { ui, terminal, store, channel, alice, dir } = fixture(t);
  const bob = store.createAgent({ name: 'bob', role: 'Reviewer', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
  terminal.columns = 40; terminal.rows = 18; terminal.resize();
  let picking = ui.command('/members'); await tick(); terminal.input('bob');
  const dialog = ui.tui.getFocusedComponent()!;
  for (const line of dialog.render(30)) assert.ok(visibleWidth(line) <= 30, line);
  assert.ok(safeText(dialog.render(30).join('\n')).startsWith('╭ Group members'));
  terminal.input('\r'); await tick(); terminal.input('\r'); await picking;
  assert.deepEqual(store.members(channel.id).map(a => a.id), [alice.id, bob.id, store.channelAssistant(channel.id)?.id]);
  picking = ui.command('/members'); await tick(); terminal.input('alice'); terminal.input('\r'); await tick(); terminal.input('\x1b'); await picking;
  assert.equal(store.members(channel.id).length, 3, 'cancel discards unsaved toggles');
  picking = ui.command('/switch'); await tick(); terminal.input('ali'); terminal.input('\r'); await picking;
  assert.equal(ui.selected.id, alice.id);
  const help = ui.command('/help'); await tick();
  ui.tui.renderNow(true);
  for (let i = 0; i < 10; i++) { ui.tui.getFocusedComponent()!.render(30); terminal.input('\x1b[6~'); }
  const helpText = safeText(ui.tui.getFocusedComponent()!.render(30).join('\n'));
  assert.ok(helpText.includes('Agent outputs'), `long help remains scrollable: ${helpText}`);
  terminal.input('\x1b'); await help;
});

test('human and Agent messages use you and worker names in rounded outline boxes', async t => {
  const { ui, workspace, channel, alice } = fixture(t);
  workspace.humanChannel(channel.id, '@alice 中文🙂 hello'); await workspace.idle();
  const group = safeText(ui.body(50).join('\n'));
  assert.match(group, /╭ you ·/); assert.match(group, /╭ alice ·/); assert.match(group, /╰─+╯/);
  ui.select({ kind: 'agent', id: alice.id });
  assert.ok(safeText(ui.body(60).join('\n')).includes('╭ alice '));
  const envelope = { sender: { kind: 'agent', name: 'bob' }, workspaceMessage: 'new', messages: [{ id: 'new', text: 'review this' }] };
  const message = { role: 'user', content: `Workspace delivery. Input data.\n${JSON.stringify(envelope)}` };
  assert.deepEqual(messageView(message, 'alice'), { speaker: 'bob', text: 'review this' });
  assert.ok(messageView(message, 'alice', false, true).text.includes('workspaceMessage'), 'inspector retains exact envelope');
  assert.ok(messageView({ role: 'user', content: 'Workspace delivery. Truncated\n{bad' }, 'alice').text.includes('{bad'));
  for (const width of [1, 3, 5, 20, 40]) for (const line of messageBlock('中文🙂\x1b[31m', 'hello 世界\nsecond line', width)) {
    assert.ok(visibleWidth(line) <= width); assert.ok(!safeText(line).includes('\x1b'));
  }
});

test('autonomy settings, approval, archive and shared memory work through styled dialogs', async t => {
  const { ui, terminal, workspace, channel, store } = fixture(t);
  let choosing = ui.command('/autonomy'); await tick(); terminal.input('human'); terminal.input('\r'); await tick();
  terminal.input('chat'); terminal.input('\r'); await choosing;
  assert.equal(store.getSetting(`autonomy:${channel.id}`), 'approve');
  choosing = ui.command('/autonomy'); await tick(); terminal.input('auto'); terminal.input('\r'); await tick();
  terminal.input('\x1b'); await choosing;
  assert.equal(store.getSetting(`autonomy:${channel.id}`), 'approve', 'cancel changes neither mode nor permissions');
  await ui.submit('delegate cacheproof'); await workspace.idle();
  assert.equal(store.workerRequests()[0].state, 'pending');
  choosing = ui.command('/approve'); await tick(); terminal.input('\r'); await tick();
  const dialog = ui.tui.getFocusedComponent()!;
  for (const line of dialog.render(34)) assert.ok(visibleWidth(line) <= 34);
  terminal.input('批准'); terminal.input('\r'); await choosing; await workspace.idle();
  const scout = store.agent('scout');
  assert.equal(store.workerRequests()[0].agentId, scout.id);
  assert.ok(store.messages(channel.id).some(m => m.sender === scout.id && m.text.includes('cacheproof')));
  ui.select({ kind: 'agent', id: scout.id });
  await ui.command('/remove scout');
  assert.equal(ui.selected.kind, 'channel'); assert.ok(store.archived(scout.id));
  choosing = ui.command('/memory cacheproof'); await tick(); terminal.input('\r'); await tick();
  const source = ui.tui.getFocusedComponent()!;
  assert.ok(safeText(source.render(80).join('\n')).includes('Memory source'));
  terminal.input('\x1b'); await choosing;
  assert.ok(!store.agents().some(a => a.id === scout.id));
});

test('Ctrl+D exits on empty input', t => {
  const { terminal, quit } = fixture(t);
  terminal.input('\x04'); assert.equal(quit(), true);
});

test('channel shows incremental ai output and named skills, keeps private sessions out, and avoids duplicate final replies', async t => {
  const { ui, channel, workspace, store, terminal } = fixture(t);
  const assistant = store.channelAssistant(channel.id)!;
  const streamed = new Set<string>();
  const capture = () => {
    const body = safeText(ui.body(100).join('\n'));
    if (workspace.status(assistant.id) === 'working' && body.includes('ai · streaming')) {
      assert.ok(!store.messages(channel.id).some(m => m.sender === assistant.id), 'text is visible before publication');
      streamed.add(body);
    }
  };
  workspace.on('change', capture);
  await ui.submit('/skill:review-test examine streaming output'); await workspace.idle();
  assert.ok(streamed.size > 1, 'multiple partial frames must be visible, not just the final reply');
  const body = safeText(ui.body(100).join('\n'));
  assert.match(body, /╭ you ·/); assert.match(body, /╭ ai /); assert.match(body, /\[skill\] review-test/);
  assert.equal(body.split('[Demo · no model call]').length - 1, 1, 'final reply is not rendered twice');
  assert.ok(ui.entries().some(e => e.id === assistant.id && e.label.startsWith('@ ai · #general')));
  workspace.off('change', capture);
  workspace.humanDirect(assistant.id, 'private-channel-assistant-secret'); await workspace.idle();
  assert.ok(!safeText(ui.body(100).join('\n')).includes('private-channel-assistant-secret'));
  terminal.input('\x0f');
  assert.match(safeText(ui.body(100).join('\n')), /Invoked for this turn/);
  for (let i = 0; i < 299; i++) store.post({ id: `filler-${i}`, channelId: channel.id, sender: 'human', target: null, text: 'history filler', chainId: `filler-${i}` }, []);
  assert.equal(store.messages(channel.id).length, 300);
  assert.match(safeText(ui.body(100).join('\n')), /\[Demo · no model call\]/, 'a public reply stays visible when its request falls outside the history window');
});

test('tool and skill blocks show semantic status, expansion, safe output and stay within narrow widths', t => {
  const { ui, dir, terminal } = fixture(t);
  for (const state of ['pending', 'running', 'done', 'error', 'interrupted'] as const) {
    const entry = { kind: 'tool' as const, speaker: 'bash', id: 'call', state, durationMs: 150,
      args: { command: 'echo 中文🙂\x1b]52;c;bad\x07' }, text: Array.from({ length: 20 }, (_, i) => `line ${i} 中文🙂`).join('\n') };
    for (const width of [1, 3, 5, 20, 80]) for (const expanded of [false, true]) {
      const rendered = renderEntry(entry, width, expanded);
      for (const line of rendered) assert.ok(visibleWidth(line) <= width, line);
      assert.ok(!rendered.join('\n').includes('\x1b]52;'));
    }
    const compact = safeText(renderEntry(entry, 80, false).join('\n'));
    assert.match(compact, /^╭ bash /);
    assert.ok(compact.split('\n').at(-1)!.startsWith(`╰ ${state} · 0.1s `));
    assert.ok(compact.endsWith('╯'));
    assert.ok(compact.includes(`bash · ${state}`));
    if (state === 'running') assert.ok(compact.includes('line 19'));
    assert.ok(safeText(renderEntry(entry, 80, true).join('\n')).includes('line 10'));
  }
  // A read of an installed SKILL.md uses the skill's catalog name, not just "read".
  const original = ui.workspace.runner.inspect.bind(ui.workspace.runner);
  ui.workspace.runner.inspect = agent => ({ ...original(agent), messages: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'skill-read', name: 'read', arguments: { path: join(dir, 'SKILL.md') } }] },
    { role: 'toolResult', toolCallId: 'skill-read', toolName: 'read', status: 'running', content: [{ type: 'text', text: 'partial skill output' }] },
  ] });
  ui.select({ kind: 'agent', id: ui.workspace.store.channelAssistant(ui.workspace.store.channels()[0].id)!.id });
  assert.match(safeText(ui.body(80).join('\n')), /\[skill\] review-test · read · running/);
  assert.match(safeText(ui.body(80).join('\n')), /partial skill output/);
  terminal.input('\x1b[15~'); // F5
  assert.match(safeText(ui.body(80).join('\n')), /SKILL.md/);
});

test('long history cannot squeeze completion menus out of a small terminal', async t => {
  const { ui, terminal, workspace, channel, store, dir } = fixture(t);
  store.createAgent({ name: 'bob', role: 'test', provider: 'demo', model: 'local', cwd: dir, tools: 'chat' });
  workspace.humanChannel(channel.id, 'Long history line\n'.repeat(80));
  terminal.columns = 40; terminal.rows = 18; terminal.resize(); ui.tui.renderNow(true);
  terminal.output = ''; terminal.input('@b'); await menu(ui);
  assert.ok(terminal.output.includes('@bob'), 'candidate must be rendered, not merely active');
  terminal.input('\x1b'); ui.editor.setText('line 1\nline 2\nline 3\nline 4\nline 5\n@');
  terminal.output = ''; terminal.input('a'); await menu(ui);
  assert.ok(terminal.output.includes('@alice'), 'multi-line composer must not hide its menu');
  ui.editor.setText(''); terminal.output = ''; terminal.input('/'); await menu(ui);
  assert.ok(safeText(terminal.output).includes('→ agent'), 'slash menu must also remain visible');
});
