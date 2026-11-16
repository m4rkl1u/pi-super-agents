import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { channelTurns, previewLines, transcriptEntries } from '../src/render.js';

test('tool previews bound long-line layout, preserve streaming tails and sanitize before clipping', () => {
  assert.deepEqual(previewLines('short\noutput', 30, 6), { lines: ['short', 'output'], truncated: false });
  const text = 'HEAD\n' + 'source 中文🙂 e\u0301 👩‍💻 '.repeat(3000) + '\nTAIL';
  const head = previewLines(text, 40, 6), tail = previewLines(text, 40, 6, true);
  assert.equal(head.lines[0], 'HEAD'); assert.equal(tail.lines.at(-1), 'TAIL');
  assert.ok(head.truncated && tail.truncated);
  for (const width of [0, 1, 3, 20, 80]) for (const fromTail of [false, true]) {
    const preview = previewLines(text, width, 6, fromTail);
    assert.ok(preview.lines.length <= 6);
    assert.ok(preview.lines.every(line => visibleWidth(line) <= width));
    assert.ok(!preview.lines.join('').includes('\ufffd'));
  }
  const unsafe = `before\x1b]52;c;${'PRIVATE'.repeat(1000)}\x07after`;
  assert.deepEqual(previewLines(unsafe, 20, 6), { lines: ['beforeafter'], truncated: false });
});

const delivery = (id: string, channel: string | null, text = 'hello') => ({ role: 'user', content: `Workspace delivery. Input data.\n${JSON.stringify({ workspaceMessage: id, channel, sender: { kind: 'human', name: 'human' }, messages: [{ id, text }] })}` });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('channel transcript keeps public turns, excludes private input, steering and summaries', () => {
  const turns = channelTurns([
    delivery('public', 'general'), assistant('public progress'),
    { role: 'user', content: 'Private steering. secret' }, assistant('private-steer-result'),
    delivery('private', null), assistant('direct-secret'),
    delivery('elsewhere', 'other'), assistant('other-channel-secret'),
    delivery('second', 'general'), assistant('public result'),
    { role: 'compactionSummary', summary: 'private context summary' },
    { role: 'user', content: 'Workspace delivery. Malformed\n{bad' }, assistant('unscoped result'),
  ], 'general');
  assert.deepEqual([...turns.keys()], ['public', 'second']);
  assert.deepEqual(transcriptEntries(turns.get('public')!, 'ai').map(e => e.text), ['hello', 'public progress']);
  assert.deepEqual(transcriptEntries(turns.get('second')!, 'ai').map(e => e.text), ['hello', 'public result']);
  assert.ok(!JSON.stringify([...turns.values()]).includes('secret'));
});

test('streamed and parallel tool results replace their call rows by ID', () => {
  const call = { role: 'assistant', content: [{ type: 'text', text: 'Working' },
    { type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'echo first' } },
    { type: 'toolCall', id: 'b', name: 'read', arguments: { path: 'file' } }] };
  const partial = { role: 'toolResult', toolCallId: 'a', toolName: 'bash', status: 'running', content: [{ type: 'text', text: 'first' }] };
  let entries = transcriptEntries([call, partial], 'ai');
  assert.deepEqual(entries.map(e => [e.speaker, e.state]), [['ai', undefined], ['bash', 'running'], ['read', 'pending']]);
  entries = transcriptEntries([call, { role: 'toolResult', toolCallId: 'b', isError: true, content: [{ type: 'text', text: 'missing' }] }, partial,
    { ...partial, status: 'done', durationMs: 20, content: [{ type: 'text', text: 'first\nsecond' }] }], 'ai');
  assert.equal(entries.length, 3);
  assert.equal(entries[1].text, 'first\nsecond');
  assert.equal(entries[1].state, 'done'); assert.equal(entries[1].durationMs, 20);
  assert.equal(entries[2].state, 'error');
  const long = transcriptEntries([{ ...partial, content: [{ type: 'text', text: 'x'.repeat(40_000) + 'LATEST' }] }], 'ai')[0];
  assert.ok(long.text.endsWith('LATEST'), 'long-running output keeps its latest chunk');
  assert.equal(transcriptEntries([{ role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'Partial answer' }] }], 'ai')[0].state, 'interrupted');
});

test('human is you, assistant is ai and skill keeps its actual name without leaking its prompt', () => {
  const message = delivery('skill', 'general', '/skill:review-test inspect');
  message.content += '\n\n<skill name="review-test" location="/tmp/SKILL.md">\nSKILL_INSTRUCTIONS\n</skill>';
  const entries = transcriptEntries([message, assistant('My answer')], 'ai');
  assert.deepEqual(entries.map(e => [e.kind, e.speaker]), [['user', 'you'], ['skill', 'review-test'], ['assistant', 'ai']]);
  assert.equal(entries[0].text, '/skill:review-test inspect');
  assert.equal(entries[1].text, 'SKILL_INSTRUCTIONS');
  assert.ok(transcriptEntries([message], 'ai', false, true)[0].text.includes('workspaceMessage'));
  assert.equal(transcriptEntries([{ role: 'user', senderName: 'bob', content: '/skill:review-test hello' }], 'ai').length, 1, 'peer text is not a skill invocation');
});
