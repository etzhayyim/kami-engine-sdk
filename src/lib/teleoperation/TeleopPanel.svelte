<script lang="ts">
  import { glyph, profileLabel } from './profiles.js';
  import type { TeleopTick } from './controller.js';
  import type { Pad, SafeState } from './types.js';

  interface Props {
    /** Latest tick from a teleop controller (e.g. `controller.poll()`). */
    tick: TeleopTick | null;
    class?: string;
  }

  let { tick, class: className }: Props = $props();

  const STATE_COLOR: Record<SafeState, string> = {
    nominal: '#7ec850', // green
    'deadman-lapse': '#f4c430', // amber
    'latency-breach': '#f49b30', // orange
    estopped: '#e5534b', // red
    'autonomy-fallback': '#5b9bd5', // blue
  };

  const STATE_LABEL: Record<SafeState, string> = {
    nominal: 'NOMINAL',
    'deadman-lapse': 'DEADMAN — hold L1/LB',
    'latency-breach': 'LATENCY BREACH',
    estopped: 'E-STOP',
    'autonomy-fallback': 'AUTONOMY',
  };

  // D-pad + face buttons get their own clusters; the rest go in a flat row.
  const FACE: Pad[] = ['north', 'west', 'east', 'south'];
  const SHOULDER: Pad[] = ['l1', 'r1', 'l2', 'r2'];
  const SYS: Pad[] = ['select', 'start', 'guide'];

  let profile = $derived(tick?.profile ?? 'standard');
  let state = $derived<SafeState>(tick?.safeState ?? 'deadman-lapse');
  let pressed = $derived((p: Pad) => !!tick?.snapshot.buttons[p]);
</script>

<div class="teleop-panel {className ?? ''}">
  <header>
    <span class="dot" class:on={tick?.connected}></span>
    <strong>{profileLabel(profile)}</strong>
    <span class="badge" style="background:{STATE_COLOR[state]}">{STATE_LABEL[state]}</span>
  </header>

  <div class="sticks">
    <div class="stick">
      <span class="lbl">L</span>
      <div class="pad">
        <div
          class="nub"
          style="left:{50 + (tick?.snapshot.axes.leftX ?? 0) * 40}%; top:{50 +
            (tick?.snapshot.axes.leftY ?? 0) * 40}%"
        ></div>
      </div>
    </div>
    <div class="stick">
      <span class="lbl">R</span>
      <div class="pad">
        <div
          class="nub"
          style="left:{50 + (tick?.snapshot.axes.rightX ?? 0) * 40}%; top:{50 +
            (tick?.snapshot.axes.rightY ?? 0) * 40}%"
        ></div>
      </div>
    </div>
  </div>

  <div class="btn-rows">
    {#each [SHOULDER, FACE, SYS] as row}
      <div class="btn-row">
        {#each row as b}
          <span class="btn" class:lit={pressed(b)} title={b}>{glyph(profile, b)}</span>
        {/each}
      </div>
    {/each}
    <div class="btn-row dpad">
      {#each ['dpadLeft', 'dpadUp', 'dpadDown', 'dpadRight'] as Pad[] as b}
        <span class="btn" class:lit={pressed(b)} title={b}>{glyph(profile, b)}</span>
      {/each}
    </div>
  </div>

  {#if tick}
    <div class="joints">
      {#each tick.command.jointVel as v, i}
        <div class="joint">
          <span class="jl">J{i + 1}</span>
          <div class="bar">
            <div
              class="fill"
              class:neg={v < 0}
              style="width:{Math.min(Math.abs(v) / 1.5, 1) * 100}%"
            ></div>
          </div>
        </div>
      {/each}
      <div class="meta">
        <span>{tick.command.kind}</span>
        <span class:dry={tick.command.dryRun}>{tick.command.dryRun ? 'DRY-RUN' : 'LIVE'}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .teleop-panel {
    font-family: 'Nunito', system-ui, sans-serif;
    background: #f0ead6;
    color: #3a3a3a;
    border-radius: 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    padding: 14px 16px;
    width: 280px;
    font-weight: 700;
    user-select: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  header strong {
    flex: 1;
    font-size: 13px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #c0392b;
  }
  .dot.on {
    background: #7ec850;
  }
  .badge {
    color: #fff;
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 10px;
    letter-spacing: 0.04em;
  }
  .sticks {
    display: flex;
    gap: 16px;
    justify-content: center;
    margin-bottom: 10px;
  }
  .stick {
    text-align: center;
  }
  .stick .lbl {
    font-size: 10px;
    color: #888;
  }
  .pad {
    position: relative;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: #fff;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.2);
    margin-top: 2px;
  }
  .nub {
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #5b9bd5;
    transform: translate(-50%, -50%);
  }
  .btn-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
  }
  .btn-row {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  .btn {
    min-width: 28px;
    padding: 4px 6px;
    text-align: center;
    border-radius: 8px;
    background: #fff;
    font-size: 11px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  .btn.lit {
    background: #f4c430;
    color: #3a3a3a;
  }
  .joints {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .joint {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .jl {
    font-size: 10px;
    width: 18px;
    color: #888;
  }
  .bar {
    flex: 1;
    height: 6px;
    background: #fff;
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #7ec850;
  }
  .fill.neg {
    background: #5b9bd5;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    margin-top: 4px;
    text-transform: uppercase;
  }
  .meta .dry {
    color: #7ec850;
  }
</style>
