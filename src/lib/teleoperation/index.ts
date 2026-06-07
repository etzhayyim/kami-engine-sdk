/**
 * Teleoperation module — PS5/Switch/Xbox/Steam controller → safety-gated
 * command → tazuna `teleopCommand` frame.
 *
 * Browser-side front of the kami-teleop pipeline (etzhayyim ADR-2606042100); the
 * Isaac-parity simulation + analysis half lives in the Rust `kami-teleop` crate.
 *
 * @example
 * ```ts
 * import { createTeleopController, TeleopPanel } from '@etzhayyim/kami-engine-sdk/teleoperation';
 * const teleop = createTeleopController({ dof: 6, robotId: 'giemon-arm6' });
 * teleop.start((tick) => {
 *   // tick.frame is a tazuna teleopCommand-shaped record (dryRun, serverSig '')
 *   send(tick.frame);
 * });
 * ```
 */

export {
  createTeleopController,
  mapArm,
  applyRadialDeadzone,
  applyScalarDeadzone,
  DEFAULT_DEADZONE,
  DEFAULT_SAFETY,
} from './controller.js';
export type {
  TeleopController,
  TeleopControllerOptions,
  TeleopTick,
  GamepadLike,
  SafetyConfig,
} from './controller.js';

export {
  detectProfile,
  profileLabel,
  glyph,
  padForButtonIndex,
  axisForAxisIndex,
  PADS,
} from './profiles.js';

export type {
  ControllerProfile,
  Pad,
  Axis,
  CommandKind,
  SafeState,
  Deadzone,
  DriveCommand,
  TeleopCommand,
  GamepadSnapshot,
  TeleopFrame,
} from './types.js';

export { default as TeleopPanel } from './TeleopPanel.svelte';
