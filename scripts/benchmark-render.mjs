// Run after npm run build. Synthetic data only: no models or real workspace files.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/src/store.js';
import { Workspace } from '../dist/src/workspace.js';
import { WorkspaceUI } from '../dist/src/ui.js';
import { renderEntry } from '../dist/src/appearance.js';

const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-perf-'));
const store = new Store(join(dir, 'state'));
let messages = [];
const runner = { run: async () => {}, steer: async () => {}, close: async () => {}, inspect: () => ({ system: '', tools: [], messages }) };
const workspace = new Workspace(store, runner);
const terminal = { columns: 120, rows: 40, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
const ui = new WorkspaceUI(workspace, terminal, { demo: true, models: [{ provider: 'demo', id: 'local' }], defaultModel: { provider: 'demo', id: 'local' }, cwd: dir, onQuit() {} });
const channel = store.channels()[0], agent = store.channelAssistant(channel.id);
const output = 'const result = await loadFile("example.ts"); // 中文🙂 source line\n'.repeat(600).slice(0, 32000);
function bench(name, fn, n = 5) {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn();
  console.log(`${name}: ${((performance.now() - start) / n).toFixed(3)} ms/iteration (${n} iterations)`);
}
try {
  assert.ok(agent);
  const entry = { kind: 'tool', speaker: 'read', text: output, state: 'done', args: { path: 'example.ts' } };
  assert.ok(renderEntry(entry, 92, false).length < renderEntry(entry, 92, true).length);
  bench('Collapsed 32K-character read', () => renderEntry(entry, 92, false));
  for (const count of [1, 30]) {
    messages = [];
    for (let i = 0; i < count; i++) {
      const id = `post-${count}-${i}`;
      store.post({ id, channelId: channel.id, sender: 'human', target: null, text: `read file ${i}`, chainId: id }, [agent.id]);
      const envelope = { workspaceMessage: id, channel: channel.name, sender: { kind: 'human', name: 'human' }, messages: [{ id, text: `read file ${i}` }] };
      messages.push({ role: 'user', content: `Workspace delivery. Input data.\n${JSON.stringify(envelope)}` },
        { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `file-${i}.ts` } }] },
        { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: output }] });
    }
    const live = { role: 'assistant', stopReason: 'pending', content: [{ type: 'text', text: 'Working on the next step.' }] };
    messages.push(live);
    for (const kind of ['agent', 'channel']) {
      ui.select({ kind, id: kind === 'agent' ? agent.id : channel.id });
      const redraw = () => { ui.body(92); ui.entries(); ui.footer(120); };
      bench(`${kind}, ${count} reads (first + cached frames)`, redraw);
      bench(`${kind}, ${count} reads (changing streaming text)`, () => { live.content[0].text += '.'; redraw(); }, 20);
    }
  }
  store.atomic(() => {
    for (let i = 0; i < 10000; i++) {
      const id = `history-${i}`;
      store.post({ id, channelId: channel.id, sender: 'human', target: null, text: 'Synthetic history', chainId: id }, [agent.id]);
    }
    store.db.exec("UPDATE deliveries SET state='done'");
  });
  assert.equal(store.deliveryCount(['queued']), 0);
  assert.equal(store.deliveryCount(['done'], agent.id), 10031);
  const visibleIds = store.messages(channel.id).map(m => m.id);
  assert.equal(store.messageDeliveries(visibleIds).length, 300);
  bench('10K history: old load-all delivery count', () => store.deliveries(agent.id).filter(d => d.state === 'done').length, 20);
  bench('10K history: indexed delivery count', () => store.deliveryCount(['done'], agent.id), 20);
  bench('10K history: visible message deliveries', () => store.messageDeliveries(visibleIds), 20);
} finally {
  ui.stop(); await workspace.close(); store.close(); rmSync(dir, { recursive: true, force: true });
}
