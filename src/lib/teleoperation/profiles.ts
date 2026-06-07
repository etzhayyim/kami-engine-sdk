/**
 * Controller-family detection + raw-index mapping + on-screen glyphs.
 *
 * The raw button/axis indices follow the W3C "standard gamepad" mapping that
 * the browser Gamepad API normalizes PS5 / Xbox / Switch / Steam controllers
 * onto, so the index tables are shared; families differ in **detection** and
 * **glyphs** (the South position is ✕ on PS5, A on Xbox, B on a Switch Pro).
 *
 * Mirrors `kami_input::gamepad::ControllerProfile` (Rust) for parity.
 */

import type { Axis, ControllerProfile, Pad } from './types.js';

/** All buttons in canonical order. */
export const PADS: Pad[] = [
  'south',
  'east',
  'west',
  'north',
  'l1',
  'r1',
  'l2',
  'r2',
  'lstick',
  'rstick',
  'select',
  'start',
  'guide',
  'share',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
];

/** Raw button index (W3C standard mapping) → semantic [[Pad]]. */
const BUTTON_INDEX: Record<number, Pad> = {
  0: 'south',
  1: 'east',
  2: 'west',
  3: 'north',
  4: 'l1',
  5: 'r1',
  6: 'l2',
  7: 'r2',
  8: 'select',
  9: 'start',
  10: 'lstick',
  11: 'rstick',
  12: 'dpadUp',
  13: 'dpadDown',
  14: 'dpadLeft',
  15: 'dpadRight',
  16: 'guide',
  17: 'share',
};

/** Raw axis index (W3C standard mapping) → stick [[Axis]]. */
const AXIS_INDEX: Record<number, Axis> = {
  0: 'leftX',
  1: 'leftY',
  2: 'rightX',
  3: 'rightY',
};

export function padForButtonIndex(raw: number): Pad | undefined {
  return BUTTON_INDEX[raw];
}

export function axisForAxisIndex(raw: number): Axis | undefined {
  return AXIS_INDEX[raw];
}

/**
 * Detect the controller family from a `Gamepad.id` string (vendor id + product
 * name hints). Mirrors `ControllerProfile::detect` in Rust.
 */
export function detectProfile(id: string): ControllerProfile {
  const l = id.toLowerCase();
  const has = (n: string) => l.includes(n);
  if (has('054c') || has('dualsense') || has('dualshock') || has('playstation')) return 'ps5';
  if (has('057e') || has('switch') || has('joy-con') || has('joycon') || has('nintendo'))
    return 'switch';
  if (has('28de') || has('steam') || has('valve')) return 'steam';
  if (has('045e') || has('xbox') || has('xinput') || has('microsoft')) return 'xbox';
  return 'standard';
}

/** Human-readable family name. */
export function profileLabel(p: ControllerProfile): string {
  switch (p) {
    case 'ps5':
      return 'PlayStation 5 DualSense';
    case 'switch':
      return 'Nintendo Switch Pro';
    case 'xbox':
      return 'Xbox Series';
    case 'steam':
      return 'Steam Controller / Deck';
    default:
      return 'Standard Gamepad';
  }
}

const FACE: Record<ControllerProfile, Record<'south' | 'east' | 'west' | 'north', string>> = {
  ps5: { south: '✕', east: '○', west: '□', north: '△' },
  switch: { south: 'B', east: 'A', west: 'Y', north: 'X' },
  xbox: { south: 'A', east: 'B', west: 'X', north: 'Y' },
  steam: { south: 'A', east: 'B', west: 'X', north: 'Y' },
  standard: { south: 'A', east: 'B', west: 'X', north: 'Y' },
};

/** On-screen glyph for a button under the given family. */
export function glyph(p: ControllerProfile, b: Pad): string {
  switch (b) {
    case 'south':
    case 'east':
    case 'west':
    case 'north':
      return FACE[p][b];
    case 'l1':
      return p === 'switch' ? 'L' : p === 'ps5' ? 'L1' : 'LB';
    case 'r1':
      return p === 'switch' ? 'R' : p === 'ps5' ? 'R1' : 'RB';
    case 'l2':
      return p === 'switch' ? 'ZL' : p === 'ps5' ? 'L2' : 'LT';
    case 'r2':
      return p === 'switch' ? 'ZR' : p === 'ps5' ? 'R2' : 'RT';
    case 'lstick':
      return 'L3';
    case 'rstick':
      return 'R3';
    case 'select':
      return p === 'ps5' ? 'Create' : p === 'switch' ? '−' : 'View';
    case 'start':
      return p === 'ps5' ? 'Options' : p === 'switch' ? '+' : 'Menu';
    case 'guide':
      return p === 'ps5' ? 'PS' : p === 'switch' ? 'Home' : 'Guide';
    case 'share':
      return p === 'ps5' ? 'Mute' : p === 'switch' ? 'Capture' : 'Share';
    case 'dpadUp':
      return '↑';
    case 'dpadDown':
      return '↓';
    case 'dpadLeft':
      return '←';
    case 'dpadRight':
      return '→';
  }
}
