<script lang="ts">
  /**
   * WebGPU Canvas wrapper for Genko manga editor.
   * Manages GPU init, render loop, pointer/stylus input, and image overlays.
   * Canvas rendering logic stays as imperative JS (WebGPU doesn't benefit from Svelte reactivity).
   */
  import { onMount, onDestroy } from 'svelte';
  import { getStrokes, getOverlays, getSelectedIdx, setSelectedIdx, consumeRedraw, requestRedraw, findByNid } from '../stores/doc.svelte';

  let { width = 0, height = 0, zoom = 1, panX = 0, panY = 0, activeYoushi = 'b4manga',
    activeBrush = 'fine', activeMode = 'draw', brushColor = [0.2,0.2,0.2,1] as number[], brushSize = 2, brushOpacity = 1,
    onzoomchange, onpanchange, onstrokeend, onoverlayadd,
  }: {
    width?: number; height?: number;
    zoom?: number; panX?: number; panY?: number;
    activeYoushi?: string;
    activeBrush?: string; activeMode?: string;
    brushColor?: number[]; brushSize?: number; brushOpacity?: number;
    onzoomchange?: (z: number) => void;
    onpanchange?: (x: number, y: number) => void;
    onstrokeend?: (stroke: Record<string, unknown>) => void;
    onoverlayadd?: (overlay: Record<string, unknown>) => void;
  } = $props();

  let canvasEl: HTMLCanvasElement;
  let imgLayer: HTMLDivElement;
  let textLayer: HTMLDivElement;
  let device: GPUDevice | null = null;
  let ctx: GPUCanvasContext | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let vpUniformBuf: GPUBuffer | null = null;
  let vpBindGroup: GPUBindGroup | null = null;
  let vertBuf: GPUBuffer | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let glProgram: WebGLProgram | null = null;
  let glVertBuf: WebGLBuffer | null = null;
  let glPosLoc = -1;
  let glColorLoc = -1;
  let glZoomLoc: WebGLUniformLocation | null = null;
  let glPanLoc: WebGLUniformLocation | null = null;
  let glCanvasLoc: WebGLUniformLocation | null = null;
  let animId = 0;
  let dpr = 1;
  let gpuError = $state('');
  let renderBackend = $state<'webgpu' | 'webgl' | 'none'>('none');
  let renderFrame: ((data: Float32Array, vertCount: number) => void) | null = null;
  const MAX_VERTS = 2_000_000;

  // Drawing state
  let isDrawing = false;
  let currentStroke: Record<string, unknown> | null = null;
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panStartPX = 0, panStartPY = 0;

  // Youshi templates
  const YOUSHI: Record<string, { wMM: number; hMM: number; draw: boolean }> = {
    b4manga: { wMM: 257, hMM: 364, draw: true },
    b4koma: { wMM: 257, hMM: 364, draw: true },
    none: { wMM: 210, hMM: 297, draw: false },
  };

  const SHADER = `
struct VP { zoom:f32, panX:f32, panY:f32, cw:f32, ch:f32, _p0:f32, _p1:f32, _p2:f32 };
@group(0) @binding(0) var<uniform> vp:VP;
struct VIn { @location(0) pos:vec2f, @location(1) col:vec4f };
struct VOut { @builtin(position) pos:vec4f, @location(0) col:vec4f };
@vertex fn vs(v:VIn)->VOut {
  var o:VOut;
  let x=(v.pos.x*vp.cw*vp.zoom+vp.panX)/vp.cw*2.0-1.0;
  let y=1.0-(v.pos.y*vp.ch*vp.zoom+vp.panY)/vp.ch*2.0;
  o.pos=vec4f(x,y,0,1); o.col=v.col; return o;
}
@fragment fn fs(v:VOut)->@location(0) vec4f { return v.col; }`;

  const WEBGL_VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec4 a_color;
uniform float u_zoom;
uniform vec2 u_pan;
uniform vec2 u_canvas;
varying vec4 v_color;

void main() {
  float x = ((a_pos.x * u_canvas.x * u_zoom) + u_pan.x) / u_canvas.x * 2.0 - 1.0;
  float y = 1.0 - (((a_pos.y * u_canvas.y * u_zoom) + u_pan.y) / u_canvas.y * 2.0);
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_color = a_color;
}
`;

  const WEBGL_FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;

void main() {
  gl_FragColor = v_color;
}
`;

  async function initGPU() {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    device = await adapter.requestDevice();
    ctx = canvasEl.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('Failed to acquire WebGPU canvas context');
    const fmt = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: fmt, alphaMode: 'premultiplied' });

    const mod = device.createShaderModule({ code: SHADER });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x4' }] }] },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: fmt, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list' },
    });

    vpUniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgl = pipeline.getBindGroupLayout(0);
    vpBindGroup = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: vpUniformBuf } }] });
    vertBuf = device.createBuffer({ size: MAX_VERTS * 24, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    renderBackend = 'webgpu';
    renderFrame = renderWithWebGPU;
  }

  function compileWebGLShader(
    glCtx: WebGLRenderingContext | WebGL2RenderingContext,
    type: number,
    source: string,
  ): WebGLShader {
    const shader = glCtx.createShader(type);
    if (!shader) throw new Error('Failed to create WebGL shader');
    glCtx.shaderSource(shader, source);
    glCtx.compileShader(shader);
    if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
      const log = glCtx.getShaderInfoLog(shader) || 'Unknown WebGL shader compile error';
      glCtx.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  function initWebGL() {
    const webgl =
      canvasEl.getContext('webgl2', { alpha: true, antialias: true }) ||
      canvasEl.getContext('webgl', { alpha: true, antialias: true });
    if (!webgl) throw new Error('WebGL is not available in this browser');

    const vertexShader = compileWebGLShader(webgl, webgl.VERTEX_SHADER, WEBGL_VERTEX_SHADER);
    const fragmentShader = compileWebGLShader(webgl, webgl.FRAGMENT_SHADER, WEBGL_FRAGMENT_SHADER);
    const program = webgl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');
    webgl.attachShader(program, vertexShader);
    webgl.attachShader(program, fragmentShader);
    webgl.linkProgram(program);
    if (!webgl.getProgramParameter(program, webgl.LINK_STATUS)) {
      const log = webgl.getProgramInfoLog(program) || 'Unknown WebGL link error';
      throw new Error(log);
    }

    const buffer = webgl.createBuffer();
    if (!buffer) throw new Error('Failed to create WebGL vertex buffer');

    gl = webgl;
    glProgram = program;
    glVertBuf = buffer;
    glPosLoc = webgl.getAttribLocation(program, 'a_pos');
    glColorLoc = webgl.getAttribLocation(program, 'a_color');
    glZoomLoc = webgl.getUniformLocation(program, 'u_zoom');
    glPanLoc = webgl.getUniformLocation(program, 'u_pan');
    glCanvasLoc = webgl.getUniformLocation(program, 'u_canvas');

    webgl.bindBuffer(webgl.ARRAY_BUFFER, buffer);
    webgl.enable(webgl.BLEND);
    webgl.blendFunc(webgl.SRC_ALPHA, webgl.ONE_MINUS_SRC_ALPHA);
    renderBackend = 'webgl';
    renderFrame = renderWithWebGL;
  }

  function renderWithWebGPU(data: Float32Array, vertCount: number) {
    if (!device || !ctx || !pipeline || !vpUniformBuf || !vpBindGroup || !vertBuf) return;
    device.queue.writeBuffer(vpUniformBuf, 0, new Float32Array([zoom, panX, panY, canvasEl.width, canvasEl.height, 0, 0, 0]));
    if (vertCount > 0 && vertCount <= MAX_VERTS) {
      const uploadData = new Float32Array(data.length);
      uploadData.set(data);
      device.queue.writeBuffer(vertBuf, 0, uploadData);
    }
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0.7, g: 0.7, b: 0.7, a: 1 },
        storeOp: 'store',
      }],
    });
    if (vertCount > 0) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, vpBindGroup);
      pass.setVertexBuffer(0, vertBuf);
      pass.draw(vertCount);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  function renderWithWebGL(data: Float32Array, vertCount: number) {
    if (!gl || !glProgram || !glVertBuf || !glZoomLoc || !glPanLoc || !glCanvasLoc) return;
    gl.viewport(0, 0, canvasEl.width, canvasEl.height);
    gl.clearColor(0.7, 0.7, 0.7, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(glProgram);
    gl.uniform1f(glZoomLoc, zoom);
    gl.uniform2f(glPanLoc, panX, panY);
    gl.uniform2f(glCanvasLoc, canvasEl.width, canvasEl.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, glVertBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glPosLoc);
    gl.vertexAttribPointer(glPosLoc, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(glColorLoc);
    gl.vertexAttribPointer(glColorLoc, 4, gl.FLOAT, false, 24, 8);
    if (vertCount > 0) gl.drawArrays(gl.TRIANGLES, 0, vertCount);
  }

  function tessellateAll(): Float32Array {
    const verts: number[] = [];
    const cw = canvasEl.width, ch = canvasEl.height;
    const strokes = getStrokes();
    const overlays = getOverlays();

    // Youshi template
    const y = YOUSHI[activeYoushi];
    if (y?.draw) {
      const sc = Math.min(cw * 0.9 / y.wMM, ch * 0.9 / y.hMM);
      const pw = y.wMM * sc / cw, ph = y.hMM * sc / ch;
      const ox = (1 - pw) / 2, oy = (1 - ph) / 2;
      const c = [0.95, 0.95, 0.95, 1];
      verts.push(ox, oy, c[0], c[1], c[2], c[3], ox + pw, oy, c[0], c[1], c[2], c[3], ox + pw, oy + ph, c[0], c[1], c[2], c[3]);
      verts.push(ox, oy, c[0], c[1], c[2], c[3], ox + pw, oy + ph, c[0], c[1], c[2], c[3], ox, oy + ph, c[0], c[1], c[2], c[3]);
    }

    // Strokes
    for (const s of strokes) {
      if ((s._visible as boolean) === false) continue;
      const pts = s.points as Array<{ x: number; y: number; pressure: number }>;
      if (!pts || pts.length < 2) continue;
      const c = (s.color as number[]) || [0, 0, 0, 1];
      const sz = (s.size as number) || 2;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const ra = sz * a.pressure * dpr * 0.5, rb = sz * b.pressure * dpr * 0.5;
        verts.push((a.x + nx * ra) / cw, (a.y + ny * ra) / ch, c[0], c[1], c[2], 1);
        verts.push((a.x - nx * ra) / cw, (a.y - ny * ra) / ch, c[0], c[1], c[2], 1);
        verts.push((b.x + nx * rb) / cw, (b.y + ny * rb) / ch, c[0], c[1], c[2], 1);
        verts.push((a.x - nx * ra) / cw, (a.y - ny * ra) / ch, c[0], c[1], c[2], 1);
        verts.push((b.x - nx * rb) / cw, (b.y - ny * rb) / ch, c[0], c[1], c[2], 1);
        verts.push((b.x + nx * rb) / cw, (b.y + ny * rb) / ch, c[0], c[1], c[2], 1);
      }
    }

    // Panel overlays (border rectangles)
    for (const o of overlays) {
      if ((o._visible as boolean) === false) continue;
      if (o.type === 'panel' || o.type === 'tone') {
        const x1 = (o.x1 as number) / cw, y1 = (o.y1 as number) / ch;
        const x2 = (o.x2 as number) / cw, y2 = (o.y2 as number) / ch;
        const bw = 2 / cw;
        const c = o.type === 'panel' ? [0.2, 0.2, 0.2, 0.8] : [0.5, 0.5, 0.5, 0.3];
        // Top border
        verts.push(x1, y1, c[0], c[1], c[2], c[3], x2, y1, c[0], c[1], c[2], c[3], x2, y1 + bw, c[0], c[1], c[2], c[3]);
        verts.push(x1, y1, c[0], c[1], c[2], c[3], x2, y1 + bw, c[0], c[1], c[2], c[3], x1, y1 + bw, c[0], c[1], c[2], c[3]);
        // Bottom border
        verts.push(x1, y2 - bw, c[0], c[1], c[2], c[3], x2, y2 - bw, c[0], c[1], c[2], c[3], x2, y2, c[0], c[1], c[2], c[3]);
        verts.push(x1, y2 - bw, c[0], c[1], c[2], c[3], x2, y2, c[0], c[1], c[2], c[3], x1, y2, c[0], c[1], c[2], c[3]);
        // Left border
        verts.push(x1, y1, c[0], c[1], c[2], c[3], x1 + bw, y1, c[0], c[1], c[2], c[3], x1 + bw, y2, c[0], c[1], c[2], c[3]);
        verts.push(x1, y1, c[0], c[1], c[2], c[3], x1 + bw, y2, c[0], c[1], c[2], c[3], x1, y2, c[0], c[1], c[2], c[3]);
        // Right border
        verts.push(x2 - bw, y1, c[0], c[1], c[2], c[3], x2, y1, c[0], c[1], c[2], c[3], x2, y2, c[0], c[1], c[2], c[3]);
        verts.push(x2 - bw, y1, c[0], c[1], c[2], c[3], x2, y2, c[0], c[1], c[2], c[3], x2 - bw, y2, c[0], c[1], c[2], c[3]);
      }
    }

    // Selection highlight
    const selIdx = getSelectedIdx();
    if (selIdx >= 0) {
      const strokes = getStrokes();
      const overlays = getOverlays();
      if (selIdx >= strokes.length) {
        const o = overlays[selIdx - strokes.length];
        if (o && o.x1 != null) {
          const x1 = (o.x1 as number) / cw, y1 = (o.y1 as number) / ch;
          const x2 = (o.x2 as number) / cw, y2 = (o.y2 as number) / ch;
          const bw = 3 / cw;
          const c = [0.88, 0.25, 0.56, 0.9];
          verts.push(x1 - bw, y1 - bw, c[0], c[1], c[2], c[3], x2 + bw, y1 - bw, c[0], c[1], c[2], c[3], x2 + bw, y1 + bw, c[0], c[1], c[2], c[3]);
          verts.push(x1 - bw, y1 - bw, c[0], c[1], c[2], c[3], x2 + bw, y1 + bw, c[0], c[1], c[2], c[3], x1 - bw, y1 + bw, c[0], c[1], c[2], c[3]);
          verts.push(x1 - bw, y2 - bw, c[0], c[1], c[2], c[3], x2 + bw, y2 - bw, c[0], c[1], c[2], c[3], x2 + bw, y2 + bw, c[0], c[1], c[2], c[3]);
          verts.push(x1 - bw, y2 - bw, c[0], c[1], c[2], c[3], x2 + bw, y2 + bw, c[0], c[1], c[2], c[3], x1 - bw, y2 + bw, c[0], c[1], c[2], c[3]);
        }
      }
    }

    return new Float32Array(verts);
  }

  function renderImages() {
    if (!imgLayer) return;
    imgLayer.innerHTML = '';
    const overlays = getOverlays();
    const rect = canvasEl.getBoundingClientRect();
    for (const o of overlays) {
      if ((o._visible as boolean) === false) continue;
      if (!isNodeVisible(o._nid as string)) continue;
      if ((o.type === 'ai-image') && (o._genImageUrl || o._genImage)) {
        const x1 = (Math.min(o.x1 as number, o.x2 as number) * zoom + panX) / dpr + rect.left;
        const y1 = (Math.min(o.y1 as number, o.y2 as number) * zoom + panY) / dpr + rect.top;
        const x2 = (Math.max(o.x1 as number, o.x2 as number) * zoom + panX) / dpr + rect.left;
        const y2 = (Math.max(o.y1 as number, o.y2 as number) * zoom + panY) / dpr + rect.top;
        const el = document.createElement('img');
        el.src = (o._genImageUrl as string) || ('data:image/jpeg;base64,' + o._genImage);
        el.style.cssText = `position:absolute;left:${x1}px;top:${y1}px;width:${x2 - x1}px;height:${y2 - y1}px;object-fit:cover;pointer-events:none;opacity:0.85`;
        imgLayer.appendChild(el);
      }
    }
  }

  function renderTexts() {
    if (!textLayer) return;
    textLayer.innerHTML = '';
    const overlays = getOverlays();
    for (const o of overlays) {
      if (o.type !== 'text' && o.type !== 'link') continue;
      if (!isNodeVisible(o._nid as string)) continue;
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:${(o.x as number) / dpr}px;top:${(o.y as number) / dpr}px;font-size:${o.fontSize || 20}px;color:${o.color || '#000'};font-weight:700;line-height:1.4;white-space:pre;pointer-events:none`;
      el.textContent = o.text as string;
      textLayer.appendChild(el);
    }
  }

  function isNodeVisible(nid: string): boolean {
    let cur = nid;
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return true;
      visited.add(cur);
      const n = findByNid(cur);
      if (!n) return true;
      if (n._visible === false) return false;
      cur = (n._parent as string) || '';
    }
    return true;
  }

  function render() {
    const hasRedraw = consumeRedraw();
    if (!hasRedraw && !isDrawing) { animId = requestAnimationFrame(render); return; }
    if (!renderFrame) { animId = requestAnimationFrame(render); return; }

    const data = tessellateAll();
    const vertCount = data.length / 6;
    renderFrame(data, vertCount);
    renderTexts();
    renderImages();
    animId = requestAnimationFrame(render);
  }

  onMount(async () => {
    dpr = devicePixelRatio || 1;
    canvasEl.width = (width || canvasEl.clientWidth) * dpr;
    canvasEl.height = (height || canvasEl.clientHeight) * dpr;
    try {
      await initGPU();
      gpuError = '';
      requestRedraw();
      animId = requestAnimationFrame(render);
    } catch (e: any) {
      console.error('WebGPU init failed:', e);
      try {
        initWebGL();
        gpuError = '';
        requestRedraw();
        animId = requestAnimationFrame(render);
      } catch (webglError: any) {
        renderBackend = 'none';
        renderFrame = null;
        gpuError = webglError?.message ?? e?.message ?? String(webglError ?? e);
        console.error('WebGL init failed:', webglError);
      }
    }
  });

  onDestroy(() => { if (animId) cancelAnimationFrame(animId); });
</script>

<div class="canvas-wrap">
  <canvas bind:this={canvasEl} id="draw"></canvas>
  <div bind:this={imgLayer} class="img-layer"></div>
  <div bind:this={textLayer} class="text-layer"></div>
  {#if gpuError}
    <div class="gpu-fallback">
      <div class="gpu-card">
        <h2>Canvas unavailable</h2>
        <p>
          Mangaka uses WebGPU by default and falls back to WebGL when needed. The document tree
          is loaded, but neither graphics backend could start in this browser.
        </p>
        <p class="gpu-detail">{gpuError}</p>
      </div>
    </div>
  {/if}
</div>

<style>
  .canvas-wrap { position:relative; flex:1; overflow:hidden; background:linear-gradient(180deg, #20242d 0%, #16191f 100%); }
  canvas { width:100%; height:100%; display:block; }
  .img-layer, .text-layer { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:4; }
  .text-layer { z-index:5; }
  .gpu-fallback {
    position:absolute;
    inset:0;
    display:grid;
    place-items:center;
    padding:24px;
    z-index:6;
    background:rgba(10, 12, 16, 0.52);
  }
  .gpu-card {
    max-width:520px;
    padding:24px;
    border:1px solid rgba(255, 255, 255, 0.14);
    border-radius:20px;
    background:rgba(20, 24, 31, 0.88);
    color:#f5f7fb;
    box-shadow:0 18px 60px rgba(0, 0, 0, 0.28);
  }
  .gpu-card h2 {
    margin:0 0 10px;
    font-size:24px;
  }
  .gpu-card p {
    margin:0;
    line-height:1.6;
    color:#c2cbda;
  }
  .gpu-detail {
    margin-top:12px !important;
    font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size:13px;
    color:#ffd6bf !important;
  }
</style>
