import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getAgentDir, loadProjectContextFiles, type AgentSession } from '@earendil-works/pi-coding-agent';

export const MAX_AGENTS = 128;
export type ThinkingLevel = AgentSession['thinkingLevel'];
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[];
export type ToolProfile = 'chat' | 'read' | 'code';
export interface ModelChoice { provider: string; id: string }
export interface Agent {
  id: string; name: string; role: string; provider: string; model: string;
  cwd: string; tools: ToolProfile; sessionFile: string | null; paused: number;
}
export interface Channel { id: string; name: string }
export interface Message {
  seq: number; id: string; channelId: string | null; sender: string; target: string | null;
  text: string; chainId: string; created: string;
}
export interface Delivery { id: string; messageId: string; agentId: string; state: string; error: string | null }
export interface NewAgent { name: string; role: string; provider: string; model: string; cwd: string; tools?: ToolProfile }
export interface WorkerRequest {
  id: string; channelId: string; assistantId: string; chainId: string; name: string; role: string; task: string;
  tools: ToolProfile; state: 'pending' | 'created' | 'rejected'; agentId: string | null;
}

export function validText(value: string, label: string, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${label} must contain 1–${max} characters`);
  }
  return value.trim();
}
export function validName(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) throw new Error('Name: use 1–32 lowercase letters, digits, _ or -, starting with a letter');
  return value;
}
export function overlaps(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const r = relative(parent, child);
    return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
  };
  return contains(a, b) || contains(b, a);
}

export class Store {
  readonly db: DatabaseSync;
  readonly dir: string;
  private readonly lock: string;
  private closed = false;
  private transactionDepth = 0;

  constructor(dir: string, lockDir = dir) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    this.lock = join(resolve(lockDir), 'owner.lock');
    let fd: number;
    try { fd = openSync(this.lock, 'wx', 0o600); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      throw new Error(`Workspace locked: ${this.lock}. Another super-agents instance may be running. Confirm the recorded PID has stopped before removing this file.`, { cause });
    }
    let db: DatabaseSync | undefined;
    try {
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() })); }
      finally { closeSync(fd); }
      this.db = db = new DatabaseSync(join(this.dir, 'workspace.sqlite'));
      chmodSync(join(this.dir, 'workspace.sqlite'), 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error(`Unsupported workspace schema: ${version}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL, tools TEXT NOT NULL,
          sessionFile TEXT, paused INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS members (channelId TEXT REFERENCES channels(id), agentId TEXT REFERENCES agents(id), PRIMARY KEY(channelId,agentId));
        CREATE TABLE IF NOT EXISTS channel_assistants (channelId TEXT PRIMARY KEY REFERENCES channels(id), agentId TEXT UNIQUE NOT NULL REFERENCES agents(id));
        CREATE TABLE IF NOT EXISTS archives (agentId TEXT PRIMARY KEY REFERENCES agents(id), created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_requests (id TEXT PRIMARY KEY, channelId TEXT REFERENCES channels(id),
          assistantId TEXT REFERENCES agents(id), chainId TEXT REFERENCES chains(id), name TEXT, role TEXT, task TEXT,
          tools TEXT, state TEXT, agentId TEXT REFERENCES agents(id));
        CREATE TABLE IF NOT EXISTS chains (id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, budget INTEGER NOT NULL DEFAULT 12);
        CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          channelId TEXT REFERENCES channels(id), sender TEXT NOT NULL, target TEXT REFERENCES agents(id),
          text TEXT NOT NULL, chainId TEXT NOT NULL REFERENCES chains(id), created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, messageId TEXT REFERENCES messages(id),
          agentId TEXT REFERENCES agents(id), state TEXT NOT NULL, error TEXT, UNIQUE(messageId,agentId));
        CREATE TABLE IF NOT EXISTS cursors (agentId TEXT, channelId TEXT, seq INTEGER NOT NULL, PRIMARY KEY(agentId,channelId));
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS delivery_state ON deliveries(state);
        CREATE INDEX IF NOT EXISTS delivery_agent_state ON deliveries(agentId,state);
        CREATE INDEX IF NOT EXISTS message_channel_seq ON messages(channelId,seq);
      `);
      if (Number(version) < 5) this.atomic(() => {
        // Explicitly requested upgrade; preserve session files, paused state and pending approvals.
        this.db.exec(`UPDATE agents SET tools='code' WHERE id NOT IN (SELECT agentId FROM archives);
          UPDATE settings SET value='code' WHERE key GLOB 'worker-profile:*';
          PRAGMA user_version=5;`);
      });
      // A crashed turn may have external side effects. Never silently replay it.
      this.db.exec(`UPDATE agents SET paused=1 WHERE id IN (SELECT agentId FROM deliveries WHERE state='running');
        UPDATE deliveries SET state='interrupted',error='Previous process ended during execution; inspect before retrying' WHERE state='running';`);
      if (!this.channels().length) this.createChannel('general');
    } catch (error) {
      db?.close();
      unlinkSync(this.lock);
      throw error;
    }
  }

  atomic<T>(fn: () => T): T {
    const nested = this.transactionDepth > 0;
    this.db.exec(nested ? 'SAVEPOINT nested' : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = fn(); this.db.exec(nested ? 'RELEASE nested' : 'COMMIT'); return result; }
    catch (error) { this.db.exec(nested ? 'ROLLBACK TO nested; RELEASE nested' : 'ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  agents(includeArchived = false): Agent[] {
    // SAFETY: rows follow the versioned local schema; writes below validate their inputs.
    return this.db.prepare('SELECT * FROM agents WHERE ? OR id NOT IN (SELECT agentId FROM archives) ORDER BY name').all(Number(includeArchived)) as unknown as Agent[];
  }
  archived(id: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM archives WHERE agentId=?').get(this.agent(id).id)); }
  archiveAgent(id: string): void {
    const agent = this.agent(id);
    if (this.assistantChannel(agent.id)) throw new Error('Channel assistants cannot be removed; their context is permanent');
    this.atomic(() => {
      this.db.prepare('INSERT OR IGNORE INTO archives VALUES(?,?)').run(agent.id, new Date().toISOString());
      this.pause(agent.id, true);
      this.db.prepare('DELETE FROM members WHERE agentId=?').run(agent.id);
      this.db.prepare("UPDATE deliveries SET state='cancelled',error='Agent archived' WHERE agentId=? AND state IN ('queued','failed','interrupted')").run(agent.id);
    });
  }
  memorySearch(readerId: string, query: string, channelId?: string): { id: string; channel: string; agent: string; excerpt: string }[] {
    validText(query, 'Memory query', 200);
    if (this.archived(readerId)) throw new Error('Archived Agents cannot search memory');
    const terms = query.trim().split(/\s+/).slice(0, 8);
    // shortcut: bounded SQL search over preserved originals; add FTS when workspace history becomes large.
    const rows = this.db.prepare(`SELECT m.id,m.text,a.name,c.name AS channel FROM messages m
      JOIN archives r ON r.agentId=m.sender JOIN agents a ON a.id=m.sender JOIN channels c ON c.id=m.channelId
      WHERE m.channelId IN (SELECT channelId FROM members WHERE agentId=?) AND (? IS NULL OR m.channelId=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) term WHERE
        instr(lower(m.text),lower(term.value))=0 AND instr(lower(a.name),lower(term.value))=0 AND instr(lower(a.role),lower(term.value))=0)
      ORDER BY m.seq DESC LIMIT 5`).all(readerId, channelId ?? null, channelId ?? null, JSON.stringify(terms));
    return rows.map(row => {
      const text = String(row.text), index = text.toLowerCase().indexOf(terms[0].toLowerCase());
      const start = Math.max(0, index - 100);
      return { id: String(row.id), channel: String(row.channel), agent: String(row.name), excerpt: `${start ? '…' : ''}${text.slice(start, start + 600)}${text.length > start + 600 ? '…' : ''}` };
    });
  }
  memoryRead(readerId: string, messageId: string): Message {
    const message = this.message(messageId);
    if (this.archived(readerId) || !message.channelId || message.sender === 'human' || !this.archived(message.sender) ||
        !this.members(message.channelId).some(a => a.id === readerId)) throw new Error('Memory is not shared with this Agent');
    return message;
  }
  agent(id: string): Agent {
    // SAFETY: the SELECT uses the versioned agents schema.
    const a = this.db.prepare('SELECT * FROM agents WHERE id=? OR name=?').get(id, id) as unknown as Agent | undefined;
    if (!a) throw new Error(`Unknown agent: ${id}`);
    return a;
  }
  agentOrdinal(id: string): number {
    // Archived rows remain, so insertion order is stable across restarts and new Agents.
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE rowid < (SELECT rowid FROM agents WHERE id=?)').get(this.agent(id).id)?.n);
  }
  createAgent(input: NewAgent): Agent {
    if (this.agents().length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} unarchived Agents per workspace; archive completed workers first`);
    validName(input.name); validText(input.role, 'Role', 8000);
    validText(input.provider, 'Provider', 128); validText(input.model, 'Model', 256);
    const tools = input.tools ?? 'code';
    if (!['chat', 'read', 'code'].includes(tools)) throw new Error('Unknown tool profile');
    const cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error('Working directory must be a directory');
    const context = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
    const id = randomUUID();
    this.db.prepare('INSERT INTO agents(id,name,role,provider,model,cwd,tools) VALUES(?,?,?,?,?,?,?)')
      .run(id, input.name, input.role, input.provider, input.model, cwd, tools);
    this.setSetting(`agent-context:${id}`, JSON.stringify(context));
    return this.agent(id);
  }
  inheritsModel(id: string): boolean { return this.getSetting(`inherit-model:${id}`) === 'true'; }
  setAgentModel(id: string, model?: ModelChoice): void {
    this.agent(id);
    const home = this.assistantChannel(id);
    if (home) throw new Error(`Use /models in #${home.name} to configure its assistant`);
    if (model) { validText(model.provider, 'Provider', 128); validText(model.id, 'Model', 256); }
    this.atomic(() => {
      if (model) this.db.prepare('UPDATE agents SET provider=?,model=? WHERE id=?').run(model.provider, model.id, id);
      this.setSetting(`inherit-model:${id}`, String(!model));
    });
  }
  channelModel(id: string): ModelChoice | undefined {
    this.channel(id);
    let value: unknown;
    try { value = JSON.parse(this.getSetting(`channel-model:${id}`) ?? 'null'); }
    catch (cause) { throw new Error(`Invalid saved channel model for ${id}`, { cause }); }
    if (value === null) return undefined;
    if (typeof value !== 'object' || !('provider' in value) || typeof value.provider !== 'string' ||
        !('id' in value) || typeof value.id !== 'string') throw new Error('Invalid saved channel model');
    validText(value.provider, 'Provider', 128); validText(value.id, 'Model', 256);
    return { provider: value.provider, id: value.id };
  }
  setChannelModel(id: string, model?: ModelChoice): void {
    this.channel(id);
    if (model) { validText(model.provider, 'Provider', 128); validText(model.id, 'Model', 256); }
    this.setSetting(`channel-model:${id}`, JSON.stringify(model ?? null));
  }
  modelFor(agent: Agent, channelId: string | null, piDefault?: ModelChoice): ModelChoice {
    const own = { provider: agent.provider, id: agent.model };
    const home = this.assistantChannel(agent.id);
    if (!home && !this.inheritsModel(agent.id)) return own;
    const source = home?.id ?? channelId;
    const channel = source ? this.channelModel(source) : undefined;
    return channel ?? piDefault ?? own;
  }
  thinkingLevel(kind: 'channel' | 'agent', id: string): ThinkingLevel | undefined {
    const target = kind === 'channel' ? this.channel(id) : this.agent(id);
    const value = this.getSetting(`thinking:${kind}:${target.id}`);
    if (value === undefined) return;
    const level = THINKING_LEVELS.find(level => level === value);
    if (!level) throw new Error(`Invalid saved thinking level: ${value}`);
    return level;
  }
  setThinkingLevel(kind: 'channel' | 'agent', id: string, level?: ThinkingLevel): void {
    const target = kind === 'channel' ? this.channel(id) : this.agent(id);
    const home = kind === 'agent' ? this.assistantChannel(target.id) : undefined;
    if (home) { this.setThinkingLevel('channel', home.id, level); return; }
    if (level !== undefined && !THINKING_LEVELS.includes(level)) throw new Error('Invalid thinking level');
    const key = `thinking:${kind}:${target.id}`;
    if (level === undefined) this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    else this.setSetting(key, level);
  }
  thinkingFor(agent: Agent, channelId: string | null, piDefault: ThinkingLevel = 'medium'): ThinkingLevel {
    const home = this.assistantChannel(agent.id);
    const own = home ? undefined : this.thinkingLevel('agent', agent.id);
    const source = home?.id ?? channelId;
    return own ?? (source ? this.thinkingLevel('channel', source) : undefined) ?? piDefault;
  }
  setSession(id: string, file: string): void { this.db.prepare('UPDATE agents SET sessionFile=? WHERE id=?').run(file, id); }
  pause(id: string, paused: boolean): void { this.agent(id); this.db.prepare('UPDATE agents SET paused=? WHERE id=?').run(Number(paused), id); }
  channels(): Channel[] {
    // SAFETY: the SELECT uses the versioned channels schema.
    return this.db.prepare('SELECT * FROM channels ORDER BY name').all() as unknown as Channel[];
  }
  channel(id: string): Channel {
    const c = this.channels().find(c => c.id === id || c.name === id);
    if (!c) throw new Error(`Unknown channel: ${id}`);
    return c;
  }
  createChannel(name: string): Channel {
    validName(name);
    const c = { id: randomUUID(), name };
    this.db.prepare('INSERT INTO channels VALUES(?,?)').run(c.id, c.name);
    return c;
  }
  channelAssistant(channelId: string): Agent | undefined {
    const row = this.db.prepare('SELECT agentId FROM channel_assistants WHERE channelId=?').get(this.channel(channelId).id);
    return row ? this.agent(String(row.agentId)) : undefined;
  }
  assistantChannel(agentId: string): Channel | undefined {
    const row = this.db.prepare('SELECT channelId FROM channel_assistants WHERE agentId=?').get(agentId);
    return row ? this.channel(String(row.channelId)) : undefined;
  }
  ensureChannelAssistant(channelId: string, cwd: string, model: ModelChoice): Agent {
    const channel = this.channel(channelId);
    const existing = this.channelAssistant(channel.id);
    if (existing) return existing;
    return this.atomic(() => {
      const base = `${channel.name.slice(0, 22)}-assistant`;
      let name = base;
      while (this.agents(true).some(a => a.name === name)) name = `${base.slice(0, 23)}-${randomUUID().slice(0, 8)}`;
      const agent = this.createAgent({ name, cwd, provider: model.provider, model: model.id,
        role: `The dedicated assistant for #${channel.name}. Help humans and peer Agents, answer questions, and coordinate only when needed.` });
      this.db.prepare('INSERT INTO channel_assistants VALUES(?,?)').run(channel.id, agent.id);
      this.db.prepare('INSERT INTO members VALUES(?,?)').run(channel.id, agent.id);
      this.setSetting(`inherit-model:${agent.id}`, 'true');
      return agent;
    });
  }
  members(channelId: string): Agent[] {
    // SAFETY: a.* selects only columns from the versioned agents schema.
    return this.db.prepare('SELECT a.* FROM agents a JOIN members m ON a.id=m.agentId WHERE m.channelId=? ORDER BY a.name').all(channelId) as unknown as Agent[];
  }
  setMembers(channelId: string, ids: string[]): void {
    this.channel(channelId); ids.forEach(id => {
      this.agent(id);
      if (this.archived(id)) throw new Error('Archived Agents cannot join channels');
      const home = this.assistantChannel(id);
      if (home && home.id !== channelId) throw new Error('A channel assistant belongs only to its own channel');
    });
    const assistant = this.channelAssistant(channelId);
    const members = assistant ? [...ids, assistant.id] : ids;
    this.atomic(() => {
      this.db.prepare('DELETE FROM members WHERE channelId=?').run(channelId);
      for (const id of new Set(members)) this.db.prepare('INSERT INTO members VALUES(?,?)').run(channelId, id);
    });
  }
  sharedChannel(a: string, b: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM members a JOIN members b ON a.channelId=b.channelId WHERE a.agentId=? AND b.agentId=? LIMIT 1').get(a, b));
  }
  workerRequests(): WorkerRequest[] {
    // SAFETY: rows follow the versioned worker_requests schema; only host-validated requests are written.
    return this.db.prepare('SELECT * FROM worker_requests ORDER BY rowid').all() as unknown as WorkerRequest[];
  }
  addWorkerRequest(request: WorkerRequest): void {
    this.db.prepare('INSERT INTO worker_requests VALUES(?,?,?,?,?,?,?,?,?,?)').run(request.id, request.channelId, request.assistantId,
      request.chainId, request.name, request.role, request.task, request.tools, request.state, request.agentId);
  }
  finishWorkerRequest(id: string, state: WorkerRequest['state'], agentId: string | null = null): void {
    this.db.prepare('UPDATE worker_requests SET state=?,agentId=? WHERE id=?').run(state, agentId, id);
  }
  getSetting(key: string): string | undefined { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value as string | undefined; }
  setSetting(key: string, value: string): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }

  post(input: Omit<Message, 'seq' | 'created'>, recipients: string[]): Message {
    validText(input.text, 'Message');
    return this.atomic(() => {
      // SAFETY: the SELECT uses the versioned messages schema.
      const existing = this.db.prepare('SELECT * FROM messages WHERE id=?').get(input.id) as unknown as Message | undefined;
      if (existing) {
        if (JSON.stringify([existing.sender, existing.target, existing.channelId, existing.text, existing.chainId]) !==
            JSON.stringify([input.sender, input.target, input.channelId, input.text, input.chainId])) throw new Error('Message ID conflict');
        return existing;
      }
      this.db.prepare('INSERT OR IGNORE INTO chains(id) VALUES(?)').run(input.chainId);
      this.db.prepare('INSERT INTO messages(id,channelId,sender,target,text,chainId,created) VALUES(?,?,?,?,?,?,?)')
        .run(input.id, input.channelId, input.sender, input.target, input.text, input.chainId, new Date().toISOString());
      for (const id of new Set(recipients)) this.db.prepare("INSERT INTO deliveries VALUES(?,?,?,'queued',NULL)").run(randomUUID(), input.id, id);
      return this.message(input.id);
    });
  }
  message(id: string): Message {
    // SAFETY: the SELECT uses the versioned messages schema.
    const m = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as Message | undefined;
    if (!m) throw new Error(`Unknown message: ${id}`);
    return m;
  }
  messages(channelId: string | null, agentId?: string): Message[] {
    // SAFETY: both queries select the versioned messages schema.
    return (channelId
      ? this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE channelId=? ORDER BY seq DESC LIMIT 300) ORDER BY seq').all(channelId)
      : this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE channelId IS NULL AND (target=? OR sender=?) ORDER BY seq DESC LIMIT 300) ORDER BY seq').all(agentId!, agentId!)) as unknown as Message[];
  }
  unreadCount(channelId: string, afterSeq: number): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channelId=? AND seq>?').get(channelId, afterSeq)?.n);
  }
  lastMessageSeq(channelId: string): number {
    return Number(this.db.prepare('SELECT seq FROM messages WHERE channelId=? ORDER BY seq DESC LIMIT 1').get(channelId)?.seq ?? 0);
  }
  deliveryCount(states: readonly string[], agentId?: string): number {
    if (!states.length) return 0;
    const sql = agentId ? 'SELECT COUNT(*) AS n FROM deliveries WHERE state IN (SELECT value FROM json_each(?)) AND agentId=?'
      : 'SELECT COUNT(*) AS n FROM deliveries WHERE state IN (SELECT value FROM json_each(?))';
    return Number(this.db.prepare(sql).get(JSON.stringify(states), ...(agentId ? [agentId] : []))?.n);
  }
  messageDeliveries(messageIds: string[]): Delivery[] {
    if (!messageIds.length) return [];
    // SAFETY: SELECT reads the versioned deliveries schema; IDs are bound parameters.
    return this.db.prepare('SELECT * FROM deliveries WHERE messageId IN (SELECT value FROM json_each(?)) ORDER BY rowid')
      .all(JSON.stringify(messageIds)) as unknown as Delivery[];
  }
  deliveries(agentId?: string, states?: readonly string[]): Delivery[] {
    if (states?.length === 0) return [];
    const rows = states ? (agentId
      ? this.db.prepare('SELECT * FROM deliveries WHERE agentId=? AND state IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(agentId, JSON.stringify(states))
      : this.db.prepare('SELECT * FROM deliveries WHERE state IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(JSON.stringify(states)))
      : agentId ? this.db.prepare('SELECT * FROM deliveries WHERE agentId=? ORDER BY rowid').all(agentId)
      : this.db.prepare('SELECT * FROM deliveries ORDER BY rowid').all();
    // SAFETY: SELECT reads the versioned deliveries schema; filters are bound parameters.
    return rows as unknown as Delivery[];
  }
  claim(id: string): boolean {
    return this.atomic(() => {
      const row = this.db.prepare(`SELECT d.state,a.paused,m.chainId,c.used,c.budget FROM deliveries d
        JOIN agents a ON a.id=d.agentId JOIN messages m ON m.id=d.messageId JOIN chains c ON c.id=m.chainId WHERE d.id=?`).get(id);
      if (!row || row.state !== 'queued' || row.paused || Number(row.used) >= Number(row.budget)) return false;
      this.db.prepare('UPDATE chains SET used=used+1 WHERE id=?').run(row.chainId!);
      this.finish(id, 'running');
      return true;
    });
  }
  finish(id: string, state: string, error: string | null = null): void {
    this.db.prepare('UPDATE deliveries SET state=?,error=? WHERE id=?').run(state, error, id);
  }
  extendChain(chainId: string): void { this.db.prepare('UPDATE chains SET budget=budget+12 WHERE id=?').run(chainId); }
  chainExhausted(chainId: string): boolean {
    const c = this.db.prepare('SELECT used,budget FROM chains WHERE id=?').get(chainId);
    return Boolean(c && Number(c.used) >= Number(c.budget));
  }
  context(agentId: string, message: Message): Message[] {
    if (!message.channelId) return [message];
    const last = this.db.prepare('SELECT seq FROM cursors WHERE agentId=? AND channelId=?').get(agentId, message.channelId)?.seq ?? 0;
    // SAFETY: the SELECT uses the versioned messages schema.
    const messages = this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE channelId=? AND seq>? AND seq<=? ORDER BY seq DESC LIMIT 12) ORDER BY seq')
      .all(message.channelId, last, message.seq) as unknown as Message[];
    this.db.prepare('INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(agentId,channelId) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(agentId, message.channelId, message.seq);
    return messages.some(m => m.id === message.id) ? messages : [message];
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); }
    finally { if (existsSync(this.lock)) unlinkSync(this.lock); }
  }
}
