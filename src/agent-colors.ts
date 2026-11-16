import { colorToHex, getTerminalColorMode, oklchColor, styleText } from '@earendil-works/pi-tui';

// Spread adjacent speakers across hues; moderate lightness works for light/dark accents.
export const AGENT_COLORS = Array.from({ length: 255 }, (_, index) =>
  oklchColor(0.58 + Math.floor(index / 85) * 0.04, 0.12, ((index * 32) % 85) * 360 / 85));

export function agentInk(index: number): (text: string) => string {
  // shortcut: reuse colors after 255 identities; names remain visible at any workspace size.
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  return text => styleText(text, { fg: color }, getTerminalColorMode());
}

export function colorTable(): string[] {
  return AGENT_COLORS.map((color, index) => `${String(index + 1).padStart(3, '0')}  ${colorToHex(color)}  ${agentInk(index)('████ Agent')}`);
}
