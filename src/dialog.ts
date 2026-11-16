import { Input, SelectList, fuzzyFilter, matchesKey, type Component, type Focusable, type SelectItem, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { ink, pad, rule } from './appearance.js';
import { lines, safeText } from './render.js';

/** Native Pi input and selection, framed for both free-text setup and searchable choices. */
export class SetupDialog implements Component, Focusable {
  readonly capturesViewportInput = true;
  private input: Input;
  private list?: SelectList;
  private listRow = 0;
  private inputRow = 0;
  private maxVisible = 0;
  private detailOffset = 0;
  private detailLength = 0;
  private detailHeight = 1;
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(private label: string, initial: string, private items: SelectItem[] | undefined,
    private rows: () => number, private done: (value?: string) => void, private redraw: () => void) {
    this.items = items?.map(item => ({ ...item, label: safeText(item.label), description: item.description ? safeText(item.description) : undefined }));
    this.input = new Input({ prompt: items ? '⌕ ' : '> ', placeholder: items ? 'Type keywords to filter…' : undefined, placeholderStyle: ink.dim });
    if (!items) this.input.setValue(initial);
    this.input.onSubmit = value => this.done(value);
    this.input.onEscape = () => this.done();
    this.rebuild(initial);
  }
  private rebuild(selected?: string): void {
    if (!this.items) return;
    this.maxVisible = Math.max(1, Math.min(8, this.rows() - 10));
    const filtered = fuzzyFilter(this.items, this.input.getValue(), item => `${item.value} ${item.label} ${item.description ?? ''}`);
    this.list = new SelectList(filtered, this.maxVisible, getSelectListTheme());
    this.list.setSelectedIndex(Math.max(0, filtered.findIndex(item => item.value === selected)));
    this.list.onSelect = item => this.done(item.value);
    this.list.onCancel = () => this.done();
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.done(); return; }
    if (!this.list && (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown'))) {
      this.detailOffset += matchesKey(data, 'pageDown') ? this.detailHeight : -this.detailHeight;
    } else if (this.list && (['up', 'down', 'pageUp', 'pageDown', 'enter'] as const).some(key => matchesKey(data, key))) this.list.handleInput(data);
    else if (this.list && matchesKey(data, 'tab')) {
      const selected = this.list.getSelectedItem(); if (selected) this.done(selected.value);
    } else {
      const previous = this.input.getValue(); this.input.handleInput(data);
      if (this.input.getValue() !== previous) this.rebuild();
    }
    this.redraw();
  }
  render(width: number): string[] {
    if (this.items && this.maxVisible !== Math.max(1, Math.min(8, this.rows() - 10))) this.rebuild(this.list?.getSelectedItem()?.value);
    const inner = Math.max(1, width - 4);
    const [title, ...description] = this.label.split('\n');
    if (width < 5) return lines(title, width);
    const allDetails = description.length ? lines(description.join('\n'), inner) : [];
    this.detailLength = allDetails.length;
    this.detailHeight = Math.max(1, this.rows() - 9);
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, this.detailLength - this.detailHeight));
    const detail = allDetails.slice(this.detailOffset, this.detailOffset + this.detailHeight).map(ink.muted);
    const content = [...detail, ...(detail.length ? [''] : [])];
    this.inputRow = content.length + 1;
    content.push(...this.input.render(inner), '');
    this.listRow = content.length + 1;
    if (this.list) content.push(...this.list.render(inner), '');
    content.push(ink.dim(this.list ? '↑/↓ choose · Enter/Tab accept · Esc cancel' : `${this.detailLength > this.detailHeight ? 'PgUp/PgDn scroll · ' : ''}Enter accepts · Esc cancels`));
    return [rule(title, width, false, true), ...content.map(line => ink.dim('│') + ' ' + pad(line, Math.max(0, width - 4)) + ' ' + ink.dim('│')), rule('', width, true, true)];
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.list && event.type === 'wheel') { this.detailOffset += event.wheelDelta ?? 0; return { handled: true, render: true }; }
    if (event.y === this.inputRow) return this.input.handleMouse({ ...event, x: Math.max(0, event.x - 2), y: 0 });
    if (this.list && event.y >= this.listRow) return this.list.handleMouse({ ...event, x: Math.max(0, event.x - 2), y: event.y - this.listRow });
    return undefined;
  }
  invalidate(): void { this.input.invalidate(); this.list?.invalidate(); }
}
