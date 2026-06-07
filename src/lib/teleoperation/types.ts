/**
 * Teleoperation types — browser-side front of the kami-teleop pipeline.
 *
 * The command vocabulary mirrors the Rust `kami-teleop` crate and the tazuna
 * `teleopCommand` lexicon (etzhayyim ADR-2606042100): `CommandKind` /
 * `SafeState` match the on-chain record, and `dryRun` is the G7 outward gate
 * (R0 = always `true`: plan/replay/sim only, never live actuation).
 */

/** Controller family. Selects vendor detection + on-screen glyphs. */
export type ControllerProfile = 'standard' | 'ps5' | 'switch' | 'xbox' | 'steam';

/** Semantic, controller-agnostic button (named by position, not letter). */
export type Pad =
  | 'south'
  | 'east'
  | 'west'
  | 'north'
  | 'l1'
  | 'r1'
  | 'l2'
  | 'r2'
  | 'lstick'
  | 'rstick'
  | 'select'
  | 'start'
  | 'guide'
  | 'share'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight';

/** Semantic analog axis (`l2`/`r2` are trigger pulls 0..1). */
export type Axis = 'leftX' | 'leftY' | 'rightX' | 'rightY' | 'l2' | 'r2';

/** Command kind — mirrors tazuna `teleopCommand.kind`. */
export type CommandKind = 'move' | 'manipulate' | 'halt' | 'estop' | 'handback';

/** Best-effort safety state — mirrors tazuna `teleopCommand.safeState`. */
export type SafeState =
  | 'nominal'
  | 'deadman-lapse'
  | 'latency-breach'
  | 'estopped'
  | 'autonomy-fallback';

/** Radial deadzone with edge-rescaling. */
export interface Deadzone {
  /** Inner radius below which input reads zero (0..1). */
  inner: number;
  /** Outer radius at/above which input saturates to 1 (0..1, > inner). */
  outer: number;
}

/** Mobile-base drive command (mirrors `kami_autodrive::Command` shape). */
export interface DriveCommand {
  /** Accelerator 0..1. */
  throttle: number;
  /** Brake 0..1. */
  brake: number;
  /** Steering -1..1 (positive = left/CCW). */
  steer: number;
}

/** A single normalized teleoperation command. */
export interface TeleopCommand {
  kind: CommandKind;
  /** Per-DOF joint velocity target (rad/s or m/s). */
  jointVel: number[];
  /** Gripper rate -1 (close) .. +1 (open). */
  gripper: number;
  base: DriveCommand;
  /** G7 outward gate — true = plan/replay only. R0 = true. */
  dryRun: boolean;
}

/** Normalized snapshot of one polled controller. */
export interface GamepadSnapshot {
  profile: ControllerProfile;
  connected: boolean;
  /** Raw device id (Gamepad.id). */
  id: string;
  /** Button down state, keyed by [[Pad]]. */
  buttons: Record<Pad, boolean>;
  /** Button analog value (1 for digital, pull for triggers). */
  values: Record<Pad, number>;
  /** Stick/trigger axes. */
  axes: Record<Axis, number>;
}

/**
 * tazuna `teleopCommand`-shaped frame — the on-chain-anchorable record produced
 * each tick. `serverSig` is constant `''` (G4: server never signs) and `dryRun`
 * is constant `true` at R0 (G7). `memberSig` is filled by the member's wallet
 * downstream (the SDK never holds a key — no-server-key invariant).
 */
export interface TeleopFrame {
  /** Authorizing teleopGrant id. */
  grantId: string;
  /** Target robot id. */
  robotId: string;
  kind: CommandKind;
  /** Serialized open-transport payload (the [[TeleopCommand]] as JSON). */
  payload: TeleopCommand;
  /** Ed25519 signature — filled by the member's wallet (G4). Empty until signed. */
  memberSig: string;
  /** Server signature — constant empty (G4: refused by construction). */
  serverSig: '';
  /** G7 outward gate — constant true at R0. */
  dryRun: true;
  safeState: SafeState;
  /** ms timestamp the frame was produced. */
  ts: number;
}
