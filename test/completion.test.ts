import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDir, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { discoverSkills, expandSkill, invokedSkill } from '../src/skills.js';
import { workspaceCompletion } from '../src/completion.js';

function skill(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\ndisable-model-invocation: true\n---\nSKILL_BODY_MARKER\nRead ./reference.md.`);
}

test('discover installed user, project and package skills without changing settings', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'project'), agentDir = join(dir, 'agent'), pkg = join(dir, 'package');
  skill(join(cwd, '.pi', 'skills', 'project-fixture'), 'project-fixture');
  skill(join(agentDir, 'skills', 'user-fixture'), 'user-fixture');
  skill(join(pkg, 'skills', 'package-fixture'), 'package-fixture');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', pi: { skills: ['skills'] } }));
  const settings = JSON.stringify({ packages: [pkg] });
  writeFileSync(join(agentDir, 'settings.json'), settings);
  const untrusted = await discoverSkills(cwd, agentDir);
  assert.ok(!untrusted.some(s => s.name === 'project-fixture'), 'unknown projects must not load local skills');
  new ProjectTrustStore(agentDir).set(cwd, true);
  const skills = await discoverSkills(cwd, agentDir);
  for (const name of ['project-fixture', 'user-fixture', 'package-fixture']) assert.ok(skills.some(s => s.name === name), name);
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), settings);
});

test('explicit skill expansion preserves relative references, strips frontmatter and rejects unknown or missing skills', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-workspace-skill-expand-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  skill(dir, 'review-fixture');
  const { skills } = loadSkillsFromDir({ dir, source: 'test' });
  const text = expandSkill('/skill:review-fixture inspect this', skills)!;
  assert.ok(text.includes('SKILL_BODY_MARKER'));
  assert.ok(text.includes(`References are relative to ${dir}.`));
  assert.ok(text.endsWith('inspect this')); assert.ok(!text.includes('disable-model-invocation:'));
  assert.equal(expandSkill('quoted /skill:review-fixture', skills), undefined);
  assert.throws(() => invokedSkill('/skill:unknown', skills), /Unknown skill/);
  const provider = workspaceCompletion(dir, [...skills, { ...skills[0], name: 'bad\x1b[31mname' }], () => []);
  const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal });
  assert.ok(suggestions?.items.some(item => item.value === 'skill:review-fixture'));
  assert.ok(suggestions?.items.every(item => !item.value.includes('\x1b')));
  rmSync(join(dir, 'SKILL.md'));
  assert.throws(() => expandSkill('/skill:review-fixture', skills), /ENOENT/);
});

test('completion uses Pi slash matching, live Agent names, and never treats @ as a file', async () => {
  const agents = [{ name: 'alice', description: 'idle' }];
  const provider = workspaceCompletion('/tmp', [], () => agents);
  const options = { signal: new AbortController().signal };
  const thinking = await provider.getSuggestions(['/think'], 0, 6, options);
  assert.equal(thinking?.items[0].value, 'thinking');
  const quit = await provider.getSuggestions(['/qui'], 0, 4, options);
  assert.equal(quit?.items[0].value, 'quit');
  assert.deepEqual(provider.applyCompletion(['/qui'], 0, 4, quit!.items[0], quit!.prefix), { lines: ['/quit '], cursorLine: 0, cursorCol: 6 });
  assert.equal(await provider.getSuggestions(['mail@ali'], 0, 8, options), null);
  assert.equal(await provider.getSuggestions(['./'], 0, 2, { ...options, force: true }), null);
  assert.equal(await provider.getSuggestions(['@/tmp'], 0, 5, options), null);
  agents.push({ name: 'bob', description: 'running' });
  const bob = await provider.getSuggestions(['hello @bo tail'], 0, 9, options);
  assert.equal(bob?.items[0].value, '@bob');
  assert.equal(provider.applyCompletion(['hello @bo tail'], 0, 9, bob!.items[0], bob!.prefix).lines[0], 'hello @bob  tail');
  assert.equal(await provider.getSuggestions(['/qui'], 0, 4, { signal: AbortSignal.abort() }), null);
});

test('native extension completions are live, cancelable and cannot shadow workspace commands', async () => {
  let additions = [{ name: 'todos', description: 'Agent todos' }, { name: 'quit', description: 'shadowed' }];
  const options = { signal: new AbortController().signal };
  const provider = workspaceCompletion('/tmp', [], () => [], async () => additions);
  const first = await provider.getSuggestions(['/'], 0, 1, options);
  assert.equal(first?.items.filter(x => x.value === 'quit').length, 1);
  assert.ok(first?.items.some(x => x.value === 'todos'));
  assert.ok(!first?.items.some(x => x.description === 'shadowed'));
  additions = [{ name: 'second-agent', description: 'Other view' }];
  const second = await provider.getSuggestions(['/'], 0, 1, options);
  assert.ok(second?.items.some(x => x.value === 'second-agent'));
  assert.ok(!second?.items.some(x => x.value === 'todos'));
  const controller = new AbortController();
  const aborted = workspaceCompletion('/tmp', [], () => [], async () => { controller.abort(); return additions; });
  assert.equal(await aborted.getSuggestions(['/'], 0, 1, { signal: controller.signal }), null);
});
