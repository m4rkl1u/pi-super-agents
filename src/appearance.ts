import { getMarkdownTheme, getSelectListTheme, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { Editor, Markdown, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { safeText, lines, previewLines, type TranscriptEntry } from './render.js';

// Public Pi callbacks keep the active theme's semantic colors.
export const ink = {
  accent: (text: string) => getSelectListTheme().selectedText(text),
  muted: (text: string) => getSelectListTheme().description(text),
  dim: (text: string) => getSettingsListTheme().hint(text),
  code: (text: string) => getMarkdownTheme().code(text),
  heading: (text: string) => getMarkdownTheme().heading(text),
  good: (text: string) => `\x1b[32m${text}\x1b[39m`,
  warning: (text: string) => `\x1b[33m${text}\x1b[39m`,
  error: (text: string) => `\x1b[31m${text}\x1b[39m`,
};
export function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}
export function rule(label: string, width: number, bottom = false, framed = false, color = ink.dim): string {
  if (width < 2) return color('─'.repeat(Math.max(0, width)));
  const title = truncateToWidth(label ? ` ${safeText(label).replace(/\n/g, ' ')} ` : '', width - 2);
  return color(`${framed ? bottom ? '╰' : '╭' : '─'}${title}${'─'.repeat(Math.max(0, width - 2 - visibleWidth(title)))}${framed ? bottom ? '╯' : '╮' : '─'}`);
}
function frame(title: string, content: string[], width: number, color: (text: string) => string, footer = '', footerColor = color): string[] {
  if (width < 5) return [...lines(title, width), ...content.map(line => truncateToWidth(line, width)), ...lines(footer, width)];
  return [rule(title, width, false, true, color),
    ...content.map(line => `${color('│')} ${pad(line, width - 4)} ${color('│')}`),
    rule(footer, width, true, true, footerColor)];
}
export function messageBlock(speaker: string, text: string, width: number, human = false, color = ink.accent): string[] {
  const inner = width < 5 ? Math.max(1, width) : width - 4;
  return frame(speaker, new Markdown(safeText(text), 0, 0, getMarkdownTheme()).render(inner), width, human ? ink.muted : color);
}
export function renderEntry(entry: TranscriptEntry, width: number, expanded: boolean, color = ink.accent): string[] {
  const inner = width < 5 ? Math.max(1, width) : width - 4;
  if (entry.kind === 'skill') {
    const content = new Markdown(safeText(entry.text), 0, 0, getMarkdownTheme()).render(inner);
    return frame(`[skill] ${entry.speaker}`, expanded ? content : content.slice(0, 6), width, color,
      !expanded && content.length > 6 ? '… F5 / Ctrl+O: expand' : '');
  }
  if (entry.kind !== 'tool') return messageBlock(`${entry.speaker}${entry.state ? ` · ${entry.state === 'running' ? 'streaming' : entry.state}` : ''}`, entry.text, width, entry.kind === 'user', color);
  const state = entry.state ?? 'pending';
  const argsText = entry.args === undefined ? '' : JSON.stringify(entry.args, null, expanded ? 2 : 0);
  const args = entry.args === undefined ? { lines: [], truncated: false } : expanded
    ? { lines: lines(argsText, inner), truncated: false } : previewLines(argsText, inner, 2);
  const output = expanded ? { lines: lines(entry.text, inner), truncated: false } : previewLines(entry.text, inner, 6, state === 'running');
  const content = [...args.lines.map(ink.muted), ...output.lines,
    ...(output.truncated || args.truncated ? [ink.dim(truncateToWidth('… F5 / Ctrl+O: expand', inner))] : [])];
  const statusColor = state === 'error' || state === 'interrupted' ? ink.error : state === 'done' ? ink.good : ink.muted;
  return frame(`${entry.speaker} · ${state}`, content, width, color,
    `${state}${entry.durationMs === undefined ? '' : ` · ${(entry.durationMs / 1000).toFixed(1)}s`}`, statusColor);
}
export function statusLine(segments: { text: string; color: (text: string) => string }[], width: number): string {
  return truncateToWidth(segments.map(({ text, color }) => color(safeText(text))).join(ink.dim(' · ')), width);
}
export class WorkspaceEditor extends Editor {
  protected override renderTopBorder(width: number, hidden: number): string {
    return rule(hidden ? `↑ ${hidden} more` : '', width);
  }
  protected override renderBottomBorder(width: number, hidden: number): string {
    return rule(hidden ? `↓ ${hidden} more` : '', width, true);
  }
}
