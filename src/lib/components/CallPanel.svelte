<script lang="ts">
  import {
    createKotobaCall,
    type CallStats,
    type KotobaCall,
    type KotobaCallOptions,
  } from '../call/index.js';

  interface Props {
    /** Connection options forwarded to `createKotobaCall`. */
    options: KotobaCallOptions;
    /** Peer player id to dial once started (1:1). Omit to only answer. */
    peerId?: number;
    /** Start capture + connect on mount. Default: false (user clicks Start). */
    autoStart?: boolean;
    class?: string;
  }

  let { options, peerId, autoStart = false, class: className }: Props = $props();

  let call = $state<KotobaCall>();
  let localStream = $state<MediaStream>();
  let remotes = $state<Record<number, MediaStream>>({});
  let status = $state<'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'>('idle');
  let micOn = $state(true);
  let camOn = $state(true);
  let sharing = $state(false);
  let stats = $state<Record<number, CallStats>>({});
  let errorMsg = $state('');

  /** Per-peer monitorStats unsubscribers (not reactive state). */
  const statStops = new Map<number, () => void>();

  function watchStats(id: number) {
    if (!call || statStops.has(id)) return;
    statStops.set(id, call.monitorStats(id, 2000, (s) => {
      if (s) stats = { ...stats, [id]: s };
    }));
  }
  function dropPeer(id: number) {
    statStops.get(id)?.();
    statStops.delete(id);
    const { [id]: _goneRemote, ...restRemotes } = remotes;
    remotes = restRemotes;
    const { [id]: _goneStat, ...restStats } = stats;
    stats = restStats;
  }

  /** Imperatively attach a MediaStream to a <video>/<audio> element. */
  function srcObject(node: HTMLMediaElement, stream: MediaStream) {
    node.srcObject = stream;
    return {
      update(next: MediaStream) { node.srcObject = next; },
      destroy() { node.srcObject = null; },
    };
  }

  async function start() {
    if (call) return;
    errorMsg = '';
    status = 'connecting';
    const c = createKotobaCall(options);
    call = c;

    c.on('localstream', (s) => { localStream = s; });
    c.on('open', () => { status = 'live'; });
    c.on('remotestream', (id, s) => { remotes = { ...remotes, [id]: s }; watchStats(id); });
    c.on('peerstate', (id, st) => { if (st === 'closed' || st === 'failed') dropPeer(id); });
    c.on('presence', (id, joined) => { if (!joined) dropPeer(id); });
    c.on('reconnecting', () => { status = 'reconnecting'; });
    c.on('close', () => { status = 'closed'; });
    c.on('error', (e) => { errorMsg = e.message; });

    try {
      await c.start();
      if (peerId !== undefined) c.dial(peerId);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      status = 'closed';
    }
  }

  function toggleMic() { micOn = call?.setMicEnabled(!micOn) ?? micOn; }
  function toggleCam() { camOn = call?.setCameraEnabled(!camOn) ?? camOn; }

  /** Swap the outgoing video for a screen-share track (reverts to camera on stop). */
  async function toggleShare() {
    if (!call) return;
    try {
      if (!sharing) {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = display.getVideoTracks()[0];
        track.addEventListener('ended', () => { void toggleShare(); });
        await call.replaceTrack(track);
        sharing = true;
      } else {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        await call.replaceTrack(cam.getVideoTracks()[0]);
        sharing = false;
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  function hangup() {
    for (const stop of statStops.values()) stop();
    statStops.clear();
    call?.close();
    call = undefined;
    localStream = undefined;
    remotes = {};
    stats = {};
    sharing = false;
    status = 'closed';
  }

  $effect(() => {
    if (autoStart) void start();
    return () => call?.close();
  });

  const remoteEntries = $derived(
    Object.entries(remotes).map(([id, stream]) => ({ id: Number(id), stream, stat: stats[Number(id)] })),
  );

  function quality(s: CallStats | undefined): string {
    if (!s) return '…';
    const parts: string[] = [];
    if (s.rttMs !== undefined) parts.push(`${s.rttMs}ms`);
    if (s.jitterMs !== undefined) parts.push(`jit ${s.jitterMs}ms`);
    if (s.packetsLost !== undefined) parts.push(`lost ${s.packetsLost}`);
    return parts.join(' · ') || '—';
  }
</script>

<div style="display:flex;flex-direction:column;gap:10px" class={className}>
  <div style="display:flex;gap:8px;align-items:center">
    <strong>kotoba call</strong>
    <span style="font-size:12px;opacity:0.7">{status}</span>
    {#if errorMsg}<span style="color:#c00;font-size:12px">{errorMsg}</span>{/if}
  </div>

  <div style="display:flex;gap:8px;flex-wrap:wrap">
    {#if !call}
      <button onclick={start}>Start</button>
    {:else}
      <button onclick={toggleMic}>{micOn ? 'Mute' : 'Unmute'}</button>
      <button onclick={toggleCam}>{camOn ? 'Camera off' : 'Camera on'}</button>
      <button onclick={toggleShare}>{sharing ? 'Stop share' : 'Share screen'}</button>
      <button onclick={hangup}>Hang up</button>
    {/if}
  </div>

  <div style="display:flex;gap:8px;flex-wrap:wrap">
    {#if localStream}
      <video use:srcObject={localStream} autoplay muted playsinline
             style="width:180px;border-radius:8px;background:#000"></video>
    {/if}
    {#each remoteEntries as { id, stream, stat } (id)}
      <div style="display:flex;flex-direction:column;gap:2px">
        <video use:srcObject={stream} autoplay playsinline
               style="width:240px;border-radius:8px;background:#000"
               aria-label={`peer ${id}`}></video>
        <span style="font-size:11px;opacity:0.7">peer {id} · {quality(stat)}</span>
      </div>
    {/each}
  </div>
</div>
