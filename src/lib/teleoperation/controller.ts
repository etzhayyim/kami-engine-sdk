/**
 * Browser teleoperation controller — acquisition + mapping + safety front of
 * the kami-teleop pipeline.
 *
 * Reads the W3C Gamepad API (`navigator.getGamepads()`), detects the family
 * (PS5/Switch/Xbox/Steam), conditions sticks/triggers, maps to a
 * [[TeleopCommand]], applies the best-effort safety envelope (deadman / e-stop /
 * latency), and emits a tazuna `teleopCommand`-shaped [[TeleopFrame]] each tick.
 *
 * The heavy half of the loop — physics + analysis — lives in the Rust
 * `kami-teleop` crate (Isaac-parity `kami-genesis`); this module is the input
 * acquisition + on-chain framing only. The SDK never holds a signing key
 * (no-server-key): `memberSig` is filled by the member's wallet downstream and
 * `dryRun` is constant `true` at R0 (G7).
 */

import {
  axisForAxisIndex,
  detectProfile,
  padForButtonIndex,
} from './profiles.js';
import type {
  Axis,
  CommandKind,
  ControllerProfile,
  Deadzone,
  GamepadSnapshot,
  Pad,
  SafeState,
  TeleopCommand,
  TeleopFrame,
} from './types.js';

/** Minimal subset of the W3C `Gamepad` interface we read (testable). */
export interface GamepadLike {
  id: string;
  connected: boolean;
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

/** Safety-layer button assignments + latency budget. */
export interface SafetyConfig {
  /** Deadman: must be held to permit motion (default `l1`). */
  deadman: Pad | null;
  /** E-stop: latches on press (default `east`). */
  estop: Pad | null;
  /** Resume: clears the e-stop latch on press (default `start`). */
  resume: Pad | null;
  /** Control latency budget, ms (default 250). */
  latencyBudgetMs: number;
}

export const DEFAULT_DEADZONE: Deadzone = { inner: 0.12, outer: 0.95 };

export const DEFAULT_SAFETY: SafetyConfig = {
  deadman: 'l1',
  estop: 'east',
  resume: 'start',
  latencyBudgetMs: 250,
};

export interface TeleopControllerOptions {
  /** Actuated DOF of the target arm (default 6). */
  dof?: number;
  /** Joint velocity at full stick deflection, rad/s (default 1.5). */
  speed?: number;
  /** Gripper rate scale (default 1.0). */
  gripperSpeed?: number;
  deadzone?: Deadzone;
  safety?: Partial<SafetyConfig>;
  /** tazuna teleopGrant id (default `''`). */
  grantId?: string;
  /** Target robot id (default `''`). */
  robotId?: string;
  /** Gamepad source; defaults to `navigator.getGamepads()`. Injectable for tests. */
  getGamepads?: () => Array<GamepadLike | null>;
  /** Which gamepad slot to use; default = first connected. */
  padIndex?: number;
}

/** One polled teleoperation tick. */
export interface TeleopTick {
  profile: ControllerProfile;
  connected: boolean;
  snapshot: GamepadSnapshot;
  /** Safety-gated command actually issued this tick. */
  command: TeleopCommand;
  safeState: SafeState;
  frame: TeleopFrame;
  /** Measured/estimated control latency for the tick (ms). */
  latencyMs: number;
}

export interface TeleopController {
  /** Poll once and produce a gated tick. `nowMs` defaults to `performance.now()`. */
  poll(nowMs?: number, latencyMs?: number): TeleopTick;
  /** rAF poll loop (browser only). */
  start(onTick: (t: TeleopTick) => void): void;
  stop(): void;
  resetEstop(): void;
  isEstopped(): boolean;
  readonly profile: ControllerProfile;
}

function emptyMaps(): Pick<GamepadSnapshot, 'buttons' | 'values' | 'axes'> {
  const buttons = {} as Record<Pad, boolean>;
  const values = {} as Record<Pad, number>;
  const axes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, l2: 0, r2: 0 } as Record<Axis, number>;
  return { buttons, values, axes };
}

function snapshotFromPad(pad: GamepadLike | null): GamepadSnapshot {
  const { buttons, values, axes } = emptyMaps();
  const profile: ControllerProfile = pad ? detectProfile(pad.id) : 'standard';
  if (!pad || !pad.connected) {
    return { profile, connected: false, id: pad?.id ?? '', buttons, values, axes };
  }
  pad.buttons.forEach((b, i) => {
    const p = padForButtonIndex(i);
    if (p) {
      buttons[p] = b.pressed;
      values[p] = b.value;
    }
  });
  pad.axes.forEach((v, i) => {
    const a = axisForAxisIndex(i);
    if (a) axes[a] = v;
  });
  // Standard mapping exposes trigger pulls as buttons[6]/[7].value.
  axes.l2 = values.l2 ?? 0;
  axes.r2 = values.r2 ?? 0;
  return { profile, connected: true, id: pad.id, buttons, values, axes };
}

/** Radial deadzone preserving direction (no square clipping). */
export function applyRadialDeadzone(x: number, y: number, dz: Deadzone): [number, number] {
  const m = Math.hypot(x, y);
  if (m <= dz.inner) return [0, 0];
  const span = Math.max(dz.outer - dz.inner, 1e-6);
  const scaled = Math.min(Math.max((m - dz.inner) / span, 0), 1);
  return [(x * scaled) / m, (y * scaled) / m];
}

/** Sign-preserving scalar deadzone (triggers / 1-D axes). */
export function applyScalarDeadzone(x: number, dz: Deadzone): number {
  const s = Math.sign(x);
  const m = Math.abs(x);
  if (m <= dz.inner) return 0;
  const span = Math.max(dz.outer - dz.inner, 1e-6);
  return s * Math.min(Math.max((m - dz.inner) / span, 0), 1);
}

/**
 * Map a snapshot → arm command. Allocation mirrors the Rust `TeleopMapper`:
 * sticks → joints 0-3, triggers → joint 4, North/South → joint 5, D-pad ↑↓ →
 * gripper. (L1/East/Start are reserved for the safety layer.)
 */
export function mapArm(
  snap: GamepadSnapshot,
  opts: { dof: number; speed: number; gripperSpeed: number; deadzone: Deadzone; dryRun: boolean },
): TeleopCommand {
  const [lx, ly] = applyRadialDeadzone(snap.axes.leftX, snap.axes.leftY, opts.deadzone);
  const [rx, ry] = applyRadialDeadzone(snap.axes.rightX, snap.axes.rightY, opts.deadzone);
  const jv = new Array(opts.dof).fill(0);
  const set = (i: number, v: number) => {
    if (i < opts.dof) jv[i] = v * opts.speed;
  };
  // Gamepad +Y is down → negate for "up = +".
  set(0, lx);
  set(1, -ly);
  set(2, -ry);
  set(3, rx);
  set(4, applyScalarDeadzone(snap.axes.r2, opts.deadzone) - applyScalarDeadzone(snap.axes.l2, opts.deadzone));
  set(5, (snap.buttons.north ? 1 : 0) - (snap.buttons.south ? 1 : 0));
  const gripper = ((snap.buttons.dpadUp ? 1 : 0) - (snap.buttons.dpadDown ? 1 : 0)) * opts.gripperSpeed;
  const any = Math.abs(gripper) > 1e-4 || jv.some((v) => Math.abs(v) > 1e-4);
  return {
    kind: any ? 'manipulate' : 'move',
    jointVel: jv,
    gripper,
    base: { throttle: 0, brake: 0, steer: 0 },
    dryRun: opts.dryRun,
  };
}

function zeroed(kind: CommandKind, dof: number): TeleopCommand {
  return {
    kind,
    jointVel: new Array(dof).fill(0),
    gripper: 0,
    base: { throttle: 0, brake: 0, steer: 0 },
    dryRun: true,
  };
}

/**
 * Create a teleoperation controller. In a browser, omit `getGamepads` to read
 * the live Gamepad API; in tests, inject one.
 */
export function createTeleopController(opts: TeleopControllerOptions = {}): TeleopController {
  const dof = opts.dof ?? 6;
  const speed = opts.speed ?? 1.5;
  const gripperSpeed = opts.gripperSpeed ?? 1.0;
  const deadzone = opts.deadzone ?? DEFAULT_DEADZONE;
  const safety: SafetyConfig = { ...DEFAULT_SAFETY, ...opts.safety };
  const grantId = opts.grantId ?? '';
  const robotId = opts.robotId ?? '';
  const getGamepads =
    opts.getGamepads ??
    (() =>
      (typeof navigator !== 'undefined' && navigator.getGamepads
        ? (navigator.getGamepads() as Array<GamepadLike | null>)
        : []));

  let estopped = false;
  let prev: GamepadSnapshot | null = null;
  let rafId: number | null = null;
  let profile: ControllerProfile = 'standard';

  const pickPad = (): GamepadLike | null => {
    const pads = getGamepads() ?? [];
    if (typeof opts.padIndex === 'number') return pads[opts.padIndex] ?? null;
    return pads.find((p): p is GamepadLike => !!p && p.connected) ?? null;
  };

  const justPressed = (snap: GamepadSnapshot, p: Pad | null): boolean =>
    !!p && !!snap.buttons[p] && !prev?.buttons[p];

  const poll = (nowMs?: number, latencyMs = 0): TeleopTick => {
    const now = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const pad = pickPad();
    const snap = snapshotFromPad(pad);
    profile = snap.profile;

    // Edge-triggered e-stop latch / resume.
    if (justPressed(snap, safety.estop)) estopped = true;
    if (estopped && justPressed(snap, safety.resume)) estopped = false;

    let safeState: SafeState;
    let command: TeleopCommand;
    if (!snap.connected) {
      safeState = 'deadman-lapse';
      command = zeroed('halt', dof);
    } else if (estopped) {
      safeState = 'estopped';
      command = zeroed('estop', dof);
    } else if (latencyMs > safety.latencyBudgetMs) {
      safeState = 'latency-breach';
      command = zeroed('halt', dof);
    } else if (safety.deadman && !snap.buttons[safety.deadman]) {
      safeState = 'deadman-lapse';
      command = zeroed('halt', dof);
    } else {
      safeState = 'nominal';
      command = mapArm(snap, { dof, speed, gripperSpeed, deadzone, dryRun: true });
    }

    prev = snap;
    const frame: TeleopFrame = {
      grantId,
      robotId,
      kind: command.kind,
      payload: command,
      memberSig: '',
      serverSig: '',
      dryRun: true,
      safeState,
      ts: now,
    };
    return { profile: snap.profile, connected: snap.connected, snapshot: snap, command, safeState, frame, latencyMs };
  };

  return {
    poll,
    start(onTick) {
      if (typeof requestAnimationFrame !== 'function') {
        throw new Error('createTeleopController.start requires a browser (requestAnimationFrame)');
      }
      const loop = () => {
        onTick(poll());
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = null;
    },
    resetEstop() {
      estopped = false;
    },
    isEstopped() {
      return estopped;
    },
    get profile() {
      return profile;
    },
  };
}
