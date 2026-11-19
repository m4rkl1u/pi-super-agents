import {
  createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultPackageManager, DefaultResourceLoader,
  getAgentDir, loadProjectContextFiles, ProjectTrustStore, SettingsManager,
  type ExtensionFactory, type KeybindingsManager, type PromptTemplate, type Skill,
} from '@earendil-works/pi-coding-agent';

const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
// shortcut: Pi 1.5.0 does not export these helpers; recheck these imports when upgrading Pi.
const { clearExtensionCache } = await import(new URL('./core/extensions/loader.js', sdk).href) as { clearExtensionCache(): void };
export const { expandPromptTemplate } = await import(new URL('./core/prompt-templates.js', sdk).href) as {
  expandPromptTemplate(text: string, templates: PromptTemplate[]): string;
};
const { KeybindingsManager: NativeKeybindings } = await import(new URL('./core/keybindings.js', sdk).href) as {
  KeybindingsManager: { create(agentDir?: string): KeybindingsManager };
};
export const createPiKeybindings = (agentDir?: string): KeybindingsManager => NativeKeybindings.create(agentDir);
export const { resolveToCwd, resolveReadPath } = await import(new URL('./core/tools/path-utils.js', sdk).href) as {
  resolveToCwd(path: string, cwd: string): string;
  resolveReadPath(path: string, cwd: string): string;
};

export function resourceSettings(cwd: string, agentDir = getAgentDir()): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  settings.setProjectTrusted(new ProjectTrustStore(agentDir).get(cwd) ?? settings.getDefaultProjectTrust() === 'always');
  return settings;
}

let loading: Promise<unknown> = Promise.resolve();
export function loadResources(cwd: string, systemPrompt: string, code: boolean, tools: string[], skills: Skill[], agentDir: string, guard: ExtensionFactory) {
  const job = loading.then(async () => {
    const source = resourceSettings(cwd, agentDir);
    const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: source,
      builtinExtensions: code ? ['mcp', 'codemode', 'tool-search'] : [] });
    const paths = await packages.resolve(async () => 'skip');
    const enabled = (resources: typeof paths.skills) => resources.filter(p => p.enabled).map(p => p.path);
    // Settings are session-local; resolving only installed paths never downloads or changes Pi settings.
    const settings = SettingsManager.inMemory({ ...source.getSettings(), packages: [], extensions: [], skills: [], prompts: [], themes: [],
      defaultTools: tools, cacheWarming: 'off', enableAnalytics: false }, { projectTrusted: source.isProjectTrusted() });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: code ? enabled(paths.extensions) : [],
      additionalSkillPaths: [...new Set([...enabled(paths.skills), ...skills.map(s => s.filePath)])],
      additionalPromptTemplatePaths: enabled(paths.prompts), additionalThemePaths: enabled(paths.themes),
      extensionFactories: [
        ...(code ? [
          { name: 'mcp', builtin: true, replaceable: true, factory: createMcpExtension() },
          { name: 'codemode', builtin: true, replaceable: true, factory: createCodemodeExtension() },
          { name: 'tool-search', builtin: true, replaceable: true, factory: createToolSearchExtension() },
        ] : []),
        { name: 'workspace-files', factory: guard },
      ],
      systemPrompt, agentsFilesOverride: () => ({ agentsFiles: loadProjectContextFiles({ cwd, agentDir }) }),
    });
    // Native factory caching otherwise shares module-level plugin state across Agents in the same cwd.
    clearExtensionCache();
    await loader.reload();
    if (!loader.getExtensions().extensions.some(extension => extension.path === '<inline:workspace-files>')) throw new Error('Workspace file guard failed to load');
    for (const failure of paths.installFailures ?? []) loader.getExtensions().errors.push({ path: failure.source, error: 'Package is not installed; install it with Pi before restarting super-agents.' });
    return { loader, settings };
  });
  loading = job.catch(() => {});
  return job;
}
