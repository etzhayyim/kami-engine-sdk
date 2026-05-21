<script lang="ts">
  /**
   * FloatingTools.svelte — Bottom floating toolbar for Genko manga editor.
   * Pill-shaped bar with tool modes, brush types, color picker, size slider, undo/redo.
   */

  interface Props {
    activeMode: string;
    activeBrush: string;
    brushColor: string;
    brushSize: number;
    onmodechange: (mode: string) => void;
    onbrushchange: (brush: string) => void;
    oncolorchange: (color: string) => void;
    onsizechange: (size: number) => void;
    onundo: () => void;
    onredo: () => void;
  }

  let {
    activeMode,
    activeBrush,
    brushColor,
    brushSize,
    onmodechange,
    onbrushchange,
    oncolorchange,
    onsizechange,
    onundo,
    onredo,
  }: Props = $props();

  const toolModes = [
    { id: 'draw', icon: '\u270F\uFE0F' },
    { id: 'select', icon: '\uD83D\uDD32' },
    { id: 'panel', icon: '\u25FB\uFE0F' },
    { id: 'tone', icon: '\u25A4' },
    { id: 'fukidashi', icon: '\uD83D\uDCAC' },
    { id: 'text', icon: 'T' },
  ];

  const brushTypes = [
    { id: 'fine', label: 'F', title: 'Fine' },
    { id: 'pen', label: 'P', title: 'Pen' },
    { id: 'marker', label: 'M', title: 'Marker' },
    { id: 'brush', label: 'B', title: 'Brush' },
    { id: 'flat', label: 'Fl', title: 'Flat' },
    { id: 'eraser', label: 'E', title: 'Eraser' },
  ];
</script>

<div class="floating-tools">
  <div class="section modes">
    {#each toolModes as mode}
      <button
        class="tool-btn"
        class:active={activeMode === mode.id}
        onclick={() => onmodechange(mode.id)}
        title={mode.id}
      >{mode.icon}</button>
    {/each}
  </div>

  <div class="divider"></div>

  <div class="section brushes">
    {#each brushTypes as brush}
      <button
        class="brush-btn"
        class:active={activeBrush === brush.id}
        onclick={() => onbrushchange(brush.id)}
        title={brush.title}
        aria-label={brush.title}
      >{brush.label}</button>
    {/each}
  </div>

  <div class="divider"></div>

  <div class="section controls">
    <input
      type="color"
      class="color-picker"
      value={brushColor}
      oninput={(e) => oncolorchange(e.currentTarget.value)}
    />
    <input
      type="range"
      class="size-slider"
      min="0.5"
      max="20"
      step="0.5"
      value={brushSize}
      oninput={(e) => onsizechange(parseFloat(e.currentTarget.value))}
    />
    <span class="size-label">{brushSize}</span>
  </div>

  <div class="divider"></div>

  <div class="section history">
    <button class="tool-btn" onclick={onundo} title="Undo">↩</button>
    <button class="tool-btn" onclick={onredo} title="Redo">↪</button>
  </div>
</div>

<style>
  .floating-tools {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: #fff;
    border-radius: 20px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    z-index: 10;
    font-family: 'Nunito', sans-serif;
    font-size: 12px;
  }

  .section {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .divider {
    width: 1px;
    height: 20px;
    margin: 0 2px;
    background: #e0e0e0;
  }

  .tool-btn {
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tool-btn:hover {
    background: #f0ead6;
  }

  .tool-btn.active {
    background: #f0ead6;
    border-color: #c8b888;
  }

  .brush-btn {
    min-width: 24px;
    height: 24px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    font-size: 11px;
    font-weight: 700;
    font-family: 'Nunito', sans-serif;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .brush-btn:hover {
    background: #f0ead6;
  }

  .brush-btn.active {
    background: #f0ead6;
    border-color: #c8b888;
    font-weight: 700;
  }

  .color-picker {
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 50%;
    padding: 0;
    cursor: pointer;
    background: transparent;
  }

  .color-picker::-webkit-color-swatch-wrapper {
    padding: 2px;
  }

  .color-picker::-webkit-color-swatch {
    border-radius: 50%;
    border: 1px solid #ccc;
  }

  .size-slider {
    width: 56px;
    height: 4px;
    accent-color: #c8b888;
  }

  .size-label {
    font-size: 10px;
    color: #888;
    min-width: 16px;
    text-align: center;
  }
</style>
