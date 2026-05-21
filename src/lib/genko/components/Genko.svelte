<script lang="ts">
  /**
   * Genko — Root manga editor component.
   * Composes: ProjectSelect + NodeTree (left) + Toolbar + Canvas (center) +
   *           ChatPanel (right) + FloatingTools (bottom) + AuthStatus (top-right).
   */
  import { onMount } from 'svelte';
  import NodeTree from './NodeTree.svelte';
  import Canvas from './Canvas.svelte';
  import Toolbar from './Toolbar.svelte';
  import FloatingTools from './FloatingTools.svelte';
  import ChatPanel from './ChatPanel.svelte';
  import AuthStatus from './AuthStatus.svelte';
  import ProjectSelect from './ProjectSelect.svelte';
  import {
    getDoc, setDoc, loadPage, saveCurrentPage, requestRedraw,
    setInitDone, nid, pid, type GenkoDoc,
  } from '../stores/doc.svelte';
  import {
    getSession, initAuth, redirectToAuth, authHeaders, type AuthSession,
  } from '../stores/auth.svelte';
  import {
    getProjects, getActiveProjectId, loadProjects, switchProject, createProject,
    type GenkoProject,
  } from '../stores/project.svelte';

  let { nanoid = '', name = 'Mangaka' }: { nanoid?: string; name?: string } = $props();

  const doc = $derived(getDoc());

  // Canvas state
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let activeYoushi = $state('b4manga');
  let activeBrush = $state('fine');
  let activeMode = $state('draw');
  let brushColor = $state<[number, number, number, number]>([0.2, 0.2, 0.2, 1]);
  let brushSize = $state(2);

  // Auth + project state
  let session = $state<AuthSession | null>(null);
  let projects = $state<GenkoProject[]>([]);
  let activeProjectId = $state('');

  // Chat state — default mangaka actor roster (storyboard / lineart / toner / letterer)
  const defaultMembers = [
    { displayName: 'Storyboard', style: 'storyboard', role: 'ネーム (LLM)' },
    { displayName: 'Lineart', style: 'lineart', role: 'ペン入れ (KAMI canvas)' },
    { displayName: 'Toner', style: 'toner', role: 'トーン (image gen)' },
    { displayName: 'Letterer', style: 'letterer', role: '写植 (OCR + layout)' },
  ];
  let members = $state(defaultMembers);
  let messages = $state<{ sender: string; text: string; isUser: boolean }[]>([]);

  // Color conversion (Canvas uses RGBA array, HTML color input uses #rrggbb).
  function rgbaToHex(c: number[]): string {
    const r = Math.round(((c[0] ?? 0)) * 255);
    const g = Math.round(((c[1] ?? 0)) * 255);
    const b = Math.round(((c[2] ?? 0)) * 255);
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }
  function hexToRgba(hex: string): [number, number, number, number] {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [0, 0, 0, 1];
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, 1];
  }
  const brushColorHex = $derived(rgbaToHex(brushColor));

  // XRPC helper
  const XRPC_BASE = typeof location !== 'undefined' ? location.origin + '/xrpc/' : '/xrpc/';
  async function xrpc(method: string, body: Record<string, unknown>) {
    const resp = await fetch(XRPC_BASE + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (resp.status === 401) throw new Error('auth required');
    return resp.json();
  }

  // AT URI deep-link
  function parseAtUri(): { authority: string; collection: string; rkey: string } | null {
    if (typeof location === 'undefined') return null;
    const m = location.pathname.match(/^\/at\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return { authority: m[1], collection: m[2], rkey: decodeURIComponent(m[3]) };
  }

  function safeDeserialize(json: string): boolean {
    try {
      const d: GenkoDoc = JSON.parse(json);
      if (d?.pages?.length) {
        setInitDone(false);
        setDoc(d);
        loadPage(d.activePageIdx || 0);
        setInitDone(true);
        requestRedraw();
        return true;
      }
    } catch (e) { console.warn('deserialize failed:', e); }
    return false;
  }

  /** Build project TOC document from project data. */
  function buildProjectToc(project: Record<string, unknown>): GenkoDoc {
    const docs = (project.documents || []) as Array<Record<string, unknown>>;
    const appHost = nanoid + '.etzhayyim.com';
    const nodes: Array<Record<string, unknown>> = [];
    const titleNid = nid();
    nodes.push({ id: titleNid, type: 'text', visible: true, data: { type: 'text', _nid: titleNid, _visible: true, text: project.name || 'Project', x: 300, y: 200, fontSize: 52, color: '#222', font: 'sans' } });

    const arcMap = new Map<string, Array<Record<string, unknown>>>();
    for (const d of docs) {
      const arc = (d.arc as string) || 'Other';
      if (!arcMap.has(arc)) arcMap.set(arc, []);
      arcMap.get(arc)!.push(d);
    }

    for (const [arc, epDocs] of arcMap) {
      const groupNid = nid();
      nodes.push({ id: groupNid, type: 'group', visible: true, data: { type: 'group', _nid: groupNid, _visible: true, groupName: arc } });
      for (const d of epDocs) {
        const linkNid = nid();
        nodes.push({ id: linkNid, type: 'link', visible: true, data: {
          type: 'link', _nid: linkNid, _visible: true, _parent: groupNid,
          _href: '/at/' + appHost + '/ai.gftd.apps.mangaka.document/' + d.docId,
          linkTitle: d.title || d.docId, _subtitle: (d.pages || 0) + 'p' + (d.images ? ' ' + d.images + 'img' : ''),
          text: d.title || d.docId, x: 320, y: 400, fontSize: 20, color: '#307050', font: 'sans',
        } });
      }
    }

    return {
      name: (project.name as string) || 'Project', docId: (project.projectId as string) || 'proj',
      convoId: (project.convoId as string) || '',
      pages: [{ id: pid(), name: (project.name as string) || 'Project', youshi: { id: nid(), type: 'b4manga', visible: true }, nodes: nodes as any }],
      activePageIdx: 0,
    };
  }

  async function resolveAtUri() {
    const at = parseAtUri();
    if (!at) return false;
    const isProject = at.collection.endsWith('.project');

    try {
      if (isProject) {
        const r = await xrpc('ai.gftd.apps.mangaka.loadProject', { projectId: at.rkey });
        if (r.error) return false;
        return safeDeserialize(JSON.stringify(buildProjectToc(r)));
      } else {
        const r = await xrpc('ai.gftd.apps.mangaka.loadDocument', { docId: at.rkey });
        const docStr = r.document || r.value_b64;
        if (docStr) return safeDeserialize(docStr);
      }
    } catch (e) { console.warn('AT URI resolve:', e); }
    return false;
  }

  // Auto-save
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutoSave() {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('mangaka-' + nanoid, JSON.stringify(getDoc()));
      } catch (error) {
        console.warn('[silent-fail] Genko.svelte: local draft save failed', error);
      }
    }
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      const d = getDoc();
      saveCurrentPage();
      try {
        await xrpc('ai.gftd.apps.mangaka.saveDocument', { docId: d.docId, name: d.name, document: JSON.stringify(d), convoId: d.convoId || '' });
      } catch (e) { console.warn('auto-save:', e); }
    }, 5000);
  }

  function handleTreeChange() {
    requestRedraw();
    scheduleAutoSave();
  }

  // ── Toolbar handlers ──
  function onYoushiChange(type: string) { activeYoushi = type; requestRedraw(); }
  async function onSaveDoc() {
    const d = getDoc();
    saveCurrentPage();
    try {
      await xrpc('ai.gftd.apps.mangaka.saveDocument', {
        docId: d.docId, name: d.name, document: JSON.stringify(d), convoId: d.convoId || '',
      });
    } catch (e) { console.warn('saveDocument:', e); }
  }
  function onLoadDoc() {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') safeDeserialize(reader.result);
      };
      reader.readAsText(file);
    };
    input.click();
  }
  function onSavePng() { console.info('onSavePng: not implemented'); }
  function onSaveSvg() { console.info('onSaveSvg: not implemented'); }
  function onExportOpLog() { console.info('onExportOpLog: not implemented'); }
  function onImportOpLog() { console.info('onImportOpLog: not implemented'); }

  // ── FloatingTools handlers ──
  function onModeChange(mode: string) { activeMode = mode; }
  function onBrushChange(brush: string) { activeBrush = brush; }
  function onColorChange(hex: string) { brushColor = hexToRgba(hex); requestRedraw(); }
  function onSizeChange(size: number) { brushSize = size; requestRedraw(); }
  function onUndo() { console.info('onUndo: not implemented'); }
  function onRedo() { console.info('onRedo: not implemented'); }

  // ── ChatPanel handlers ──
  async function onSend(text: string) {
    messages = [...messages, { sender: 'You', text, isUser: true }];
    try {
      const r = await xrpc('ai.gftd.apps.mangaka.chat', { message: text, convoId: activeProjectId });
      if (r?.reply) {
        messages = [...messages, { sender: r.sender || 'Mangaka', text: r.reply, isUser: false }];
      }
    } catch (e) {
      console.warn('chat:', e);
    }
  }
  function onActorClick(style: string) { console.info('onActorClick:', style); }

  // ── AuthStatus handler ──
  function onSignIn() { redirectToAuth(nanoid); }

  // ── ProjectSelect handlers ──
  function onProjectSelect(convoId: string) {
    activeProjectId = convoId;
    switchProject(convoId, nanoid);
  }
  async function onProjectCreate() {
    if (typeof prompt === 'undefined') return;
    const pname = prompt('Project name?');
    if (!pname) return;
    const p = await createProject(pname, '', nanoid);
    if (p) {
      projects = [...getProjects()];
      activeProjectId = p.convoId;
    }
  }
  async function onProjectRefresh() {
    try {
      await loadProjects(nanoid);
      projects = [...getProjects()];
      activeProjectId = getActiveProjectId();
    } catch (e) { console.warn('refresh projects:', e); }
  }

  onMount(async () => {
    session = initAuth();

    const atPath = parseAtUri();
    if (!atPath) {
      try {
        const sv = localStorage.getItem('mangaka-' + nanoid);
        if (sv) safeDeserialize(sv);
      } catch (error) {
        console.warn('[silent-fail] Genko.svelte: local draft restore failed', error);
      }
    }
    setInitDone(true);

    setTimeout(async () => {
      if (atPath) await resolveAtUri();
      try {
        await loadProjects(nanoid);
        projects = [...getProjects()];
        activeProjectId = getActiveProjectId();
      } catch (e) { console.warn('load projects:', e); }
    }, 300);
  });
</script>

<svelte:head><title>{name}</title></svelte:head>

<div class="genko">
  <aside class="genko-left">
    <div class="genko-project-select">
      <ProjectSelect
        {projects}
        {activeProjectId}
        onselect={onProjectSelect}
        oncreate={onProjectCreate}
        onrefresh={onProjectRefresh}
      />
    </div>
    <div class="genko-tree">
      <NodeTree {nanoid} onchange={handleTreeChange} />
    </div>
  </aside>
  <main class="genko-center">
    <div class="genko-topbar">
      <div class="genko-toolbar-slot">
        <Toolbar
          {activeYoushi}
          onyoushichange={onYoushiChange}
          onsavepng={onSavePng}
          onsavesvg={onSaveSvg}
          onsavedoc={onSaveDoc}
          onloaddoc={onLoadDoc}
          onexportoplog={onExportOpLog}
          onimportoplog={onImportOpLog}
        />
      </div>
      <div class="genko-auth-slot">
        <AuthStatus {session} onsignin={onSignIn} />
      </div>
    </div>
    <div class="genko-canvas">
      <Canvas
        {zoom} {panX} {panY} {activeYoushi}
        {activeBrush} {activeMode}
        {brushColor} {brushSize}
      />
      <div class="genko-floating">
        <FloatingTools
          {activeMode}
          {activeBrush}
          brushColor={brushColorHex}
          {brushSize}
          onmodechange={onModeChange}
          onbrushchange={onBrushChange}
          oncolorchange={onColorChange}
          onsizechange={onSizeChange}
          onundo={onUndo}
          onredo={onRedo}
        />
      </div>
    </div>
  </main>
  <aside class="genko-right">
    <ChatPanel
      {members}
      {messages}
      onsend={onSend}
      onactorclick={onActorClick}
    />
  </aside>
</div>

<style>
  .genko {
    display: flex;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    font-family: 'Nunito', 'Noto Sans JP', sans-serif;
  }
  .genko-left {
    flex-shrink: 0;
    width: 260px;
    height: 100%;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #2a2a2e;
    background: #1a1a1f;
  }
  .genko-project-select {
    flex-shrink: 0;
    border-bottom: 1px solid #2a2a30;
  }
  .genko-tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .genko-center {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0f1115;
  }
  .genko-topbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid #2a2a30;
  }
  .genko-toolbar-slot {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }
  .genko-auth-slot {
    flex-shrink: 0;
    padding-right: 10px;
  }
  .genko-canvas {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .genko-floating {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    pointer-events: none;
  }
  .genko-floating > :global(.floating-tools) {
    position: static !important;
    transform: none !important;
    pointer-events: auto;
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .genko-right {
    flex-shrink: 0;
    height: 100%;
    border-left: 1px solid #2a2a30;
  }

  @media (max-width: 1100px) {
    .genko-left { width: 220px; }
  }
</style>
