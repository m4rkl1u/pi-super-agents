#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { type ModelRuntime, type Skill } from '@earendil-works/pi-coding-agent';
import { discoverSkills } from './skills.js';
import { resourceSettings } from './pi-resources.js';
import { colorTable } from './agent-colors.js';
import { Store } from './store.js';
import { Workspace, type Runner } from './workspace.js';
import { DemoRunner } from './demo-runner.js';
import { WorkspaceUI, type ModelChoice } from './ui.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { demo: { type: 'boolean' }, workspace: { type: 'string' }, models: { type: 'boolean' }, colors: { type: 'boolean' }, version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('super-agents — Pi Agent Workspace\n\nUsage: super-agents [--workspace PATH] [--demo] [--models] [--colors]\n       npm start -- [options] (from source)\n\n--colors     List all 255 Agent colors and exit (no credentials or model calls)\n--demo       Local simulation; no model calls or credential access\n--workspace  Project directory (default: current directory)\n--models     List configured available models and exit\n--version, -v  Print the installed version and exit\n--help, -h     Show this help\n\nState: ~/.pi-workspaces/ (demo: ~/.pi-workspaces/demo/)\nOne super-agents instance per user; all launch directories share the same workspace.\nF2 creates an Agent; F3 creates a group; /help lists controls.');
    return;
  }
  if (values.version) {
    const { version } = createRequire(import.meta.url)('../../package.json');
    console.log(`super-agents ${version}`);
    return;
  }
  if (values.colors) { console.log(colorTable().join('\n')); return; }
  const cwd = realpathSync(resolve(values.workspace ?? process.cwd()));
  if (!statSync(cwd).isDirectory()) throw new Error('Workspace must be a directory');
  if (!values.models && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('An interactive terminal is required. Use --help or --models for non-interactive output.');
  const models: ModelChoice[] = [];
  const settings = resourceSettings(cwd);
  let skills: Skill[] = [];
  let defaultModel: ModelChoice | undefined;
  let runtime: ModelRuntime | undefined;
  let makeRunner: (store: Store) => Runner;
  if (values.demo) {
    defaultModel = { provider: 'demo', id: 'local' }; models.push(defaultModel);
    makeRunner = store => new DemoRunner(store);
  } else {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { PiRunner } = await import('./pi-runner.js');
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    runtime = modelRuntime;
    models.push(...(await modelRuntime.getAvailable()).map(m => ({ provider: m.provider, id: m.id })));
    defaultModel = models.find(m => m.provider === settings.getDefaultProvider() && m.id === settings.getDefaultModel()) ?? models[0];
    makeRunner = store => new PiRunner(store, modelRuntime, [], defaultModel, settings);
  }
  if (values.models) { console.log(models.map(m => `${m.provider}/${m.id}`).join('\n') || 'No available models. Configure Pi credentials first.'); return; }
  if (values.demo) skills = await discoverSkills(cwd);
  const stateDir = join(homedir(), '.pi-workspaces');
  const store = new Store(values.demo ? join(stateDir, 'demo') : stateDir, stateDir);
  const workspace = new Workspace(store, makeRunner(store));
  let ui: WorkspaceUI | undefined;
  let quit: () => void = () => {};
  const onSignal = () => quit();
  try {
    if (values.demo && !store.agents().length) {
      const members = ['alice', 'bob'].map(name => store.createAgent({ name, role: 'Demo collaborator', provider: 'demo', model: 'local', cwd }).id);
      const channel = store.channels()[0]; store.setMembers(channel.id, members);
      // Seed display-only history without waking the new channel assistant.
      store.post({ id: 'demo-welcome', channelId: channel.id, sender: 'human', target: null,
        text: 'Welcome! Talk to the channel assistant, or try: `@alice 协作检查这个设计`', chainId: 'demo-welcome' }, []);
    }
    await new Promise<void>(done => {
      quit = done;
      ui = new WorkspaceUI(workspace, new ProcessTerminal(), { demo: Boolean(values.demo), models, defaultModel, runtime, settings, skills, theme: settings.getTheme(), cwd, onQuit: done });
      process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
      ui.start();
    });
  } finally {
    try {
      try { await ui?.tui.terminal.drainInput(1000); }
      finally { ui?.stop(); }
    } finally {
      try { await workspace.close(); }
      finally { store.close(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
    }
  }
}
main().catch(error => { console.error(`Workspace: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
