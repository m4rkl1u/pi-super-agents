import { replaceControlCharacters, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export function safeText(value: string): string {
  return stripTerminalSequences(value).split('\n').map(replaceControlCharacters).join('\n').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}
export function lines(text: string, width: number): string[] {
  if (width < 1) return [''];
  return wrapTextWithAnsi(safeText(text), width).map(line => truncateToWidth(line, width));
}
/** Bound layout work before wrapping; sanitize first so clipping cannot split terminal escapes. */
export function previewLines(text: string, width: number, count: number, tail = false): { lines: string[]; truncated: boolean } {
  const logical = safeText(text).split('\n');
  const selected = tail ? logical.slice(-count) : logical.slice(0, count);
  let truncated = logical.length > count;
  const columns = Math.max(1, width) * (count + 1);
  const excerpt = selected.map(line => {
    const clipped = tail ? sliceByColumn(line, Math.max(0, visibleWidth(line) - columns), columns)
      : truncateToWidth(line, columns, '');
    truncated ||= clipped.length < line.length;
    return clipped;
  }).join('\n');
  const wrapped = lines(excerpt, width);
  return { lines: tail ? wrapped.slice(-count) : wrapped.slice(0, count), truncated: truncated || wrapped.length > count };
}
export function messageView(value: unknown, agentName: string, expandTools = false, inspect = false): { speaker: string; text: string } {
  const rendered = messageText(value, expandTools);
  const split = rendered.indexOf('\n');
  const message = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  let speaker = message.role === 'assistant' ? agentName : message.role === 'user' ? 'you' : rendered.slice(0, split);
  let text = rendered.slice(split + 1);
  if (message.role === 'user') {
    if (typeof message.senderName === 'string') speaker = message.senderName === 'You' ? 'you' : message.senderName;
    if (text.startsWith('Workspace delivery. ')) {
      try {
        const envelope: unknown = JSON.parse(text.split('\n')[1] ?? '');
        if (envelope && typeof envelope === 'object' && 'sender' in envelope && 'messages' in envelope && 'workspaceMessage' in envelope) {
          const sender = envelope.sender;
          if (sender && typeof sender === 'object' && 'kind' in sender && 'name' in sender && typeof sender.name === 'string') {
            speaker = sender.kind === 'human' ? 'you' : sender.name;
            const current: unknown = Array.isArray(envelope.messages) ? envelope.messages.find(m => m?.id === envelope.workspaceMessage) : undefined;
            if (!inspect && current && typeof current === 'object' && 'text' in current && typeof current.text === 'string') text = current.text;
          }
        }
      } catch { /* Plain or truncated input remains visible, never silently discarded. */ }
    }
  }
  return { speaker, text };
}
export function messageText(value: unknown, expandTools = false): string {
  if (!value || typeof value !== 'object') return '';
  const message = value as Record<string, unknown>;
  const role = String(message.role ?? 'event');
  const content = message.content;
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  if (Array.isArray(content)) for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'thinking') parts.push('[Thinking content omitted]');
    else if (block.type === 'toolCall') parts.push(`→ ${block.name} ${expandTools ? JSON.stringify(block.arguments) : '(F5: details)'}`);
    else if (block.type === 'image') parts.push('[Image]');
  }
  if (typeof message.summary === 'string') parts.push(message.summary);
  if (typeof message.output === 'string') parts.push(message.output);
  if (typeof message.errorMessage === 'string') parts.push(`ERROR: ${message.errorMessage}`);
  let body = parts.join('\n');
  const limit = role === 'toolResult' && !expandTools ? 240 : 32_000;
  if (body.length > limit) body = role === 'toolResult' && message.status === 'running'
    ? '[… earlier output omitted]\n' + body.slice(-limit)
    : body.slice(0, limit) + '\n[… truncated; F5 expands tool results]';
  return `${role}${message.toolName ? ` · ${message.toolName}` : ''}${message.isError ? ' · ERROR' : ''}\n${body}`;
}

export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'skill' | 'event';
  speaker: string;
  text: string;
  id?: string;
  args?: unknown;
  state?: 'pending' | 'running' | 'done' | 'error' | 'interrupted';
  durationMs?: number;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Only an explicit delivery boundary can associate session output with a channel post. */
export function channelTurns(messages: unknown[], channel: string): Map<string, unknown[]> {
  const turns = new Map<string, unknown[]>();
  let current: unknown[] | undefined;
  for (const value of messages) {
    const message = record(value);
    if (message.role === 'user') {
      current = undefined; // Plain user messages include private steering: never inherit a public scope.
      let delivery = message;
      const text = typeof message.content === 'string' ? message.content : messageText(message).split('\n').slice(1).join('\n');
      if (text.startsWith('Workspace delivery. ')) {
        try { delivery = record(JSON.parse(text.split('\n')[1] ?? '')); } catch { continue; }
      }
      if (delivery.channel === channel && typeof delivery.workspaceMessage === 'string') {
        current = [message]; turns.set(delivery.workspaceMessage, current);
      }
    } else if (message.role === 'assistant' || message.role === 'toolResult') current?.push(message);
  }
  return turns;
}

/** Join calls and results by ID so snapshots replace a tool row instead of duplicating it. */
export function transcriptEntries(messages: unknown[], agentName: string, expandTools = false, inspect = false): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, TranscriptEntry>();
  for (const value of messages) {
    const message = record(value);
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
      const view = messageView({ ...message, content: Array.isArray(message.content) ? blocks.filter(b => b.type !== 'toolCall') : message.content }, agentName, expandTools, inspect);
      const state = message.stopReason === 'pending' ? 'running' : message.stopReason === 'aborted' ? 'interrupted' : message.stopReason === 'error' ? 'error' : undefined;
      if (view.text.trim() || state) entries.push({ kind: 'assistant', ...view, state });
      for (const block of blocks) if (block.type === 'toolCall' && typeof block.id === 'string') {
        const entry: TranscriptEntry = { kind: 'tool', speaker: String(block.name ?? 'tool'), id: block.id, args: block.arguments, text: '', state: state === 'interrupted' || state === 'error' ? state : 'pending' };
        tools.set(block.id, entry); entries.push(entry);
      }
    } else if (message.role === 'toolResult') {
      const id = String(message.toolCallId ?? '');
      let entry = tools.get(id);
      if (!entry) {
        entry = { kind: 'tool', speaker: String(message.toolName ?? 'tool'), id, args: message.args, text: '' };
        tools.set(id, entry); entries.push(entry);
      }
      entry.text = messageView(message, agentName, true).text;
      entry.state = message.status === 'running' ? 'running' : message.status === 'interrupted' ? 'interrupted' : message.isError ? 'error' : 'done';
      if (typeof message.durationMs === 'number') entry.durationMs = message.durationMs;
    } else {
      const view = messageView(value, agentName, expandTools, inspect);
      entries.push({ kind: message.role === 'user' ? (view.speaker === 'you' ? 'user' : 'assistant') : 'event', ...view });
      const raw = messageText(message, true);
      const skill = message.role === 'user' ? raw.match(/\n<skill name="([^"]+)" location="[^"]*">\n([\s\S]*?)\n<\/skill>/) : null;
      const invoked = view.speaker === 'you' ? view.text.match(/^\/skill:([^\s]+)/) : null;
      const skillName = skill?.[1] ?? invoked?.[1];
      if (!inspect && skillName) entries.push({ kind: 'skill', speaker: skillName, text: skill?.[2] ?? 'Invoked for this turn. AI and tool output appears below.' });
    }
  }
  return entries;
}
