import { ExtensionEditorComponent, type ExtensionUIContext, type ExtensionUIDialogOptions, type TerminalInputHandler } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, type Component, type Editor, type OverlayHandle, type TuiAltScreen } from '@earendil-works/pi-tui';
import { SetupDialog } from './dialog.js';
import { createPiKeybindings } from './pi-resources.js';

type Widget = Component & { dispose?(): void };
interface Host {
  tui: TuiAltScreen; editor: Editor;
  active(): string | undefined;
  busy(value?: boolean): boolean;
  notify(text: string): void;
  tools(value?: boolean): boolean;
}
interface State {
  widgets: Map<string, { component: Widget; placement: string }>;
  statuses: Map<string, string>;
  inputs: Set<TerminalInputHandler>;
  notice?: string;
}

/** Adapt Pi's extension UI without letting background Agents edit the foreground composer. */
export class ExtensionUI {
  private states = new Map<string, State>();
  private keybindings = createPiKeybindings();
  private cancel?: () => void;
  private closed = false;
  constructor(private host: Host) {}
  context(id: string, base: ExtensionUIContext): ExtensionUIContext {
    const state: State = { widgets: new Map(), statuses: new Map(), inputs: new Set() };
    this.release(id); this.states.set(id, state);
    const active = () => !this.closed && this.host.active() === id;
    const notify = (text: string) => { state.notice = text; if (active()) this.host.notify(text); };
    const unsupported = (name: string) => notify(`Extension UI ${name} is not supported by the workspace layout.`);
    const dialog = (title: string, initial: string, items?: string[], opts?: ExtensionUIDialogOptions) => {
      if (!active() || this.host.busy() || opts?.signal?.aborted) return Promise.resolve(undefined);
      let cancel = () => {};
      const result = this.custom<string | undefined>(id, base, (_tui, _theme, _keys, done) => {
        cancel = () => done(undefined);
        return new SetupDialog(title, initial, items?.map(value => ({ value, label: value })), () => this.host.tui.terminal.rows, done, () => this.host.tui.requestRender());
      });
      const timeout = opts?.timeout === undefined ? undefined : setTimeout(() => cancel(), opts.timeout);
      opts?.signal?.addEventListener('abort', cancel, { once: true });
      return result.finally(() => { clearTimeout(timeout); opts?.signal?.removeEventListener('abort', cancel); });
    };
    return {
      ...base,
      notify,
      select: (title, items, opts) => dialog(title, '', items, opts),
      confirm: async (title, message, opts) => (await dialog(`${title}\n${message}`, '', ['No', 'Yes'], opts)) === 'Yes',
      input: (title, placeholder, opts) => dialog(`${title}${placeholder ? `\n${placeholder}` : ''}`, '', undefined, opts),
      custom: (factory, options) => this.custom(id, base, factory, options),
      editor: (title, prefill) => active() && !this.host.busy() ? this.custom(id, base, (tui, _theme, keys, done) =>
        new ExtensionEditorComponent(tui, keys, title, prefill, done, () => done(undefined))) : Promise.resolve(undefined),
      onTerminalInput: handler => { state.inputs.add(handler); return () => { state.inputs.delete(handler); }; },
      setStatus: (key, text) => { if (text === undefined) state.statuses.delete(key); else state.statuses.set(key, text); this.host.tui.requestRender(); },
      setWidget: (key, content, options) => {
        state.widgets.get(key)?.component.dispose?.(); state.widgets.delete(key);
        if (!this.closed && content !== undefined) state.widgets.set(key, {
          component: typeof content === 'function' ? content(this.host.tui, base.theme) : new Text(content.join('\n'), 0, 0),
          placement: options?.placement ?? 'aboveEditor',
        });
        this.host.tui.requestRender();
      },
      setEditorText: text => { if (active()) { this.host.editor.setText(text); this.host.tui.requestRender(); } },
      pasteToEditor: text => { if (active()) { this.host.editor.insertTextAtCursor(text); this.host.tui.requestRender(); } },
      getEditorText: () => active() ? this.host.editor.getText() : '',
      getToolsExpanded: () => this.host.tools(),
      setToolsExpanded: value => { if (active()) this.host.tools(value); },
      setWorkingMessage: message => { if (message) notify(message); },
      setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
      setFooter: factory => { if (factory) unsupported('setFooter'); },
      setHeader: factory => { if (factory) unsupported('setHeader'); },
      setEditorComponent: factory => { if (factory) unsupported('setEditorComponent'); },
      addAutocompleteProvider: () => unsupported('addAutocompleteProvider'),
      setTitle: () => {},
      setTheme: () => ({ success: false, error: 'The workspace theme is shared; configure it in Pi and restart super-agents.' }),
    };
  }
  private custom<T>(id: string, base: ExtensionUIContext, factory: Parameters<ExtensionUIContext['custom']>[0], options?: Parameters<ExtensionUIContext['custom']>[1]): Promise<T> {
    if (this.closed || this.host.active() !== id || this.host.busy()) return Promise.reject(new Error('Select this Agent and close the current dialog before using its extension UI.'));
    this.host.busy(true);
    return new Promise<T>((resolve, reject) => {
      let component: Widget | undefined, overlay: OverlayHandle | undefined, settled = false;
      const finish = (value?: unknown, error?: unknown) => {
        if (settled) return;
        settled = true; overlay?.hide(); this.cancel = undefined; this.host.busy(false);
        try { component?.dispose?.(); } catch (disposeError) { error ??= disposeError; }
        this.host.tui.setFocus(this.host.editor); this.host.tui.requestRender();
        if (error) reject(error); else resolve(value as T);
      };
      this.cancel = () => finish();
      // A factory can resolve or throw synchronously, or finish loading after its view was closed.
      try {
        Promise.resolve(factory(this.host.tui, base.theme, this.keybindings, value => finish(value))).then(created => {
          if (settled) { created.dispose?.(); return; }
          component = created;
          const position = typeof options?.overlayOptions === 'function' ? options.overlayOptions() : options?.overlayOptions;
          overlay = this.host.tui.showOverlay(component, position ?? { width: '85%', anchor: 'center', margin: 1 });
          options?.onHandle?.(overlay); this.host.tui.requestRender();
        }).catch(error => finish(undefined, error));
      } catch (error) { finish(undefined, error); }
    });
  }
  select(): void {
    this.cancel?.();
    this.host.notify(this.states.get(this.host.active() ?? '')?.notice ?? 'Type / for commands & skills');
  }
  input(data: string): ReturnType<TerminalInputHandler> {
    for (const handler of this.states.get(this.host.active() ?? '')?.inputs ?? []) {
      try {
        const result = handler(data);
        if (result?.consume) return result;
        if (result?.data !== undefined) data = result.data;
      } catch (error) { this.host.notify(String(error)); }
    }
    return { data };
  }
  render(placement: string, width: number): string[] {
    const state = this.states.get(this.host.active() ?? '');
    if (!state) return [];
    const lines: string[] = [];
    for (const [key, widget] of state.widgets) {
      if (widget.placement !== placement) continue;
      try { lines.push(...widget.component.render(width)); }
      catch (error) {
        state.widgets.delete(key);
        try { widget.component.dispose?.(); } catch (disposeError) { this.host.notify(String(disposeError)); }
        this.host.notify(String(error));
      }
    }
    return lines.map(line => truncateToWidth(line, width));
  }
  status(): string { return [...(this.states.get(this.host.active() ?? '')?.statuses.values() ?? [])].join(' · '); }
  release(id: string): void {
    for (const widget of this.states.get(id)?.widgets.values() ?? []) {
      try { widget.component.dispose?.(); } catch (error) { this.host.notify(String(error)); }
    }
    this.states.delete(id);
  }
  close(): void {
    this.closed = true; this.cancel?.();
    for (const id of this.states.keys()) this.release(id);
  }
}
