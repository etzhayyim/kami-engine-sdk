/**
 * 1:1 (mesh-ready) real-media WebRTC call over the kotoba realtime signaling
 * relay.
 *
 * The browser owns the media plane end to end — capture (getUserMedia), codecs,
 * SRTP, jitter buffer, ICE/DTLS all live in `RTCPeerConnection`. This builder
 * only orchestrates it and shuttles SDP/ICE through the authority's existing
 * `ClientMsg::Signal` relay (`kotoba-rt`), which forwards the payload to a peer
 * without parsing it.
 *
 * Glare (both sides offering at once) is resolved with the WHATWG "perfect
 * negotiation" pattern; the polite peer is the one with the lower player id, so
 * the two ends always disagree on politeness.
 *
 * Headless and SSR-safe: `RTCPeerConnection`, `WebSocket`, and the media-capture
 * call are all injectable, so the state machine is unit-testable without a DOM.
 */

import {
  buildConnectUrl,
  decodeServerMsg,
  encodeClientMsg,
  type ClientMsg,
  type ServerMsg,
  type SignalPayload,
} from './wire.js';

export type PeerConnectionState = RTCPeerConnectionState;

export interface KotobaCallEvents {
  /** WS opened and Join sent. */
  open: () => void;
  /** Local capture acquired. */
  localstream: (stream: MediaStream) => void;
  /** A peer's remote media is available (or replaced). */
  remotestream: (peerId: number, stream: MediaStream) => void;
  /** A peer's `RTCPeerConnection` lifecycle state changed. */
  peerstate: (peerId: number, state: PeerConnectionState) => void;
  /** Room presence change relayed by the authority. */
  presence: (peerId: number, joined: boolean) => void;
  /** Signaling WS dropped and a reconnect is scheduled (1-based attempt). */
  reconnecting: (attempt: number) => void;
  /** WS closed. */
  close: (code: number, reason: string) => void;
  /** Any non-fatal error (signaling/negotiation). */
  error: (err: Error) => void;
}

type Listeners = { [K in keyof KotobaCallEvents]: Set<KotobaCallEvents[K]> };

/** A minimal WebSocket surface — lets tests inject a fake. */
export interface WebSocketLike {
  binaryType: string;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface KotobaCallOptions {
  /** Node origin (`wss://node.example`) or full XRPC connect URL. */
  endpoint: string;
  /** Room to join. */
  room: string;
  /** This client's player id. */
  player: number;
  /** Room token (HS256 JWT) when the node enforces one. */
  token?: string;
  /** ICE servers (STUN, and TURN once the pure-Rust relay is deployed). */
  iceServers?: RTCIceServer[];
  /** Capture constraints. Default: audio only. */
  media?: MediaStreamConstraints;
  /** Auto-answer offers from peers we did not dial. Default: true. */
  autoAnswer?: boolean;
  /**
   * Signaling-WS reconnect policy. Media (P2P) survives a brief signaling drop;
   * reconnecting restores the renegotiation/ICE-restart path. Default: enabled,
   * 5 attempts, 500 ms base with exponential backoff.
   */
  reconnect?: { enabled?: boolean; maxAttempts?: number; baseDelayMs?: number };
  /**
   * Tear down and report a peer that never reaches `connected` within this many
   * ms (e.g. no viable ICE path without TURN). Default 20000; 0 disables.
   */
  connectTimeoutMs?: number;
  /** Override capture (tests / screen share / pre-acquired stream). */
  getLocalStream?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Inject an `RTCPeerConnection` ctor (tests / non-DOM runtimes). */
  RTCPeerConnectionCtor?: typeof RTCPeerConnection;
  /** Inject a `WebSocket` factory (tests / non-DOM runtimes). */
  createWebSocket?: (url: string) => WebSocketLike;
}

/** Normalized, transport-agnostic snapshot of a peer connection's quality. */
export interface CallStats {
  peerId: number;
  /** Selected candidate-pair round-trip time, milliseconds. */
  rttMs?: number;
  /** Inbound jitter, milliseconds. */
  jitterMs?: number;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  bytesSent?: number;
}

export interface KotobaCall {
  /** Acquire local media, open the WS, and Join the room. */
  start(): Promise<MediaStream>;
  /** Initiate a connection to a specific peer (1:1: dial the callee). */
  dial(peerId: number): void;
  /** Tear down one peer (or all peers when omitted). */
  hangup(peerId?: number): void;
  /** Local capture, once `start()` has resolved. */
  readonly localStream: MediaStream | null;
  /** Player ids of the peers we currently hold a connection to. */
  peers(): number[];
  /** Enable/disable the local microphone track(s). Returns the new state. */
  setMicEnabled(enabled: boolean): boolean;
  /** Enable/disable the local camera track(s). Returns the new state. */
  setCameraEnabled(enabled: boolean): boolean;
  /** Hot-swap the outgoing track of `track.kind` on every peer (device switch). */
  replaceTrack(track: MediaStreamTrack): Promise<void>;
  /** Sample normalized connection-quality stats for a peer (null if unknown). */
  getStats(peerId: number): Promise<CallStats | null>;
  /** Poll `getStats(peerId)` every `intervalMs`; returns an unsubscribe fn. */
  monitorStats(peerId: number, intervalMs: number, cb: (stats: CallStats | null) => void): () => void;
  /** Subscribe to an event; returns an unsubscribe fn. */
  on<K extends keyof KotobaCallEvents>(event: K, handler: KotobaCallEvents[K]): () => void;
  /** Close the WS and all peer connections. */
  close(): void;
}

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  restarted: boolean;
  /** Cleared once the peer reaches `connected`; fires teardown otherwise. */
  connectTimer: ReturnType<typeof setTimeout> | null;
  remote: MediaStream;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createKotobaCall(opts: KotobaCallOptions): KotobaCall {
  const media: MediaStreamConstraints = opts.media ?? { audio: true };
  const autoAnswer = opts.autoAnswer ?? true;
  const iceServers = opts.iceServers ?? DEFAULT_ICE;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
  const PC = opts.RTCPeerConnectionCtor ?? globalThis.RTCPeerConnection;

  const listeners: Listeners = {
    open: new Set(), localstream: new Set(), remotestream: new Set(),
    peerstate: new Set(), presence: new Set(), reconnecting: new Set(),
    close: new Set(), error: new Set(),
  };
  const reconnectCfg = {
    enabled: opts.reconnect?.enabled ?? true,
    maxAttempts: opts.reconnect?.maxAttempts ?? 5,
    baseDelayMs: opts.reconnect?.baseDelayMs ?? 500,
  };
  const peers = new Map<number, Peer>();
  let ws: WebSocketLike | null = null;
  let wsOpen = false;
  /** Signaling frames produced while the WS is not OPEN (initial connect / a
   *  reconnect gap); flushed in order once it opens, so no offer/ICE is lost. */
  const pendingFrames: Uint8Array[] = [];
  let localStream: MediaStream | null = null;
  let startPromise: Promise<MediaStream> | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let micEnabled = true;
  let camEnabled = true;
  const statMonitors = new Set<ReturnType<typeof setInterval>>();
  let closed = false;

  function emit<K extends keyof KotobaCallEvents>(
    event: K, ...args: Parameters<KotobaCallEvents[K]>
  ): void {
    for (const h of listeners[event]) {
      try {
        (h as (...a: unknown[]) => void)(...args);
      } catch (e) {
        // A listener throwing must not break signaling.
        if (event !== 'error') emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  function send(msg: ClientMsg): void {
    const frame = encodeClientMsg(msg);
    // Buffer until the socket is OPEN — sending on a CONNECTING WebSocket throws
    // and would silently drop an offer/ICE produced before onopen.
    if (!ws || !wsOpen) {
      pendingFrames.push(frame);
      return;
    }
    try {
      ws.send(frame);
    } catch (e) {
      emit('error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  function ensurePeer(peerId: number): Peer {
    let peer = peers.get(peerId);
    if (peer) return peer;

    const pc = new PC({ iceServers });
    const remote = new MediaStream();
    peer = {
      pc, polite: opts.player < peerId, makingOffer: false, ignoreOffer: false,
      restarted: false, connectTimer: null, remote,
    };
    peers.set(peerId, peer);

    if (connectTimeoutMs > 0) {
      peer.connectTimer = setTimeout(() => {
        peer!.connectTimer = null;
        if (pc.connectionState !== 'connected') {
          emit('error', new Error(`peer ${peerId} connect timeout (${connectTimeoutMs}ms)`));
          hangup(peerId);
        }
      }, connectTimeoutMs);
    }

    // Attach local tracks so negotiation has media to offer.
    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer!.makingOffer = true;
        await pc.setLocalDescription();
        const sdp = pc.localDescription?.sdp ?? '';
        send({ type: 'signal', room: opts.room, to: peerId, payload: { kind: 'offer', sdp } });
      } catch (e) {
        emit('error', e instanceof Error ? e : new Error(String(e)));
      } finally {
        peer!.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return; // skip end-of-candidates for MVP
      send({
        type: 'signal', room: opts.room, to: peerId,
        payload: { kind: 'ice', candidate: JSON.stringify(candidate.toJSON()) },
      });
    };

    pc.ontrack = ({ track, streams }) => {
      // Prefer the stream the sender grouped tracks into; fall back to our bag.
      const stream = streams[0] ?? remote;
      if (stream === remote) remote.addTrack(track);
      emit('remotestream', peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      emit('peerstate', peerId, pc.connectionState);
      // 'disconnected' is often transient — ICE may recover on its own, so we
      // wait rather than tear down. On a hard 'failed', try one ICE restart (the
      // impolite/offerer drives it) before giving up.
      if (pc.connectionState === 'failed') {
        if (!peer!.restarted && !peer!.polite && typeof pc.restartIce === 'function') {
          peer!.restarted = true;
          pc.restartIce();
        } else {
          hangup(peerId);
        }
      } else if (pc.connectionState === 'closed') {
        hangup(peerId);
      } else if (pc.connectionState === 'connected') {
        peer!.restarted = false; // recovered — allow a future restart
        if (peer!.connectTimer) { clearTimeout(peer!.connectTimer); peer!.connectTimer = null; }
      }
    };

    return peer;
  }

  async function onSignal(from: number, payload: SignalPayload): Promise<void> {
    const peer = ensurePeer(from);
    const { pc } = peer;
    try {
      if (payload.kind === 'offer' || payload.kind === 'answer') {
        const description: RTCSessionDescriptionInit = { type: payload.kind, sdp: payload.sdp };
        const offerCollision =
          payload.kind === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (payload.kind === 'offer') {
          await pc.setLocalDescription();
          const sdp = pc.localDescription?.sdp ?? '';
          send({ type: 'signal', room: opts.room, to: from, payload: { kind: 'answer', sdp } });
        }
      } else {
        // ICE candidate.
        try {
          await pc.addIceCandidate(JSON.parse(payload.candidate));
        } catch (e) {
          if (!peer.ignoreOffer) throw e; // candidates may race a rolled-back offer
        }
      }
    } catch (e) {
      emit('error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  function handleServerMsg(msg: ServerMsg): void {
    switch (msg.type) {
      case 'signal':
        if (msg.to === opts.player) void onSignal(msg.from, msg.payload);
        break;
      case 'presence':
        if (msg.player !== opts.player) {
          // A peer that left can never complete or recover its connection —
          // close it so we don't leak an RTCPeerConnection or a stale stream.
          if (!msg.joined && peers.has(msg.player)) hangup(msg.player);
          emit('presence', msg.player, msg.joined);
        }
        break;
      case 'welcome':
      case 'other':
        break;
    }
  }

  function dial(peerId: number): void {
    if (peerId === opts.player) {
      emit('error', new Error('cannot dial self'));
      return;
    }
    if (!localStream) {
      emit('error', new Error('dial() before start(): no local media to offer'));
      return;
    }
    // Creating the peer with local tracks attached triggers onnegotiationneeded,
    // which produces and sends the offer.
    ensurePeer(peerId);
  }

  function hangup(peerId?: number): void {
    const ids = peerId === undefined ? [...peers.keys()] : [peerId];
    for (const id of ids) {
      const peer = peers.get(id);
      if (!peer) continue;
      if (peer.connectTimer) { clearTimeout(peer.connectTimer); peer.connectTimer = null; }
      try { peer.pc.close(); } catch { /* already closed */ }
      peers.delete(id);
    }
  }

  function connectWs(): void {
    const url = buildConnectUrl(opts.endpoint, {
      room: opts.room, player: opts.player, token: opts.token,
    });
    ws = opts.createWebSocket ? opts.createWebSocket(url) : (new WebSocket(url) as unknown as WebSocketLike);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectAttempts = 0; // a clean open resets the backoff
      wsOpen = true;
      // (Re)assert room membership first; existing peer connections are
      // untouched, so media keeps flowing and renegotiation can resume.
      send({ type: 'join', room: opts.room, player: opts.player });
      // Flush any signaling buffered while the socket was connecting/reconnecting.
      const queued = pendingFrames.splice(0);
      for (const frame of queued) {
        try { ws!.send(frame); } catch (e) { emit('error', e instanceof Error ? e : new Error(String(e))); }
      }
      emit('open');
    };
    ws.onmessage = (ev) => {
      const data = ev.data;
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data)
        : data instanceof Uint8Array ? data
        : null;
      if (!bytes) return; // ignore text frames
      try {
        handleServerMsg(decodeServerMsg(bytes));
      } catch (e) {
        emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onclose = (ev) => {
      wsOpen = false; // subsequent signaling buffers until the next open
      if (closed) return;
      if (reconnectCfg.enabled && reconnectAttempts < reconnectCfg.maxAttempts) {
        reconnectAttempts += 1;
        // Exponential backoff: base * 2^(attempt-1).
        const delay = reconnectCfg.baseDelayMs * 2 ** (reconnectAttempts - 1);
        emit('reconnecting', reconnectAttempts);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, delay);
      } else {
        emit('close', ev.code, ev.reason);
      }
    };
    ws.onerror = () => emit('error', new Error('websocket error'));
  }

  async function startOnce(): Promise<MediaStream> {
    const capture = opts.getLocalStream
      ? opts.getLocalStream(media)
      : navigator.mediaDevices.getUserMedia(media);
    localStream = await capture;
    emit('localstream', localStream);
    connectWs();
    return localStream;
  }

  /** Idempotent: concurrent or repeat calls share the first capture+connect.
   *  A *failed* start (e.g. denied camera/mic permission) is not cached — the
   *  promise is cleared on rejection so the app can retry. */
  function start(): Promise<MediaStream> {
    if (closed) return Promise.reject(new Error('call is closed'));
    if (!startPromise) {
      startPromise = startOnce();
      startPromise.catch(() => { startPromise = null; });
    }
    return startPromise;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    for (const t of statMonitors) clearInterval(t);
    statMonitors.clear();
    if (ws) {
      send({ type: 'leave', room: opts.room, player: opts.player });
      try { ws.close(1000, 'bye'); } catch { /* noop */ }
    }
    hangup();
    if (localStream) for (const t of localStream.getTracks()) t.stop();
    emit('close', 1000, 'client closed');
  }

  function setTrackEnabled(kind: 'audio' | 'video', enabled: boolean): boolean {
    if (kind === 'audio') micEnabled = enabled; else camEnabled = enabled;
    if (!localStream) return false;
    const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
    for (const t of tracks) t.enabled = enabled;
    return tracks.length > 0 ? enabled : false;
  }

  /**
   * Hot-swap the outgoing track of `track.kind` on every peer — device switch
   * or screen-share, no renegotiation. Replaces an EXISTING track of that kind;
   * adding a kind the call didn't start with (audio-only → +video) needs a
   * renegotiation path and is out of scope here. The new track inherits the
   * current mute state; the replaced local track is stopped to free the device.
   */
  async function replaceTrack(track: MediaStreamTrack): Promise<void> {
    if (!localStream) { emit('error', new Error('replaceTrack() before start()')); return; }
    const kind = track.kind as 'audio' | 'video';
    track.enabled = kind === 'audio' ? micEnabled : camEnabled;
    await Promise.all([...peers.values()].map(async (peer) => {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && sender.track.kind === kind) await sender.replaceTrack(track);
      }
    }));
    const old = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
    for (const t of old) { localStream.removeTrack(t); t.stop(); }
    localStream.addTrack(track);
  }

  async function sampleStats(peerId: number): Promise<CallStats | null> {
    const peer = peers.get(peerId);
    if (!peer) return null;
    const report = await peer.pc.getStats();
    const stats: CallStats = { peerId };
    report.forEach((s: Record<string, unknown>) => {
      const type = s.type as string;
      if (type === 'inbound-rtp') {
        if (typeof s.packetsLost === 'number') stats.packetsLost = (stats.packetsLost ?? 0) + s.packetsLost;
        if (typeof s.packetsReceived === 'number') stats.packetsReceived = (stats.packetsReceived ?? 0) + s.packetsReceived;
        if (typeof s.bytesReceived === 'number') stats.bytesReceived = (stats.bytesReceived ?? 0) + s.bytesReceived;
        if (typeof s.jitter === 'number') stats.jitterMs = Math.round(s.jitter * 1000);
      } else if (type === 'outbound-rtp') {
        if (typeof s.bytesSent === 'number') stats.bytesSent = (stats.bytesSent ?? 0) + s.bytesSent;
      } else if (type === 'candidate-pair' && (s.nominated === true || s.state === 'succeeded')) {
        if (typeof s.currentRoundTripTime === 'number') stats.rttMs = Math.round(s.currentRoundTripTime * 1000);
      }
    });
    return stats;
  }

  function monitorStats(
    peerId: number, intervalMs: number, cb: (stats: CallStats | null) => void,
  ): () => void {
    const timer = setInterval(() => { void sampleStats(peerId).then(cb); }, intervalMs);
    statMonitors.add(timer);
    return () => { clearInterval(timer); statMonitors.delete(timer); };
  }

  return {
    start,
    dial,
    hangup,
    replaceTrack,
    get localStream() { return localStream; },
    peers() { return [...peers.keys()]; },
    setMicEnabled(enabled) { return setTrackEnabled('audio', enabled); },
    setCameraEnabled(enabled) { return setTrackEnabled('video', enabled); },
    getStats: sampleStats,
    monitorStats,
    on(event, handler) {
      listeners[event].add(handler as never);
      return () => listeners[event].delete(handler as never);
    },
    close,
  };
}
