import { setTimeout } from 'node:timers/promises';
import { Store, type Agent } from './store.js';
import type { Runner, Turn } from './workspace.js';

export class DemoRunner implements Runner {
  private history = new Map<string, unknown[]>();
  private current = new Map<string, Turn>();
  constructor(private store: Store) {}
  private messages(id: string): unknown[] {
    let messages = this.history.get(id);
    if (!messages) {
      try {
        const stored: unknown = JSON.parse(this.store.getSetting(`demo:${id}`) ?? '[]');
        if (!Array.isArray(stored)) throw new Error('Expected an array');
        messages = stored;
      } catch (cause) { throw new Error(`Invalid saved demo history for ${id}`, { cause }); }
      this.history.set(id, messages);
    }
    return messages;
  }
  private save(id: string): void { this.store.setSetting(`demo:${id}`, JSON.stringify(this.messages(id).slice(-200))); }
  async run(turn: Turn): Promise<string | void> {
    const id = turn.agent.id;
    this.current.set(id, turn);
    const senderName = turn.message.sender === 'human' ? 'you' : this.store.agent(turn.message.sender).name;
    this.messages(id).push({ role: 'user', content: turn.message.text, senderName, workspaceMessage: turn.message.id,
      channel: turn.message.channelId ? this.store.channel(turn.message.channelId).name : null }); turn.changed();
    const response = { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'pending' };
    try {
      await setTimeout(120, undefined, { signal: turn.signal });
      let text = `[Demo · no model call] ${turn.agent.name} received: ${turn.message.text.slice(0, 250)}`;
      if (this.store.assistantChannel(id) && turn.message.channelId && turn.message.sender === 'human' && /delegate|派工|分工/i.test(turn.message.text)) {
        const request = turn.createWorker({ name: 'scout', role: 'Research the requested topic and report findings', task: turn.message.text }, 'demo-worker');
        text = request.agentId ? `Created @${this.store.agent(request.agentId).name} — ${request.role}. You can @ it with further instructions; I’m available here.`
          : `Proposed @${request.name} — ${request.role}. Use /approve; I’m still available here.`;
      }
      this.messages(id).push(response);
      for (let i = 0; i < text.length; i += 12) {
        response.content[0].text = text.slice(0, i + 12); turn.changed();
        await setTimeout(15, undefined, { signal: turn.signal });
      }
      if (this.store.assistantChannel(id)) return text;
      if (turn.message.channelId) {
        const bob = this.store.members(turn.message.channelId).find(a => a.name === 'bob');
        const collaborate = turn.agent.name === 'alice' && bob && turn.message.sender === 'human' && /collaborate|协作/i.test(turn.message.text);
        turn.send({ channel: turn.message.channelId, to: collaborate ? [bob.id] : [], text: collaborate ? '@bob 请检查这个协作请求。' : text });
      } else if (turn.message.sender !== 'human') {
        this.messages(id).push({ role: 'assistant', content: 'Demo peer request processed; not pinging back automatically.' });
      }
    } finally { response.stopReason = turn.signal.aborted ? 'aborted' : 'stop'; this.current.delete(id); this.save(id); turn.changed(); }
  }
  async steer(id: string, text: string): Promise<void> {
    const turn = this.current.get(id);
    if (!turn) throw new Error('Demo Agent is not working');
    this.messages(id).push({ role: 'user', content: `[Steer] ${text}` }); this.save(id); turn.changed();
  }
  inspect(agent: Agent) { return { system: `Demo Agent: ${agent.name}\n${agent.role}\nNo model or file tools are executed.`, tools: ['send_message (demo)'], messages: this.messages(agent.id) }; }
  async release(id: string): Promise<void> { this.history.delete(id); }
  async close(): Promise<void> {}
}
