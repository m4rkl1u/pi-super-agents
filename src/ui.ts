import {
  Editor, HStack, ScrollView, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, type SelectItem,
  type Component, type Focusable, type Terminal, type TuiMouseEvent, type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { getSelectListTheme, initTheme, type ModelRuntime, type SettingsManager, type Skill } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { resolve } from 'node:path';
import { Workspace } from './workspace.js';
import { ink, pad, statusLine, rule, messageBlock, renderEntry, WorkspaceEditor } from './appearance.js';
import { SetupDialog } from './dialog.js';
import { ExtensionUI } from './extension-ui.js';
import { workspaceCompletion } from './completion.js';
import { invokedSkill } from './skills.js';
import { validName, THINKING_LEVELS, type ThinkingLevel, type Agent, type ToolProfile, type ModelChoice } from './store.js';
import { agentInk } from './agent-colors.js';
import { channelTurns, lines, safeText, transcriptEntries, type TranscriptEntry } from './render.js';

type CacheBlock = (key: unknown[], draw: () => string[]) => string[];
interface Selection { kind: 'channel' | 'agent'; id: string }
export type { ModelChoice } from './store.js';
interface UIOptions { demo: boolean; models: ModelChoice[]; defaultModel?: ModelChoice; runtime?: ModelRuntime; settings?: SettingsManager; skills?: Skill[]; theme?: string; cwd: string; onQuit(): void }
class Dynamic implements Component {
  constructor(private draw: (width: number) => string[], private clear = () => {}) {}
  render(width: number): string[] { return this.draw(width); }
  invalidate(): void { this.clear(); }
}
class Sidebar implements Component, Focusable {
  focused = false;
  index = 0;
  private rows = new Map<number, number>();
  constructor(private ui: WorkspaceUI) {}
  invalidate(): void {}
  render(width: number): string[] {
    this.rows.clear();
    const result = [ink.heading(' π WORKSPACE'), ''];
    const entries = this.ui.entries();
    for (const [kind, heading] of [['channel', 'CHANNELS'], ['agent', 'AGENTS'], ['create', '']] as const) {
      if (heading) result.push(ink.dim(` ${heading}`));
      entries.forEach((entry, index) => {
        if (entry.kind !== kind) return;
        this.rows.set(result.length, index);
        const selected = this.ui.selected.id === entry.id;
        const text = pad(`${selected ? '→' : ' '} ${entry.label}${this.focused && index === this.index ? ' ◂' : ''}`, width);
        const color = /failed|interrupted/.test(entry.label) ? ink.error : entry.kind === 'agent' ? this.ui.speakerInk(entry.id) : selected ? ink.accent : ink.muted;
        result.push(color(text));
      });
      result.push('');
    }
    return result.map(line => truncateToWidth(line, width));
  }
  handleInput(data: string): void {
    const entries = this.ui.entries();
    if (matchesKey(data, 'up')) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, 'down')) this.index = Math.min(entries.length - 1, this.index + 1);
    else if (matchesKey(data, 'enter')) this.choose(this.index);
    this.ui.tui.requestRender();
  }
  private choose(index: number): void {
    const entry = this.ui.entries()[index];
    if (!entry) return;
    this.index = index;
    if (entry.kind === 'create') void this.ui.createAgent();
    else this.ui.select({ kind: entry.kind, id: entry.id });
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return;
    const index = this.rows.get(event.y);
    if (index !== undefined) this.choose(index);
    return { handled: true, render: true };
  }
}

export class WorkspaceUI {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  selected: Selection;
  private sidebar: Sidebar;
  private extensionUI: ExtensionUI;
  private transcript: ScrollView;
  private renderedBlocks = new Map<string, string[]>();
  private drafts = new Map<string, string>();
  private inspectContext = false;
  private expandTools = false;
  private notice = 'Type / for commands & skills · @ to mention an Agent · F2 create Agent';
  private dialog = false;
  private closed = false;
  private quitting = false;
  private lastCtrlC = 0;
  private readonly refresh = () => { this.markSeen(); this.tui.requestRender(); };
  private readonly showNotice = (text: string) => { this.notice = safeText(text); this.tui.requestRender(); };

  constructor(readonly workspace: Workspace, terminal: Terminal, private options: UIOptions) {
    this.tui = new TuiAltScreen(terminal, true, undefined, { mouse: true, copyOnSelect: false });
    for (const channel of workspace.store.channels()) {
      const model = this.groupModel(channel.id);
      if (model) workspace.store.ensureChannelAssistant(channel.id, options.cwd, model);
    }
    this.selected = { kind: 'channel', id: workspace.store.channels()[0].id };
    initTheme(options.theme, false);
    this.editor = new WorkspaceEditor(this.tui, { borderColor: ink.accent, selectList: getSelectListTheme() }, { paddingX: 1, autocompleteMaxVisible: 5 });
    this.extensionUI = new ExtensionUI({ tui: this.tui, editor: this.editor,
      active: () => this.activeAgent()?.id,
      busy: value => { if (value !== undefined) this.dialog = value; return this.dialog; },
      notify: this.showNotice,
      tools: value => { if (value !== undefined) { this.expandTools = value; this.refresh(); } return this.expandTools; },
    });
    workspace.runner.bindUI?.((agent, base) => this.extensionUI.context(agent.id, base), this.refresh);
    this.editor.setAutocompleteProvider(workspaceCompletion(options.cwd, workspace.runner.commands ? [] : options.skills ?? [], () => {
      const members = this.selected.kind === 'channel' ? new Set(workspace.store.members(this.selected.id).map(a => a.id)) : undefined;
      return workspace.store.agents().map(a => ({ name: a.name,
        description: `${workspace.status(a.id)} · ${a.provider}/${a.model}${members && !members.has(a.id) ? ' · not in this group' : ''}` }));
    }, async () => {
      const agent = this.activeAgent();
      if (!agent) return [];
      try { return await workspace.runner.commands?.(agent) ?? []; }
      catch (error) { if (this.activeAgent()?.id === agent.id) this.showNotice(String(error)); return []; }
    }));
    this.editor.onSubmit = text => { void this.submit(text); };
    this.sidebar = new Sidebar(this);
    this.transcript = new ScrollView(new Dynamic(width => this.body(width), () => this.renderedBlocks.clear()), { follow: 'end', primary: true });
    const right = new VStack([
      { component: new Dynamic(width => this.header(width)), basis: 3, shrink: 1, minSize: 0 },
      // History takes only the remaining space; it must never squeeze the completion menu.
      { component: this.transcript, basis: 0, grow: 1, minSize: 1 },
      { component: new Dynamic(width => this.extensionUI.render('aboveEditor', width)), basis: 'auto', shrink: 1, minSize: 0 },
      { component: this.editor, basis: 'auto', shrink: 0, minSize: 3 },
      { component: new Dynamic(width => this.extensionUI.render('belowEditor', width)), basis: 'auto', shrink: 1, minSize: 0 },
    ]);
    const body = new HStack([
      { component: new ScrollView(this.sidebar), basis: 27, minSize: 20, shrink: 0, visible: viewport => viewport.width >= 60 },
      { component: right, grow: 1, minSize: 0 },
    ], { gap: 1 });
    this.tui.setLayoutRoot(new VStack([
      { component: body, grow: 1, minSize: 3 },
      { component: new Dynamic(width => [(this.notice.startsWith('Error:') ? ink.error : ink.muted)(truncateToWidth(this.notice, width))]), basis: 1, shrink: 0 },
      { component: new Dynamic(width => [this.footer(width)]), basis: 1, shrink: 0 },
      { component: new Dynamic(width => [ink.dim(truncateToWidth('/ commands · Shift+Tab thinking · Tab complete/nav · Ctrl+←/→ switch · F2 agent · F3 group · Alt+Enter steer · /quit exit', width))]), basis: 1, shrink: 0 },
    ]));
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (this.quitting) return { consume: true };
      if (matchesKey(data, 'ctrl+q')) { this.requestQuit(); return { consume: true }; }
      if (this.dialog) return;
      if (matchesKey(data, 'ctrl+c')) {
        const now = Date.now();
        this.editor.setText('');
        if (now - this.lastCtrlC < 500) this.requestQuit();
        else this.showNotice('Press Ctrl+C again to exit');
        this.lastCtrlC = now;
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+d') && !this.editor.getText()) { this.requestQuit(); return { consume: true }; }
      if (matchesKey(data, 'shift+tab')) { void this.command('/thinking cycle').catch(() => {}); return { consume: true }; }
      if (matchesKey(data, 'tab')) {
        if (this.tui.getFocusedComponent() === this.editor && this.editor.capturesViewportInput) return;
        this.tui.setFocus(this.tui.getFocusedComponent() === this.sidebar ? this.editor : this.sidebar); return { consume: true };
      }
      if (matchesKey(data, 'ctrl+left') || matchesKey(data, 'ctrl+right')) {
        const entries = this.entries().filter(e => e.kind !== 'create');
        const i = entries.findIndex(e => e.id === this.selected.id);
        const next = entries[(i + (matchesKey(data, 'ctrl+right') ? 1 : entries.length - 1)) % entries.length];
        if (next.kind !== 'create') this.select({ kind: next.kind, id: next.id });
        return { consume: true };
      }
      if (matchesKey(data, 'f2')) { void this.createAgent(); return { consume: true }; }
      if (matchesKey(data, 'f3')) { void this.createChannel(); return { consume: true }; }
      if (matchesKey(data, 'f4')) { this.inspectContext = !this.inspectContext; this.refresh(); return { consume: true }; }
      if (matchesKey(data, 'f5') || matchesKey(data, 'ctrl+o')) { this.expandTools = !this.expandTools; this.refresh(); return { consume: true }; }
      if (matchesKey(data, 'ctrl+s')) { void this.command('/stop').catch(() => {}); return { consume: true }; }
      if (matchesKey(data, 'alt+enter')) { void this.sendSteer(); return { consume: true }; }
      const agent = this.activeAgent();
      if (agent && workspace.runner.shortcut?.(agent, data)) return { consume: true };
      return this.extensionUI.input(data);
    });
    workspace.on('change', this.refresh); workspace.on('notice', this.showNotice);
  }
  entries(): ({ kind: 'channel' | 'agent' | 'create'; id: string; label: string })[] {
    const store = this.workspace.store;
    return [
      ...store.channels().map(c => {
        const seen = Number(store.getSetting(`seen:${c.id}`) ?? 0);
        const unread = store.unreadCount(c.id, seen);
        return { kind: 'channel' as const, id: c.id, label: `# ${c.name}${unread ? ` (${unread})` : ''}` };
      }),
      ...store.agents().map(a => {
        const finished = store.deliveryCount(['done', 'failed', 'interrupted'], a.id);
        const unread = Math.max(0, finished - Number(store.getSetting(`seen:${a.id}`) ?? 0));
        const home = store.assistantChannel(a.id);
        return { kind: 'agent' as const, id: a.id, label: `@ ${home ? `ai · #${home.name}` : a.name} · ${this.workspace.status(a.id)}${unread ? ` (${unread})` : ''}` };
      }),
      { kind: 'create', id: 'create', label: '+ Create Agent [F2]' },
    ];
  }
  speakerInk(agentId: string): (text: string) => string {
    return agentInk(this.workspace.store.agentOrdinal(agentId));
  }
  private activeAgent(): Agent | undefined {
    return this.selected.kind === 'agent' ? this.workspace.store.agent(this.selected.id) : this.workspace.store.channelAssistant(this.selected.id);
  }
  private warmExtensions(): void {
    const agent = this.activeAgent();
    if (agent) void this.workspace.runner.commands?.(agent).catch(error => {
      if (!this.closed && this.activeAgent()?.id === agent.id) this.showNotice(String(error));
    });
  }
  select(selection: Selection): void {
    this.drafts.set(this.selected.id, this.editor.getText());
    this.selected = { kind: selection.kind, id: selection.id };
    this.extensionUI.select(); this.warmExtensions();
    this.editor.setText(this.drafts.get(selection.id) ?? '');
    this.inspectContext = false; this.transcript.scrollToEnd();
    this.tui.setFocus(this.editor); this.refresh();
  }
  private markSeen(): void {
    if (this.closed) return;
    const s = this.workspace.store;
    const count = this.selected.kind === 'channel' ? s.lastMessageSeq(this.selected.id)
      : s.deliveryCount(['done', 'failed', 'interrupted'], this.selected.id);
    if (s.getSetting(`seen:${this.selected.id}`) !== String(count)) s.setSetting(`seen:${this.selected.id}`, String(count));
  }
  title(): string {
    const s = this.workspace.store;
    const model = this.groupModel(this.selected.kind === 'channel' ? this.selected.id : undefined);
    const home = this.selected.kind === 'agent' ? s.assistantChannel(this.selected.id) : undefined;
    const view = this.selected.kind === 'channel' ? `# ${s.channel(this.selected.id).name} · ${model ? `${model.provider}/${model.id}` : 'no model'}${s.channelModel(this.selected.id) ? '' : ' (Pi default)'} · members: ${s.members(this.selected.id).map(a => s.assistantChannel(a.id) ? 'ai' : a.name).join(', ') || '(none)'}`
      : `@ ${home ? `ai · #${home.name}` : s.agent(this.selected.id).name} · ${this.workspace.status(this.selected.id)} · ${this.inspectContext ? 'context inspector' : 'actual session'}`;
    return `Pi Workspace${this.options.demo ? ' · DEMO / no model calls' : ''}${this.workspace.paused ? ' · PAUSED' : ''}\n${view}`;
  }
  header(width: number): string[] {
    const [title, view] = this.title().split('\n');
    if (width < 3) return [truncateToWidth(ink.accent(title), width)];
    return [truncateToWidth(ink.accent(safeText(title)), width), truncateToWidth(ink.muted(safeText(view)), width), rule('', width)];
  }
  footer(width: number): string {
    const s = this.workspace.store;
    const agent = this.selected.kind === 'agent' ? s.agent(this.selected.id) : undefined;
    const model = agent ? s.modelFor(agent, null, this.groupModel()) : this.groupModel(this.selected.id);
    const running = s.agents().filter(a => this.workspace.status(a.id) === 'working').length;
    const queued = s.deliveryCount(['queued']);
    return statusLine([
      { text: this.options.demo ? 'π DEMO' : 'π WORKSPACE', color: ink.accent },
      { text: this.workspace.paused ? 'PAUSED' : `${running} running · ${queued} queued`, color: this.workspace.paused ? ink.warning : ink.good },
      { text: `thinking:${this.thinkingState().level}`, color: ink.accent },
      { text: `${model ? `${model.provider}/${model.id}` : 'no model'}${agent ? ` · ${agent.tools}${s.inheritsModel(agent.id) ? ' · inherit' : ''}` : ' · group default'}`, color: ink.code },
      { text: this.extensionUI.status(), color: ink.muted },
      { text: agent?.cwd ?? this.options.cwd, color: ink.muted },
    ], width);
  }
  private requestQuit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.extensionUI.close();
    this.showNotice('Stopping work and closing workspace…');
    this.options.onQuit();
  }
  body(width: number): string[] {
    const previous = this.renderedBlocks;
    this.renderedBlocks = new Map(); // Retain only this view, never every streamed revision or terminal width.
    const cached: CacheBlock = (key, draw) => {
      const id = JSON.stringify(key);
      const result = previous.get(id) ?? draw();
      this.renderedBlocks.set(id, result);
      return result;
    };
    try {
      const s = this.workspace.store;
      if (this.selected.kind === 'channel') {
        const messages = s.messages(this.selected.id);
        if (!messages.length) return [ink.heading(truncateToWidth("Let's build something great.", width)), '',
          ...lines('F2 creates an Agent · F3 creates a group.\nYour channel assistant answers by default; @name directs only that Agent.\nType / to find commands and installed skills.\nUse /members alice,bob to set group members.\nClick an Agent to enter its actual context.', width).map(ink.muted)];
        const assistant = s.channelAssistant(this.selected.id);
        const turns = assistant ? channelTurns(this.workspace.runner.inspect(assistant).messages, s.channel(this.selected.id).name) : new Map<string, unknown[]>();
        const deliveries = s.messageDeliveries(messages.map(m => m.id));
        const byId = new Map(messages.map(m => [m.id, m]));
        const entriesById = new Map(messages.map(m => [m.id, transcriptEntries(turns.get(m.id) ?? [], assistant?.name ?? 'ai', this.expandTools)]));
        const receiptsById = new Map<string, string[]>();
        const replies = new Set<string>();
        for (const d of deliveries) {
          if (!byId.has(d.messageId)) continue;
          const receipts = receiptsById.get(d.messageId) ?? [];
          receipts.push(`${d.agentId === assistant?.id ? 'ai' : s.agent(d.agentId).name}:${d.state}`);
          receiptsById.set(d.messageId, receipts);
          if (d.agentId !== assistant?.id) continue;
          const final = entriesById.get(d.messageId)?.filter(e => e.kind === 'assistant').at(-1);
          if (final && byId.get(`${d.id}:channel-reply`)?.text === final.text) replies.add(`${d.id}:channel-reply`);
        }
        return messages.flatMap(m => {
          if (replies.has(m.id)) return [];
          const sender = m.sender === 'human' ? 'you' : m.sender === assistant?.id ? 'ai' : s.agent(m.sender).name;
          const receipts = receiptsById.get(m.id) ?? [];
          const heading = `${sender} · ${m.created.slice(11, 19)}${receipts.length ? ` [${receipts.join(', ')}]` : ''}`;
          const entries = entriesById.get(m.id)!.slice(1);
          return [...cached([width, heading, m.text, m.sender], () => messageBlock(heading, m.text, width, m.sender === 'human', m.sender === 'human' ? ink.muted : this.speakerInk(m.sender))), '',
            ...entries.flatMap(entry => assistant ? [...this.renderEntry(entry, width, assistant, cached), ''] : [])];
        });
      }
      const agent = s.agent(this.selected.id);
      const context = this.workspace.runner.inspect(agent);
      const deliveries = s.deliveries(agent.id, ['queued', 'failed', 'interrupted']);
      const deliveryText = deliveries.map(d => {
        const message = s.message(d.messageId);
        const sender = message.sender === 'human' ? 'you' : s.assistantChannel(message.sender) ? 'ai' : s.agent(message.sender).name;
        return `[${d.state}] ${d.id}${d.error ? `: ${d.error}` : ''}\n${sender}: ${message.text.slice(0, 240)}`;
      }).join('\n');
      const model = s.modelFor(agent, null, this.groupModel());
      const header = this.inspectContext ? `Direct model: ${model.provider}/${model.id}${s.inheritsModel(agent.id) ? ' (group/Pi inheritance)' : ' (Agent override)'}\nCWD: ${agent.cwd}\nSession: ${agent.sessionFile ?? '(not persisted yet)'}\nTools: ${context.tools.join(', ')}\n\nSYSTEM\n${context.system}\n\nMODEL CONTEXT (last 200 messages)\n\n` : '';
      const messages = transcriptEntries(context.messages.slice(-200), agent.name, this.expandTools, this.inspectContext)
        .flatMap(entry => [...this.renderEntry(entry, width, agent, cached), '']);
      return [...(header ? lines(header, width).map(ink.muted) : []),
        ...(messages.length ? messages : lines('No conversation yet. Send a prompt below.', width).map(ink.dim)),
        ...(deliveryText ? lines(`\nDELIVERIES\n${deliveryText}`, width).map(ink.warning) : [])];
    } catch (error) { return lines(`Cannot display context: ${String(error)}`, width).map(ink.error); }
  }
  private renderEntry(entry: TranscriptEntry, width: number, agent: Agent, cached: CacheBlock): string[] {
    const cwd = agent.cwd;
    if (entry.kind === 'tool' && entry.speaker === 'read' && entry.args && typeof entry.args === 'object' && 'path' in entry.args && typeof entry.args.path === 'string') {
      const path = resolve(cwd, entry.args.path);
      const skill = this.options.skills?.find(skill => resolve(skill.filePath) === path);
      if (skill) entry = { ...entry, speaker: `[skill] ${skill.name} · read` };
    }
    const speaker = entry.kind === 'assistant'
      ? this.workspace.store.agents(true).find(a => a.name === entry.speaker) ?? agent : agent;
    if (entry.kind === 'assistant' && speaker.id === agent.id && this.workspace.store.assistantChannel(agent.id)) entry = { ...entry, speaker: 'ai' };
    return cached([width, this.expandTools, entry, speaker.id], () => renderEntry(entry, width, this.expandTools, this.speakerInk(speaker.id)));
  }
  async submit(text: string): Promise<void> {
    if (!text.trim() || this.quitting) return;
    const target = { ...this.selected };
    try {
      this.editor.addToHistory(text);
      const skill = !this.workspace.runner.command && invokedSkill(text, this.options.skills ?? []);
      if (skill) {
        if (target.kind === 'channel') {
          this.workspace.humanChannel(target.id, text);
        } else this.workspace.humanDirect(target.id, text);
      }
      else if (text.startsWith('/')) await this.command(text);
      else if (target.kind === 'channel') this.workspace.humanChannel(target.id, text);
      else this.workspace.humanDirect(target.id, text);
      // Do not erase a draft typed into another view while a command was waiting.
      this.drafts.delete(target.id);
      if (this.selected.id === target.id && this.editor.getText() === text) this.editor.setText('');
      this.transcript.scrollToEnd(); this.refresh();
    } catch (error) {
      // Editor clears on Enter before invoking us; preserve rejected user input.
      if (this.selected.id === target.id && !this.editor.getText()) this.editor.setText(text);
      else if (!this.drafts.get(target.id)) this.drafts.set(target.id, text);
      this.showNotice(String(error));
    }
  }
  private async sendSteer(): Promise<void> {
    const target = { ...this.selected }, text = this.editor.getText();
    try {
      if (target.kind !== 'agent') throw new Error('Select an Agent to steer');
      await this.workspace.steer(target.id, text);
      if (this.selected.id === target.id && this.editor.getText() === text) this.editor.setText('');
      this.refresh();
    } catch (error) { this.showNotice(String(error)); }
  }
  async command(text: string): Promise<void> {
    const [cmd, ...parts] = text.trim().split(/\s+/); const arg = parts.join(' ');
    const w = this.workspace, s = w.store;
    const agentId = () => {
      if (this.selected.kind === 'agent') return this.selected.id;
      const assistant = s.channelAssistant(this.selected.id);
      if (!assistant) throw new Error('Configure a channel model first');
      return assistant.id;
    };
    try {
      switch (cmd) {
        case '/agent': await this.createAgent(); break;
        case '/channel': await this.createChannel(); break;
        case '/members': {
          if (this.selected.kind !== 'channel') throw new Error('Select a channel first');
          const channelId = this.selected.id;
          const ids = arg ? arg.split(/[ ,]+/).filter(Boolean).map(name => s.agent(name.replace(/^@/, '')).id)
            : await this.pickMembers(s.members(channelId).filter(a => !s.assistantChannel(a.id)).map(a => a.id));
          if (ids) { s.setMembers(channelId, ids); w.kick(); } break;
        }
        case '/switch': {
          const name = arg || await this.prompt('Switch conversation', '', [
            ...s.channels().map(c => ({ value: `#${c.name}`, label: `#${c.name}`, description: 'Group 群聊' })),
            ...s.agents().map(a => ({ value: `@${a.name}`, label: `@${a.name}`, description: 'Agent' })),
          ]);
          if (name) this.select(name.startsWith('#') ? { kind: 'channel', id: s.channel(name.slice(1)).id } : { kind: 'agent', id: s.agent(name.replace(/^@/, '')).id }); break;
        }
        case '/stop': w.stop(agentId()); break;
        case '/resume': w.resume(agentId()); break;
        case '/continue': w.continueBudget(agentId()); break;
        case '/retry': {
          const answer = await this.prompt('Replay may repeat external side effects. Type RETRY after inspecting the delivery.', '');
          if (answer === 'RETRY') w.retry(arg); break;
        }
        case '/pause': w.setPaused(!w.paused); break;
        case '/stop-all': w.stopAll(); break;
        case '/context': this.inspectContext = !this.inspectContext; break;
        case '/tools': this.expandTools = !this.expandTools; break;
        case '/models': await this.pickModel(); break;
        case '/thinking': await this.pickThinking(arg); break;
        case '/autonomy': {
          const home = this.selected.kind === 'channel' ? s.channel(this.selected.id) : s.assistantChannel(this.selected.id);
          if (!home) throw new Error('Select a channel or its assistant');
          const mode = await this.prompt(`Worker creation · #${home.name}`, s.getSetting(`autonomy:${home.id}`) ?? 'auto', [
            { value: 'auto', label: 'Automatic · 自动', description: 'Assistant names and starts workers without asking again' },
            { value: 'approve', label: 'Human approval · 人工审批', description: 'Queue proposals; /approve decides' },
            { value: 'off', label: 'Disabled · 禁用', description: 'Do not let the assistant create workers' },
          ]); if (!mode) break;
          const tools = mode === 'off' ? undefined : await this.prompt('Automatic worker permissions · NOT a sandbox\nWorkers use this channel assistant’s directory.', s.getSetting(`worker-profile:${home.id}`) ?? 'code', [
            { value: 'chat', label: 'chat', description: 'Conversation + shared public memory; no file/shell access' },
            { value: 'read', label: 'read', description: 'Authorize host file reading for automatically created workers' },
            { value: 'code', label: 'code', description: 'Pi read/write/edit/bash/grep/find/ls; overlapping directories take turns' },
          ]);
          if (mode !== 'off' && !tools) break;
          s.atomic(() => { s.setSetting(`autonomy:${home.id}`, mode); if (tools) s.setSetting(`worker-profile:${home.id}`, tools); });
          this.showNotice(`Worker policy saved: ${mode} / ${tools ?? 'disabled'}. Existing worker permissions are unchanged.`); break;
        }
        case '/approve': {
          const channel = this.selected.kind === 'channel' ? this.selected.id : s.assistantChannel(this.selected.id)?.id;
          if (!channel) throw new Error('Select a channel or its assistant');
          const requests = s.workerRequests().filter(r => r.channelId === channel && r.state === 'pending');
          if (!requests.length) { this.showNotice('No pending worker approvals.'); break; }
          const id = await this.prompt('Pending workers · choose a proposal', '', requests.map(r => ({ value: r.id, label: `@${r.name} — ${r.role}`, description: r.task })));
          if (!id) break;
          const request = requests.find(r => r.id === id)!;
          const action = await this.prompt(`@${request.name} · ${request.tools}\n${request.role}\nTask: ${request.task}`, 'reject', [
            { value: 'approve', label: 'Approve and start · 批准', description: 'Create this worker and queue its task' },
            { value: 'reject', label: 'Reject · 拒绝', description: 'Do not create this worker' },
          ]);
          if (action) w.approveWorker(id, action === 'approve'); break;
        }
        case '/remove': {
          const name = arg || await this.prompt('Archive Agent · preserve public memory and private session', '',
            s.agents().filter(a => !s.assistantChannel(a.id)).map(a => ({ value: a.id, label: `@${a.name}`, description: a.role })));
          if (!name) break;
          const agent = s.agent(name.replace(/^@/, ''));
          await w.archive(agent.id);
          if (this.selected.id === agent.id) this.select({ kind: 'channel', id: s.channels()[0].id });
          this.showNotice(`Archived @${agent.name}. Public results remain searchable; private context is not shared.`); break;
        }
        case '/memory': {
          const reader = agentId();
          const query = arg || await this.prompt('Search archived public memory', ''); if (!query) break;
          const hits = s.memorySearch(reader, query, this.selected.kind === 'channel' ? this.selected.id : undefined);
          if (!hits.length) { this.showNotice('No matching shared memory. Private sessions are never searched.'); break; }
          const id = await this.prompt('Shared memory · choose an original source', '', hits.map(hit => ({ value: hit.id, label: `@${hit.agent} · #${hit.channel}`, description: hit.excerpt })));
          if (id) { const source = s.memoryRead(reader, id); await this.prompt(`Memory source ${id}\n${source.text}`, ''); } break;
        }
        case '/help': await this.prompt('Help · Pi Workspace\nF2 or /agent: create · F3 or /channel: create group\n/models: search and set group/Agent model\n/thinking: set effort or inherit · Shift+Tab cycles supported levels\n/remove: archive worker (keeps public memory and private history)\n/memory: search archived public results\n/autonomy: automatic / approval / disabled + worker permissions\n/approve: review pending worker proposals\n/members: search/toggle members; or /members alice,bob\n/switch: search conversations; or /switch #group or @agent\nF4/context · F5/tools\n/stop · /resume · /continue (12 more turns)\n/retry DELIVERY_ID (explicit replay confirmation)\n/pause: scheduling toggle · /stop-all · /quit\n/ opens commands & skills; @ opens Agent names\n/skill:name task (Agent) or /skill:name @agent task (group)\n↑/↓ choose · Tab completes · Esc dismisses the menu\nEnter sends · Shift+Enter newline · Alt+Enter steer\nCtrl+C clears; press twice to quit · Ctrl+D quits when empty\nPgUp/PgDn or mouse wheel scroll. Narrow screens hide the sidebar; Ctrl+←/→ still switches views.\nNo automatic publication of direct Agent outputs.', ''); break;
        case '/quit': this.requestQuit(); break;
        default: {
          const target = { ...this.selected }, agent = this.activeAgent();
          const result = agent ? await w.runner.command?.(agent, text) : undefined;
          if (!result) throw new Error(`Unknown command: ${cmd}; use /help. Pi extension commands require a code Agent; the todo package command is /todos.`);
          if (result === 'prompt') {
            if (target.kind === 'channel') w.humanChannel(target.id, text); else w.humanDirect(target.id, text);
          }
          break;
        }
      }
      this.refresh();
    } catch (error) { this.showNotice(String(error)); throw error; }
  }
  private groupModel(channelId?: string): ModelChoice | undefined {
    return (channelId ? this.workspace.store.channelModel(channelId) : undefined) ?? this.options.defaultModel ?? this.options.models[0];
  }
  private modelItems(channelId?: string): SelectItem[] {
    const model = this.groupModel(channelId);
    return [{ value: 'inherit', label: 'Follow default · 跟随默认', description: `${model ? `${model.provider}/${model.id}` : 'No Pi default configured'} · group / Pi` },
      ...this.options.models.map(m => ({ value: `${m.provider}/${m.id}`, label: m.id, description: m.provider }))];
  }
  private async pickModel(): Promise<void> {
    const s = this.workspace.store;
    let target = { ...this.selected };
    const home = target.kind === 'agent' ? s.assistantChannel(target.id) : undefined;
    if (home) target = { kind: 'channel', id: home.id };
    const agent = target.kind === 'agent' ? s.agent(target.id) : undefined;
    const current = agent ? (s.inheritsModel(agent.id) ? undefined : { provider: agent.provider, id: agent.model }) : s.channelModel(target.id);
    const choice = await this.prompt(`Model · ${agent ? `@${agent.name}` : `#${s.channel(target.id).name}`}`, current ? `${current.provider}/${current.id}` : 'inherit', this.modelItems());
    if (choice === undefined) return;
    const model = this.options.models.find(m => `${m.provider}/${m.id}` === choice);
    if (choice !== 'inherit' && !model) throw new Error('Model is not available');
    if (agent) s.setAgentModel(agent.id, model); else s.setChannelModel(target.id, model);
    this.showNotice(`Model saved: ${model ? `${model.provider}/${model.id}` : 'follow group / Pi default'}. Applies on the next turn; active work is unchanged.`);
  }
  private thinkingState() {
    const s = this.workspace.store;
    let target = { ...this.selected };
    const home = target.kind === 'agent' ? s.assistantChannel(target.id) : undefined;
    if (home) target = { kind: 'channel', id: home.id };
    const agent = target.kind === 'agent' ? s.agent(target.id) : undefined;
    const choice = agent ? s.modelFor(agent, null, this.groupModel()) : this.groupModel(target.id);
    const model = choice ? this.options.runtime?.getModel(choice.provider, choice.id) : undefined;
    const fallback = (choice ? this.options.settings?.getModelThinkingLevel(choice.provider, choice.id) : undefined)
      ?? this.options.settings?.getDefaultThinkingLevel() ?? 'medium';
    const saved = s.thinkingLevel(target.kind, target.id);
    const requested = agent ? s.thinkingFor(agent, null, fallback) : saved ?? fallback;
    const levels: ThinkingLevel[] = model ? getSupportedThinkingLevels(model) : this.options.demo ? THINKING_LEVELS.slice(0, 5) : ['off'];
    const level = model ? clampThinkingLevel(model, requested) : levels.includes(requested) ? requested : 'off';
    return { target, levels, level, saved };
  }
  private async pickThinking(choice?: string): Promise<void> {
    const { target, levels, level, saved } = this.thinkingState();
    const s = this.workspace.store;
    if (choice === 'cycle') {
      if (levels.length < 2) { this.showNotice(`Thinking is fixed at ${level} for this model.`); return; }
      choice = levels[(levels.indexOf(level) + 1) % levels.length];
    }
    const selected = choice || await this.prompt(`Thinking effort · ${target.kind === 'channel' ? `#${s.channel(target.id).name}` : `@${s.agent(target.id).name}`} · current: ${level}`,
      saved ?? 'inherit', [
        { value: 'inherit', label: 'Follow default · 跟随默认', description: 'Group / Pi thinking settings; applies next turn' },
        ...levels.map(value => ({ value, label: value, description: value === 'off' ? 'Disable thinking' : 'Supported by the current model' })),
      ]);
    if (selected === undefined) return;
    const next = levels.find(value => value === selected);
    if (selected !== 'inherit' && next === undefined) throw new Error(`Unsupported thinking level: ${selected}. Choose ${levels.join(', ')} or inherit.`);
    s.setThinkingLevel(target.kind, target.id, next);
    this.showNotice(`Thinking saved: ${next ?? 'follow group / Pi default'}. Applies on the next turn; active work is unchanged.`);
  }
  private async pickMembers(initial: string[]): Promise<string[] | undefined> {
    const selected = new Set(initial);
    for (;;) {
      const choice = await this.prompt('Group members · search and toggle', 'done', [
        { value: 'done', label: '✓ Save members', description: `${selected.size} selected · 保存` },
        ...this.workspace.store.agents().filter(a => !this.workspace.store.assistantChannel(a.id)).map(a => ({ value: a.id, label: `${selected.has(a.id) ? '[x]' : '[ ]'} ${a.name}`, description: a.role })),
      ]);
      if (choice === undefined) return;
      if (choice === 'done') return [...selected];
      if (selected.has(choice)) selected.delete(choice); else selected.add(choice);
    }
  }
  private prompt(label: string, initial: string, items?: SelectItem[]): Promise<string | undefined> {
    if (this.closed || this.dialog) return Promise.resolve(undefined);
    this.dialog = true;
    return new Promise(resolvePromise => {
      const dialog = new SetupDialog(label, initial, items, () => this.tui.terminal.rows, value => {
        overlay.hide(); this.dialog = false; this.tui.setFocus(this.editor); this.tui.requestRender(); resolvePromise(value);
      }, () => this.tui.requestRender());
      const overlay = this.tui.showOverlay(dialog, { width: '85%', anchor: 'center', margin: 1 });
      this.tui.setFocus(dialog); this.tui.requestRender();
    });
  }
  async createAgent(): Promise<void> {
    if (this.dialog || this.closed) return;
    const channelId = this.selected.kind === 'channel' ? this.selected.id : this.workspace.store.channels()[0].id;
    try {
      const name = await this.prompt('Agent name (lowercase letters/digits/_/-):', ''); if (name === undefined) return; validName(name);
      const role = await this.prompt('Role / instructions:', 'A helpful collaborator.'); if (role === undefined) return;
      const modelChoice = await this.prompt('Agent model · inherit or choose an override', 'inherit', this.modelItems(channelId));
      if (modelChoice === undefined) return;
      const model = modelChoice === 'inherit' ? this.groupModel(channelId) : this.options.models.find(m => `${m.provider}/${m.id}` === modelChoice);
      if (!model) throw new Error('Model not available; configure it in Pi first, then restart this app');
      const cwd = await this.prompt('Working directory:', this.options.cwd); if (cwd === undefined) return;
      const profile = await this.prompt('Tool permissions · Pi native tools by default\nread/code are NOT sandboxes. Overlapping writable directories take turns.', 'code', [
        { value: 'chat', label: 'chat', description: 'Communication only · 对话' },
        { value: 'read', label: 'read', description: 'Host file access · 读取文件' },
        { value: 'code', label: 'code · Pi native', description: 'read/write/edit/bash/grep/find/ls · 文件和命令执行' },
      ]); if (profile === undefined) return;
      if (!['chat', 'read', 'code'].includes(profile)) throw new Error('Choose chat, read or code');
      const a = this.workspace.store.createAgent({ name, role, provider: model.provider, model: model.id, cwd: resolve(cwd), tools: profile as ToolProfile });
      if (modelChoice === 'inherit') this.workspace.store.setAgentModel(a.id);
      const existing = this.workspace.store.members(channelId).map(a => a.id);
      this.workspace.store.setMembers(channelId, [...existing, a.id]);
      this.select({ kind: 'agent', id: a.id }); this.showNotice(`Created @${a.name}. Direct outputs stay in this session.`);
    } catch (error) { this.showNotice(String(error)); }
  }
  async createChannel(): Promise<void> {
    if (this.dialog || this.closed) return;
    try {
      const name = await this.prompt('Channel name:', ''); if (name === undefined) return;
      validName(name);
      const ids = await this.pickMembers(this.workspace.store.agents().filter(a => !this.workspace.store.assistantChannel(a.id)).map(a => a.id));
      if (ids === undefined) return;
      const model = this.groupModel();
      if (!model) throw new Error('Configure a Pi model before creating a channel');
      const c = this.workspace.store.atomic(() => {
        const channel = this.workspace.store.createChannel(name);
        this.workspace.store.ensureChannelAssistant(channel.id, this.options.cwd, model);
        this.workspace.store.setMembers(channel.id, ids);
        return channel;
      });
      this.select({ kind: 'channel', id: c.id });
    } catch (error) { this.showNotice(String(error)); }
  }
  start(): void { this.tui.start(); this.refresh(); this.warmExtensions(); this.workspace.kick(); }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.extensionUI.close();
    this.workspace.off('change', this.refresh); this.workspace.off('notice', this.showNotice);
    // Clear before leaving alternate screen; don't dump private context into shell scrollback.
    this.tui.setLayoutRoot(new Text('Workspace closed.', 0, 0)); this.tui.renderNow(true); this.tui.stop();
  }
}
