# Pi Agent UI Recreation Brief

Use this as a visual and interaction specification for recreating the Pi coding agent interface or building a Pi-inspired interface in another app. Match the current installed theme, not a generic purple developer dashboard.

## 1. Theme inventory

Pi's built-in themes are:

| Theme | Behavior |
|---|---|
| `system` | Default when no theme is selected; derives colors from the terminal and follows its light/dark appearance. |
| `dark` | Pi's built-in dark palette. **This is the theme selected in the inspected installation.** |
| `light` | Pi's built-in light palette. |

Pi can also load custom themes from the user theme directory, a trusted project, or a package. No custom theme file was found in the inspected user configuration. The current preference is `"theme": "dark"` in `~/.pi/agent/settings.json`.

## 2. Visual direction

- **Mood:** calm, focused developer tool; understated dark terminal, cool lavender/violet accents, high-contrast text, restrained use of color.
- **Canvas:** terminal background is the canvas. Do not add a second large page background or put every message inside a card.
- **Typography:** monospace for the whole interface. Keep headings compact; use bold and color for hierarchy rather than large type.
- **Spacing:** tight, consistent vertical rhythm; use whitespace and thin rules to separate regions.
- **Surfaces:** mostly flat. Use a subtle tinted fill only for selected rows, user messages, tool states, and focused/important content. Avoid gradients, glossy effects, drop shadows, rounded “consumer app” cards, and bright neon accents.
- **Color use:** accent color is a signal, not decoration. Keep body text neutral; use muted/dim text for descriptions and keyboard hints.

## 3. Dark palette reference

Values below are copied from Pi's installed `dark` theme. Pi stores these as OKHSL; keep the semantic roles and convert appropriately if the target renderer does not support OKHSL.

| Role | Value |
|---|---|
| Main text | `okhsl(234 3% 89%)` |
| Muted text | `okhsl(229 6% 67%)` |
| Dim text | `okhsl(229 8% 56%)` |
| Accent / violet | `okhsl(295 50% 67%)` |
| Normal border | `okhsl(231 57% 65%)` |
| Accent border | `okhsl(295 53% 64%)` |
| Muted border | `okhsl(229 8% 53%)` |
| Selection / user-message background | `okhsl(233 41% 24%)` |
| Custom-message background | `okhsl(295 42% 24%)` |
| Pending tool background | `okhsl(229 5% 24%)` |
| Successful tool background | `okhsl(158 46% 25%)` |
| Error tool background | `okhsl(19 54% 25%)` |
| Success text | `okhsl(159 59% 67%)` |
| Error text | `okhsl(20 72% 67%)` |
| Warning text | `okhsl(83 88% 67%)` |
| Link / blue | `okhsl(232 54% 67%)` |

Keep the terminal's own background rather than inventing a new global background color. The theme defines semantic UI colors, not a complete opaque page surface.

## 4. Layout and component rules

### Main workspace

- Use a single-column conversation/transcript that takes the available width.
- Keep assistant prose on the base canvas; separate turns with spacing, not large containers.
- Give user messages a restrained dark-blue tint and readable foreground.
- Render tool activity as compact blocks: clear tool title, subdued output, and a subtle state tint for pending/success/error.
- Keep the editor/input area visually distinct with a thin rule or focused border. Show mode/status and key hints in dim text.
- Preserve vertical space for the transcript; avoid persistent sidebars unless the target product explicitly needs them.

### Dialogs and selectors

- Use keyboard-first behavior: arrow keys move, `Enter` confirms, `Esc` cancels. Always show concise key hints.
- Selected rows use a left arrow (`→`) and the dark-blue `selectedBg`; unselected rows stay on the base canvas with muted descriptions.
- Use a bold accent title, normal-weight body copy, muted supporting copy, and dim footer hints.
- Prefer a thin single-line border over heavy framing. Pi's built-in selectors commonly use full-width horizontal rules (`─`) above and below the content rather than a floating card.
- If the recreated target specifically needs a **closed boxed dialog**, use a square-corner, one-cell outline: muted border at rest, accent border when focused, modest inner padding, and no shadow. Keep this as an adaptation—the native selector treatment is generally open/full-width, not a raised web modal.
- Constrain dialog width to the available viewport, truncate or wrap long labels safely, and keep cancel/confirm actions discoverable.

### Suggested dialog composition

```text
────────────────────────────────────────────
  Choose an option

  → First option     Short description
    Second option    Short description

  ↑/↓ move · Enter select · Esc cancel
────────────────────────────────────────────
```

For a boxed-card adaptation, keep the same typography and hierarchy but close the left/right edges with a subtle one-cell border. Do not add a drop shadow.

## 5. Implementation and quality requirements

- Use semantic theme tokens (accent, border, muted, dim, selected, success, warning, error) instead of hard-coding colors at each component.
- If implementing in a terminal, measure visible terminal columns—not raw string length—and handle ANSI escapes, wide characters, emoji, and narrow terminal widths.
- Reflow or truncate content when resized; no line may exceed the viewport.
- Maintain readable contrast and do not communicate status by color alone.
- Keep focus visible and provide a keyboard route for every action; mouse support is optional.
- Reuse the target platform's dialog/list components where possible instead of building a parallel UI system.

## 6. Acceptance checklist

- [ ] The result feels like a dark, monospace coding-agent terminal—not a generic dashboard.
- [ ] Violet/lavender is the restrained accent; selection and user-message fills are dark blue.
- [ ] Main content remains mostly unboxed; dialogs use thin rules or a subtle square frame.
- [ ] Selected rows, secondary text, tool states, and keyboard hints have distinct hierarchy.
- [ ] Dialogs remain usable at narrow widths and support keyboard confirm/cancel.
- [ ] No gradients, heavy shadows, unnecessary cards, or color-only status cues.

## References

- Installed Pi theme setting: `~/.pi/agent/settings.json`
- Installed dark palette: `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json`
- Pi theme guide: `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/themes.md`
- Pi terminal UI guide: `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
