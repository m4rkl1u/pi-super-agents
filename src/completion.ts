import {
  CombinedAutocompleteProvider, fuzzyFilter, type AutocompleteProvider, type SlashCommand,
} from '@earendil-works/pi-tui';
import type { Skill } from '@earendil-works/pi-coding-agent';
import { safeText } from './render.js';

export const commands: SlashCommand[] = [
  { name: 'agent', description: 'Create an Agent' },
  { name: 'channel', description: 'Create a group' },
  { name: 'members', description: 'Search/toggle group members', argumentHint: 'alice,bob (optional)' },
  { name: 'switch', description: 'Search conversations', argumentHint: '#group or @agent (optional)' },
  { name: 'context', description: 'Toggle actual model context' },
  { name: 'tools', description: 'Expand tool output' },
  { name: 'models', description: 'Search/set group or Agent model' },
  { name: 'thinking', description: 'Set thinking effort · Shift+Tab cycles', argumentHint: 'level or inherit (optional)' },
  { name: 'remove', description: 'Archive worker; preserve public memory', argumentHint: '@agent (optional)' },
  { name: 'memory', description: 'Search archived public results', argumentHint: 'keywords' },
  { name: 'autonomy', description: 'Worker creation approval and permissions' },
  { name: 'approve', description: 'Approve or reject worker proposals' },
  { name: 'stop', description: 'Stop and pause this Agent' },
  { name: 'resume', description: 'Resume this Agent' },
  { name: 'continue', description: 'Allow 12 more collaboration turns' },
  { name: 'retry', description: 'Replay a delivery after confirmation', argumentHint: 'DELIVERY_ID' },
  { name: 'pause', description: 'Pause/resume scheduling' },
  { name: 'stop-all', description: 'Stop all Agents' },
  { name: 'help', description: 'Commands and keyboard shortcuts' },
  { name: 'quit', description: 'Stop work and exit' },
];
interface AgentSuggestion { name: string; description: string }

export function workspaceCompletion(cwd: string, skills: Skill[], agents: () => AgentSuggestion[], extra: () => Promise<SlashCommand[]> = async () => []): AutocompleteProvider {
  const provider = new CombinedAutocompleteProvider([
    ...commands,
    ...skills.filter(skill => skill.name === safeText(skill.name))
      .map(skill => ({ name: `skill:${skill.name}`, description: safeText(skill.description) })),
  ], cwd);
  return {
    triggerCharacters: ['/', '@'],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.signal.aborted) return null;
      const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const mention = /(?:^|[\s([{])(@[a-z0-9_-]*)$/i.exec(before)?.[1];
      if (mention) {
        const items = fuzzyFilter(agents(), mention.slice(1), agent => agent.name).map(agent => ({
          value: `@${agent.name}`, label: `@${agent.name}`, description: safeText(agent.description),
        }));
        return items.length ? { items, prefix: mention } : null;
      }
      // Use Pi's slash/skill matching, but never its @file or filesystem completion here.
      if (cursorLine === 0 && /^\/[^\s/]*$/.test(before)) {
        const additions = await extra();
        if (options.signal.aborted) return null;
        const seen = new Set(commands.map(c => c.name));
        const merged = new CombinedAutocompleteProvider([...commands, ...[
          ...additions, ...skills.map(s => ({ name: `skill:${s.name}`, description: s.description })),
        ].filter(c => {
          if (seen.has(c.name) || c.name !== safeText(c.name)) return false;
          seen.add(c.name); return true;
        }).map(c => ({ ...c, description: safeText(c.description ?? '') }))], cwd);
        return merged.getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false });
      }
      return null;
    },
    applyCompletion: (lines, line, col, item, prefix) => provider.applyCompletion(lines, line, col, item, prefix),
  };
}
