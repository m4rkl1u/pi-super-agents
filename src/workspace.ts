import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { SlashCommand } from '@earendil-works/pi-tui';
import { Store, MAX_AGENTS, overlaps, validText, validName, type Agent, type Delivery, type Message, type WorkerRequest, type ToolProfile } from './store.js';

export interface Outgoing { channel?: string; to?: string[]; text: string }
export interface WorkerSpec { name: string; role: string; task: string }
export interface Turn {
  agent: Agent; message: Message; context: Message[]; signal: AbortSignal;
  send(input: Outgoing, key?: string): Message;
  createWorker(input: WorkerSpec, key: string): WorkerRequest;
  archiveWorker(id: string): Promise<void>;
  changed(): void;
}
export interface Runner {
  run(turn: Turn): Promise<string | void>;
  steer(agentId: string, text: string): Promise<void>;
  inspect(agent: Agent): { system: string; tools: string[]; messages: unknown[] };
  close(): Promise<void>;
  release?(agentId: string): Promise<void>;
  bindUI?(factory: (agent: Agent, base: ExtensionUIContext) => ExtensionUIContext, changed: () => void): void;
  commands?(agent: Agent): Promise<SlashCommand[]>;
  command?(agent: Agent, text: string): Promise<'handled' | 'prompt' | undefined>;
  shortcut?(agent: Agent, data: string): boolean;
}
interface Active { delivery: Delivery; controller: AbortController; done: Promise<void>; sends: number; published: boolean; steered: boolean }

// Only human composer text is parsed. Agent messages use structured recipients.
export function mentions(text: string): string[] {
  const plain = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|$(?![\s\S]))/gm, '')
    .replace(/^\s*>.*$/gm, '').replace(/(`+)[\s\S]*?\1/g, '');
  return [...new Set([...plain.matchAll(/(?:^|[\s(])@([a-z][a-z0-9_-]{0,31})(?![a-z0-9_-])/g)].map(m => m[1]))];
}

export class Workspace extends EventEmitter {
  private active = new Map<string, Active>();
  private closing = false;
  private scheduled = false;
  constructor(readonly store: Store, readonly runner: Runner, readonly concurrency = MAX_AGENTS) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_AGENTS) throw new Error(`Concurrency must be an integer between 1 and ${MAX_AGENTS}`);
  }
  get paused(): boolean { return this.store.getSetting('paused') === 'true'; }
  changed(): void { this.emit('change'); }
  status(id: string): string {
    const a = this.store.agent(id);
    if (this.store.archived(a.id)) return 'archived';
    if (this.active.has(id)) return a.paused ? 'stopping' : 'working';
    if (a.paused) return 'paused';
    const queued = this.store.deliveries(id, ['queued']);
    if (queued.some(d => this.store.chainExhausted(this.store.message(d.messageId).chainId))) return 'budget';
    return queued.length ? 'queued' : 'idle';
  }
  humanChannel(channel: string, text: string, id: string = randomUUID()): Message {
    const c = this.store.channel(channel);
    const names = mentions(validText(text, 'Message'));
    const members = this.store.members(c.id);
    const recipients = names.map(name => {
      const a = members.find(a => a.name === name);
      if (!a) throw new Error(`@${name} is not a member of #${c.name}`);
      return a.id;
    });
    if (!recipients.length) {
      const assistant = this.store.channelAssistant(c.id);
      if (!assistant) throw new Error('No channel assistant configured. Configure a Pi model and restart.');
      recipients.push(assistant.id);
    }
    const message = this.store.post({ id, channelId: c.id, sender: 'human', target: null, text, chainId: id }, recipients);
    this.kick(); return message;
  }
  humanDirect(agentId: string, text: string, id: string = randomUUID()): Message {
    const a = this.store.agent(agentId);
    if (this.store.archived(a.id)) throw new Error('Agent archived; its public memory is still searchable');
    const message = this.store.post({ id, channelId: null, sender: 'human', target: a.id, text, chainId: id }, [a.id]);
    this.kick(); return message;
  }
  private mayDeliver(d: Delivery, m: Message): boolean {
    if (this.store.archived(d.agentId)) return false;
    if (m.channelId) {
      const members = this.store.members(m.channelId);
      return members.some(a => a.id === d.agentId) && (m.sender === 'human' || members.some(a => a.id === m.sender));
    }
    return m.sender === 'human' || this.store.sharedChannel(m.sender, d.agentId);
  }
  private send(sender: string, active: Active, input: Outgoing, key?: string): Message {
    if (this.closing || active.controller.signal.aborted || this.store.agent(sender).paused) throw new Error('Agent stopped; sending is disabled');
    if (this.active.get(sender) !== active) throw new Error('Turn is no longer active');
    if (++active.sends > 16) throw new Error('Message limit reached for this turn');
    validText(input.text, 'Message');
    const parent = this.store.message(active.delivery.messageId);
    const recipients = [...new Set(input.to ?? [])].map(name => this.store.agent(name).id);
    if (recipients.length > 16) throw new Error('At most 16 recipients per message');
    let channelId: string | null = null;
    if (input.channel) {
      const c = this.store.channel(input.channel);
      channelId = c.id;
      const members = this.store.members(c.id).map(a => a.id);
      if (!members.includes(sender) || recipients.some(id => !members.includes(id))) throw new Error('Channel membership required');
      const assistant = this.store.channelAssistant(c.id);
      if (!recipients.length && assistant && assistant.id !== sender) recipients.push(assistant.id);
    } else if (recipients.length !== 1 || !this.store.sharedChannel(sender, recipients[0])) {
      throw new Error('Direct messages require exactly one recipient in a shared channel');
    }
    if (recipients.includes(sender)) throw new Error('Self-wake is not allowed');
    const message = this.store.post({ id: key ? `${active.delivery.id}:${key}` : randomUUID(), channelId,
      sender, target: channelId ? null : recipients[0], text: input.text, chainId: parent.chainId }, recipients);
    if (channelId && channelId === parent.channelId && this.store.channelAssistant(channelId)?.id === sender && !input.to?.length) active.published = true;
    this.kick(); return message;
  }
  private coordinator(sender: string, active: Active): string {
    const home = this.store.assistantChannel(sender), message = this.store.message(active.delivery.messageId);
    if (!home || message.channelId !== home.id || active.steered) throw new Error('Worker management requires an unsteered channel-assistant turn');
    if (this.closing || active.controller.signal.aborted || this.store.agent(sender).paused || this.active.get(sender) !== active) throw new Error('Assistant stopped');
    const root = this.store.message(message.chainId);
    if (root.sender !== 'human' || root.channelId !== home.id) throw new Error('A human channel request is required');
    return home.id;
  }
  private createWorker(sender: string, active: Active, spec: WorkerSpec, key: string): WorkerRequest {
    const channelId = this.coordinator(sender, active), parent = this.store.message(active.delivery.messageId);
    validName(spec.name); if (spec.name.length > 20) throw new Error('Choose a memorable name of at most 20 characters');
    validText(spec.role, 'Worker role', 400); validText(spec.task, 'Worker task', 8000); validText(key, 'Request key', 200);
    const id = `${active.delivery.id}:${key}`;
    const existing = this.store.workerRequests().find(r => r.id === id);
    if (existing) {
      if (existing.name !== spec.name || existing.role !== spec.role || existing.task !== spec.task) throw new Error('Worker request ID conflict');
      return existing;
    }
    const mode = this.store.getSetting(`autonomy:${channelId}`) ?? 'auto';
    if (!['auto', 'approve'].includes(mode)) throw new Error('Automatic worker creation is disabled');
    const tools = this.store.getSetting(`worker-profile:${channelId}`) ?? 'code';
    if (!['chat', 'read', 'code'].includes(tools)) throw new Error('Invalid worker permission setting');
    const request: WorkerRequest = { id, channelId, assistantId: sender, chainId: parent.chainId,
      name: spec.name, role: spec.role, task: spec.task, tools: tools as ToolProfile, state: 'pending', agentId: null };
    const result = this.store.atomic(() => {
      this.store.addWorkerRequest(request);
      if (mode === 'auto') return this.launchWorker(request);
      this.store.post({ id: `${id}:approval`, channelId, sender, target: null, chainId: parent.chainId,
        text: `Approval requested: @${spec.name} — ${spec.role}\nTask: ${spec.task}\nTools: ${tools}. Use /approve to approve or reject.` }, []);
      return request;
    });
    this.kick(); return result;
  }
  private launchWorker(request: WorkerRequest): WorkerRequest {
    if (this.store.getSetting(`autonomy:${request.channelId}`) === 'off') throw new Error('Automatic worker creation is disabled');
    const profiles = ['chat', 'read', 'code'];
    if (profiles.indexOf(request.tools) > profiles.indexOf(this.store.getSetting(`worker-profile:${request.channelId}`) ?? 'code')) throw new Error('Worker permissions changed; reject this request and create another');
    if (this.store.chainExhausted(request.chainId)) throw new Error('Task budget exhausted; continue the assistant first');
    const assistant = this.store.agent(request.assistantId), model = this.store.modelFor(assistant, request.channelId);
    let name = request.name, suffix = 2;
    while (this.store.agents(true).some(a => a.name === name)) name = `${request.name}-${suffix++}`;
    const agent = this.store.createAgent({ name, role: request.role, provider: model.provider, model: model.id, cwd: assistant.cwd, tools: request.tools });
    this.store.setSetting(`inherit-model:${agent.id}`, 'true');
    this.store.setMembers(request.channelId, [...this.store.members(request.channelId).map(a => a.id), agent.id]);
    this.store.finishWorkerRequest(request.id, 'created', agent.id);
    this.store.post({ id: `${request.id}:dispatch`, channelId: request.channelId, sender: request.assistantId, target: null, chainId: request.chainId,
      text: `Created @${name} — ${request.role}\nTask: ${request.task}\nHuman: use @${name} to add instructions while it works.` }, [agent.id]);
    return { ...request, state: 'created', agentId: agent.id };
  }
  approveWorker(id: string, approve: boolean): void {
    const request = this.store.workerRequests().find(r => r.id === id);
    if (!request || request.state !== 'pending') throw new Error('No pending worker request');
    this.store.atomic(() => {
      if (approve) this.launchWorker(request); else this.store.finishWorkerRequest(id, 'rejected');
    });
    this.kick();
  }
  kick(): void {
    this.changed();
    if (this.scheduled || this.closing) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closing || this.paused) return;
      try { this.pump(); }
      catch (error) { this.setPaused(true); this.emit('notice', `Scheduler paused: ${String(error)}`); }
    });
  }
  private pump(): void {
    for (const d of this.store.deliveries(undefined, ['queued'])) {
      if (this.active.has(d.agentId)) continue;
      const m = this.store.message(d.messageId);
      if (this.active.size >= this.concurrency) continue;
      if (!this.mayDeliver(d, m)) { this.store.finish(d.id, 'cancelled', 'Membership changed before delivery'); continue; }
      const a = this.store.agent(d.agentId);
      // Lock the entire writable turn, including tools, retries, compaction and cancellation.
      if (a.tools === 'code' && [...this.active.keys()].some(id => {
        const other = this.store.agent(id);
        return other.tools === 'code' && overlaps(a.cwd, other.cwd);
      })) continue;
      if (!this.store.claim(d.id)) continue;
      const active: Active = { delivery: d, controller: new AbortController(), done: Promise.resolve(), sends: 0, published: false, steered: false };
      this.active.set(a.id, active);
      active.done = this.run(a, m, active);
    }
    this.changed();
  }
  private async run(agent: Agent, message: Message, active: Active): Promise<void> {
    try {
      const reply = await this.runner.run({ agent, message, context: this.store.context(agent.id, message), signal: active.controller.signal,
        send: (input, key) => this.send(agent.id, active, input, key),
        createWorker: (input, key) => this.createWorker(agent.id, active, input, key),
        archiveWorker: async id => {
          const channelId = this.coordinator(agent.id, active), worker = this.store.agent(id);
          if (!this.store.workerRequests().some(r => r.channelId === channelId && r.agentId === worker.id)) throw new Error('Only workers created for this channel can be archived by its assistant');
          if (this.active.has(worker.id) || this.store.deliveryCount(['queued'], worker.id)) throw new Error('Worker has active or queued instructions; do not interrupt it');
          await this.archive(worker.id);
        }, changed: () => this.changed() });
      if (reply?.trim() && message.channelId && this.store.channelAssistant(message.channelId)?.id === agent.id &&
          !active.published && !active.steered && !active.controller.signal.aborted) {
        const text = reply.length > 32_000 ? `${reply.slice(0, 31_900)}\n[Truncated: full reply is in the assistant session.]` : reply;
        this.send(agent.id, active, { channel: message.channelId, text }, 'channel-reply');
      }
      this.store.finish(active.delivery.id, active.controller.signal.aborted ? 'interrupted' : 'done',
        active.controller.signal.aborted ? 'Stopped by human; inspect before retrying' : null);
    } catch (error) {
      this.store.finish(active.delivery.id, active.controller.signal.aborted ? 'interrupted' : 'failed', String(error));
      this.store.pause(agent.id, true);
      this.emit('notice', `${agent.name}: ${String(error)}`);
    } finally {
      this.active.delete(agent.id);
      this.kick();
    }
  }
  setPaused(paused: boolean): void { this.store.setSetting('paused', String(paused)); this.kick(); }
  stop(id: string): void {
    const a = this.store.agent(id);
    this.store.pause(a.id, true);
    this.active.get(a.id)?.controller.abort();
    this.changed();
  }
  stopAll(): void { this.setPaused(true); for (const a of this.store.agents()) this.stop(a.id); }
  async archive(id: string): Promise<void> {
    const a = this.store.agent(id);
    if (this.store.assistantChannel(a.id)) throw new Error('Channel assistants cannot be removed; their context is permanent');
    this.stop(a.id);
    await this.active.get(a.id)?.done;
    await this.runner.release?.(a.id);
    this.store.archiveAgent(a.id);
    this.kick();
  }
  resume(id: string): void {
    const a = this.store.agent(id);
    if (this.store.archived(a.id)) throw new Error('Archived Agents cannot resume');
    if (this.active.has(a.id)) throw new Error('Wait until the current turn has stopped');
    this.store.pause(a.id, false); this.kick();
  }
  retry(deliveryId: string): void {
    const d = this.store.deliveries().find(d => d.id === deliveryId);
    if (!d || !['failed', 'interrupted'].includes(d.state)) throw new Error('Only failed/interrupted deliveries can be retried');
    if (this.store.archived(d.agentId)) throw new Error('Archived Agents cannot retry');
    if (this.active.has(d.agentId)) throw new Error('Agent is still running');
    this.store.finish(d.id, 'queued'); this.store.pause(d.agentId, false); this.kick();
  }
  continueBudget(id: string): void {
    const chains = new Set(this.store.deliveries(id, ['queued']).map(d => this.store.message(d.messageId).chainId));
    for (const request of this.store.workerRequests()) if (request.assistantId === id && request.state === 'pending') chains.add(request.chainId);
    for (const chain of chains) if (this.store.chainExhausted(chain)) this.store.extendChain(chain);
    this.kick();
  }
  async steer(id: string, text: string): Promise<void> {
    const a = this.store.agent(id);
    const active = this.active.get(a.id);
    if (!active || a.paused) throw new Error('Agent must be working to steer; otherwise send a normal message');
    // Private steering must not silently become an automatically published channel answer.
    active.steered = true;
    // A steer stays in the existing chain; it cannot reset the automation budget.
    await this.runner.steer(a.id, validText(text, 'Steering input'));
    this.changed();
  }
  async idle(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    while (this.active.size) {
      await Promise.all([...this.active.values()].map(a => a.done));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const [id, a] of this.active) { this.store.pause(id, true); a.controller.abort(); }
    await this.idle();
    await this.runner.close();
  }
}
