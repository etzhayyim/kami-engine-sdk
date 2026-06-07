import { describe, it, expect } from 'vitest';
import {
  createTeleopController,
  mapArm,
  applyRadialDeadzone,
  DEFAULT_DEADZONE,
  type GamepadLike,
} from './controller.js';
import { detectProfile, glyph } from './profiles.js';
import type { GamepadSnapshot } from './types.js';

/** Build a fake W3C gamepad. `buttons` keyed by raw index; `axes` is [lx,ly,rx,ry]. */
function pad(o: {
  id?: string;
  buttons?: Record<number, { pressed: boolean; value: number }>;
  axes?: number[];
} = {}): GamepadLike {
  const buttons = Array.from({ length: 18 }, (_, i) => o.buttons?.[i] ?? { pressed: false, value: 0 });
  return { id: o.id ?? 'Standard Gamepad', connected: true, buttons, axes: o.axes ?? [0, 0, 0, 0] };
}

const DOWN = { pressed: true, value: 1 };
const L1 = 4; // deadman
const EAST = 1; // e-stop
const START = 9; // resume

describe('profile detection', () => {
  it('maps vendor ids + names to families', () => {
    expect(detectProfile('DualSense Wireless Controller (Vendor: 054c)')).toBe('ps5');
    expect(detectProfile('Pro Controller (057e 2009)')).toBe('switch');
    expect(detectProfile('Xbox Wireless Controller (045e)')).toBe('xbox');
    expect(detectProfile('28de:1142 Steam Controller')).toBe('steam');
    expect(detectProfile('Generic USB Joypad')).toBe('standard');
  });

  it('swaps face glyphs per family', () => {
    expect(glyph('ps5', 'south')).toBe('✕');
    expect(glyph('xbox', 'south')).toBe('A');
    expect(glyph('switch', 'south')).toBe('B');
    expect(glyph('switch', 'r2')).toBe('ZR');
  });
});

describe('deadzone', () => {
  it('kills drift and preserves diagonal direction', () => {
    expect(applyRadialDeadzone(0.05, 0.05, { inner: 0.1, outer: 1 })).toEqual([0, 0]);
    const [x] = applyRadialDeadzone(0.8, 0, { inner: 0.1, outer: 1 });
    expect(x).toBeCloseTo(0.7777, 3);
    const [dx, dy] = applyRadialDeadzone(0.7, 0.7, { inner: 0.1, outer: 1 });
    expect(dx).toBeCloseTo(dy, 6);
  });
});

describe('arm mapping', () => {
  it('left stick X drives joint 0', () => {
    const snap: GamepadSnapshot = {
      profile: 'ps5',
      connected: true,
      id: '',
      buttons: {} as never,
      values: {} as never,
      axes: { leftX: 1, leftY: 0, rightX: 0, rightY: 0, l2: 0, r2: 0 },
    };
    const cmd = mapArm(snap, { dof: 6, speed: 1.5, gripperSpeed: 1, deadzone: DEFAULT_DEADZONE, dryRun: true });
    expect(cmd.jointVel[0]).toBeGreaterThan(1.0);
    expect(cmd.jointVel.slice(1).every((v) => Math.abs(v) < 1e-6)).toBe(true);
    expect(cmd.kind).toBe('manipulate');
  });
});

describe('safety-gated controller', () => {
  it('passes motion through when deadman held', () => {
    const c = createTeleopController({
      dof: 6,
      robotId: 'giemon-arm6',
      getGamepads: () => [pad({ id: 'DualSense 054c', buttons: { [L1]: DOWN }, axes: [1, 0, 0, 0] })],
    });
    const t = c.poll(0, 20);
    expect(t.connected).toBe(true);
    expect(t.profile).toBe('ps5');
    expect(t.safeState).toBe('nominal');
    expect(t.command.jointVel[0]).toBeGreaterThan(1.0);
    // tazuna frame invariants.
    expect(t.frame.dryRun).toBe(true);
    expect(t.frame.serverSig).toBe('');
    expect(t.frame.robotId).toBe('giemon-arm6');
  });

  it('halts on deadman lapse', () => {
    const c = createTeleopController({
      getGamepads: () => [pad({ axes: [1, 0, 0, 0] })], // no L1
    });
    const t = c.poll(0, 20);
    expect(t.safeState).toBe('deadman-lapse');
    expect(t.command.kind).toBe('halt');
    expect(t.command.jointVel.every((v) => v === 0)).toBe(true);
  });

  it('halts on latency breach', () => {
    const c = createTeleopController({
      getGamepads: () => [pad({ buttons: { [L1]: DOWN }, axes: [1, 0, 0, 0] })],
    });
    expect(c.poll(0, 500).safeState).toBe('latency-breach');
  });

  it('latches e-stop and resumes', () => {
    let cur: GamepadLike = pad({ buttons: { [L1]: DOWN } });
    const c = createTeleopController({ getGamepads: () => [cur] });

    expect(c.poll(0, 20).safeState).toBe('nominal');

    // Press East → latch.
    cur = pad({ buttons: { [L1]: DOWN, [EAST]: DOWN } });
    expect(c.poll(1, 20).safeState).toBe('estopped');
    expect(c.isEstopped()).toBe(true);

    // Release East → still latched.
    cur = pad({ buttons: { [L1]: DOWN } });
    expect(c.poll(2, 20).safeState).toBe('estopped');

    // Press Start → resume.
    cur = pad({ buttons: { [L1]: DOWN, [START]: DOWN } });
    expect(c.poll(3, 20).safeState).toBe('nominal');
    expect(c.isEstopped()).toBe(false);
  });

  it('halts when no controller is connected', () => {
    const c = createTeleopController({ getGamepads: () => [] });
    const t = c.poll(0, 20);
    expect(t.connected).toBe(false);
    expect(t.safeState).toBe('deadman-lapse');
    expect(t.command.kind).toBe('halt');
  });

  it('families produce identical motion for identical raw input', () => {
    const mk = (id: string) =>
      createTeleopController({
        getGamepads: () => [pad({ id, buttons: { [L1]: DOWN }, axes: [1, 0, 0, 0] })],
      }).poll(0, 10).command.jointVel[0];
    expect(mk('DualSense 054c')).toBeCloseTo(mk('Pro Controller 057e'), 6);
  });
});
