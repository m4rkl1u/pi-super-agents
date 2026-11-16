import { readFileSync } from 'node:fs';
import {
  DefaultPackageManager, getAgentDir, loadSkills, stripFrontmatter, type Skill,
} from '@earendil-works/pi-coding-agent';

import { resourceSettings } from './pi-resources.js';

export async function discoverSkills(cwd: string, agentDir = getAgentDir()): Promise<Skill[]> {
  const settingsManager = resourceSettings(cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  // Resolve only installed resources: no downloads, extension execution or settings writes.
  const paths = await packages.resolve(async () => 'skip');
  return loadSkills({ cwd, agentDir, includeDefaults: false,
    skillPaths: paths.skills.filter(resource => resource.enabled).map(resource => resource.path),
  }).skills;
}
export function invokedSkill(text: string, skills: Skill[]): Skill | undefined {
  if (!text.startsWith('/skill:')) return undefined;
  const name = text.slice('/skill:'.length).split(/\s/, 1)[0];
  const skill = skills.find(candidate => candidate.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}; type / to choose an installed skill`);
  return skill;
}
export function expandSkill(text: string, skills: Skill[]): string | undefined {
  const skill = invokedSkill(text, skills);
  if (!skill) return undefined;
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim();
  const args = text.slice(`/skill:${skill.name}`.length).trim();
  const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<skill name="${attribute(skill.name)}" location="${attribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>${args ? `\n\n${args}` : ''}`;
}
