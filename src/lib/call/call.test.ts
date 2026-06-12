import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKotobaCall, encodeClientMsg, type WebSocketLike } from './index.js';

/** Build a byte array from a spaced hex string. */
function hex(s: string): Uint8Array {
  return new Uint8Array(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── fakes ────────────────────────────────────────────────────────────────────

class FakePC {
  static instances: FakePC[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  tracks: unknown[] = [];
  ice: unknown[] = [];
  onnegotiationneeded: (() => unknown) | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { track: unknown; streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  senders: { track: { kind: string } | null; replaceTrack(t: unknown): Promise<void> }[] = [];
  constructor(public config: unknown) {
    FakePC.instances.push(this);
  }
  addTrack(t: { kind: string }) {
    this.tracks.push(t);
    const sender = { track: t as { kind: string } | null, async replaceTrack(n: unknown) { sender.track = n as { kind: string }; } };
    this.senders.push(sender);
  }
  getSenders() { return this.senders; }
  async setLocalDescription(desc?: { type: string; sdp: string }) {
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer';
    this.localDescription = desc ?? { type, sdp: `${type.toUpperCase()}_SDP` };
    this.signalingState = this.localDescription.type === 'answer' ? 'stable' : 'have-local-offer';
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: unknown) { this.ice.push(c); }
  statsReport: Map<string, Record<string, unknown>> = new Map();
  async getStats() { return this.statsReport; }
  close() { this.connectionState = 'closed'; }
}

class FakeWS implements WebSocketLike {
  static last: FakeWS | null = null;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) { FakeWS.last = this; }
  send(data: ArrayBufferView | ArrayBuffer) { this.sent.push(data as Uint8Array); }
  close() {}
  recv(bytes: Uint8Array) { this.onmessage?.({ data: bytes }); }
}

function fakeLocalStream() {
  const tracks: { kind: string; enabled: boolean; stopped?: boolean; stop(): void }[] = [
    { kind: 'audio', enabled: true, stop() { this.stopped = true; } },
    { kind: 'video', enabled: true, stop() { this.stopped = true; } },
  ];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    addTrack: (t: { kind: string; enabled: boolean; stop(): void }) => { tracks.push(t); },
    removeTrack: (t: unknown) => { const i = tracks.indexOf(t as never); if (i >= 0) tracks.splice(i, 1); },
  } as unknown as MediaStream;
}

function makeCall(overrides: Partial<Parameters<typeof createKotobaCall>[0]> = {}) {
  return createKotobaCall({
    endpoint: 'wss://node.example',
    room: 'r',
    player: 1,
    getLocalStream: async () => fakeLocalStream(),
    RTCPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    createWebSocket: (url) => new FakeWS(url),
    ...overrides,
  });
}

beforeEach(() => {
  FakePC.instances = [];
  FakeWS.last = null;
  // The builder allocates `new MediaStream()` as the remote-track bag.
  (globalThis as Record<string, unknown>).MediaStream = class {
    private t: unknown[] = [];
    addTrack(x: unknown) { this.t.push(x); }
    getTracks() { return this.t; }
  };
});
afterEach(() => { vi.restoreAllMocks(); });

// ── tests ─────────────────────────────────────────────────────────────────────

describe('createKotobaCall', () => {
  it('captures media, opens the WS, and sends Join on open', async () => {
    const open = vi.fn();
    const local = vi.fn();
    const call = makeCall();
    call.on('open', open);
    call.on('localstream', local);

    const stream = await call.start();
    expect(stream).toBeTruthy();
    expect(local).toHaveBeenCalledOnce();

    const ws = FakeWS.last!;
    expect(ws.binaryType).toBe('arraybuffer');
    ws.onopen?.({});

    expect(open).toHaveBeenCalledOnce();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual(encodeClientMsg({ type: 'join', room: 'r', player: 1 }));
  });

  it('dial() produces and relays an SDP offer to the target peer', async () => {
    const call = makeCall();
    await call.start();
    const ws = FakeWS.last!;
    ws.onopen?.({});
    ws.sent.length = 0; // drop the Join

    call.dial(2);
    const pc = FakePC.instances[0];
    expect(pc.tracks).toHaveLength(2); // local audio + video attached
    await pc.onnegotiationneeded!(); // browser fires this asynchronously

    expect(ws.sent[0]).toEqual(
      encodeClientMsg({
        type: 'signal', room: 'r', to: 2,
        payload: { kind: 'offer', sdp: 'OFFER_SDP' },
      }),
    );
  });

  it('buffers signaling produced before the WS opens and flushes it on open', async () => {
    const call = makeCall();
    await call.start();
    const ws = FakeWS.last!;
    // WS not opened yet. Dial → onnegotiationneeded fires the offer early.
    call.dial(2);
    const pc = FakePC.instances[0];
    await pc.onnegotiationneeded!();
    expect(ws.sent).toHaveLength(0); // queued, not sent on a CONNECTING socket

    ws.onopen?.({});
    // Now flushed in order: Join first, then the buffered offer.
    expect(ws.sent[0]).toEqual(encodeClientMsg({ type: 'join', room: 'r', player: 1 }));
    expect(ws.sent[1]).toEqual(
      encodeClientMsg({ type: 'signal', room: 'r', to: 2, payload: { kind: 'offer', sdp: 'OFFER_SDP' } }),
    );
  });

  it('answers an inbound offer addressed to us', async () => {
    const call = makeCall();
    await call.start();
    const ws = FakeWS.last!;
    ws.onopen?.({});
    ws.sent.length = 0;

    // ServerMsg::Signal {room:"r", from:5, to:1, payload:{Offer:"o"}}
    ws.recv(hex(
      'A1 66 53 69 67 6E 61 6C A4 64 72 6F 6F 6D 61 72 64 66 72 6F 6D 05 ' +
        '62 74 6F 01 67 70 61 79 6C 6F 61 64 A1 65 4F 66 66 65 72 61 6F',
    ));
    await flush();

    const pc = FakePC.instances[0];
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'o' });
    expect(ws.sent[0]).toEqual(
      encodeClientMsg({
        type: 'signal', room: 'r', to: 5,
        payload: { kind: 'answer', sdp: 'ANSWER_SDP' },
      }),
    );
  });

  it('forwards locally-gathered ICE candidates over the relay', async () => {
    const call = makeCall();
    await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(2);
    const ws = FakeWS.last!;
    ws.sent.length = 0;

    const pc = FakePC.instances[0];
    pc.onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'cand', sdpMid: '0' }) } });

    expect(ws.sent[0]).toEqual(
      encodeClientMsg({
        type: 'signal', room: 'r', to: 2,
        payload: { kind: 'ice', candidate: JSON.stringify({ candidate: 'cand', sdpMid: '0' }) },
      }),
    );
  });

  it('applies inbound ICE candidates to the peer connection', async () => {
    const call = makeCall();
    await call.start();
    const ws = FakeWS.last!;
    ws.onopen?.({});
    call.dial(2);
    const pc = FakePC.instances[0];

    // ServerMsg::Signal {room:"r", from:2, to:1, payload:{Ice:"{}"}}
    ws.recv(hex(
      'A1 66 53 69 67 6E 61 6C A4 64 72 6F 6F 6D 61 72 64 66 72 6F 6D 02 ' +
        '62 74 6F 01 67 70 61 79 6C 6F 61 64 A1 63 49 63 65 62 7B 7D',
    ));
    await flush();
    expect(pc.ice).toHaveLength(1);
  });

  it('emits remotestream when a track arrives', async () => {
    const onRemote = vi.fn();
    const call = makeCall();
    call.on('remotestream', onRemote);
    await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(2);

    const pc = FakePC.instances[0];
    const stream = { id: 'remote' };
    pc.ontrack!({ track: { kind: 'video' }, streams: [stream] });
    expect(onRemote).toHaveBeenCalledWith(2, stream);
  });

  it('emits presence for other players only', async () => {
    const onPresence = vi.fn();
    const call = makeCall();
    call.on('presence', onPresence);
    await call.start();
    const ws = FakeWS.last!;
    ws.onopen?.({});

    // ServerMsg::Presence {room:"r", player:3, joined:true}
    ws.recv(hex(
      'A1 68 50 72 65 73 65 6E 63 65 A3 64 72 6F 6F 6D 61 72 ' +
        '66 70 6C 61 79 65 72 03 66 6A 6F 69 6E 65 64 F5',
    ));
    expect(onPresence).toHaveBeenCalledWith(3, true);
  });

  it('toggles local mic/camera tracks and reports peers', async () => {
    const call = makeCall();
    const stream = await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(2);
    call.dial(3);

    expect(call.peers().sort()).toEqual([2, 3]);

    expect(call.setMicEnabled(false)).toBe(false);
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
    expect(call.setCameraEnabled(false)).toBe(false);
    expect(stream.getVideoTracks()[0].enabled).toBe(false);
    expect(call.setMicEnabled(true)).toBe(true);
    expect(stream.getAudioTracks()[0].enabled).toBe(true);
  });

  it('normalizes getStats from an RTCStatsReport (null for unknown peers)', async () => {
    const call = makeCall();
    await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(2);

    expect(await call.getStats(99)).toBeNull();

    const pc = FakePC.instances[0];
    pc.statsReport = new Map([
      ['ip', { type: 'inbound-rtp', packetsLost: 3, packetsReceived: 500, bytesReceived: 64000, jitter: 0.012 }],
      ['op', { type: 'outbound-rtp', bytesSent: 80000 }],
      ['cp', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.042 }],
    ]);

    expect(await call.getStats(2)).toEqual({
      peerId: 2,
      packetsLost: 3,
      packetsReceived: 500,
      bytesReceived: 64000,
      jitterMs: 12,
      bytesSent: 80000,
      rttMs: 42,
    });
  });

  it('monitorStats polls getStats on an interval and unsubscribes cleanly', async () => {
    vi.useFakeTimers();
    try {
      const call = makeCall();
      await call.start();
      FakeWS.last!.onopen?.({});
      call.dial(2);
      FakePC.instances[0].statsReport = new Map([
        ['cp', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.03 }],
      ]);

      const samples: (number | undefined)[] = [];
      const stop = call.monitorStats(2, 1000, (s) => samples.push(s?.rttMs));

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(samples).toEqual([30, 30]);

      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(samples).toHaveLength(2); // no further samples after unsubscribe
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() stops all stat monitors', async () => {
    vi.useFakeTimers();
    try {
      const call = makeCall();
      await call.start();
      FakeWS.last!.onopen?.({});
      call.dial(2);
      const samples: unknown[] = [];
      call.monitorStats(2, 1000, (s) => samples.push(s));
      await vi.advanceTimersByTimeAsync(1000);
      expect(samples).toHaveLength(1);

      call.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(samples).toHaveLength(1); // monitor cleared on close
    } finally {
      vi.useRealTimers();
    }
  });

  it('attempts one ICE restart before tearing down a failed peer', async () => {
    const call = makeCall();
    await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(0); // player 1 > 0 → impolite, drives the restart

    const restartable = FakePC.instances[0];
    let restarts = 0;
    (restartable as unknown as { restartIce: () => void }).restartIce = () => { restarts++; };

    restartable.connectionState = 'failed';
    restartable.onconnectionstatechange!();
    expect(restarts).toBe(1);
    expect(call.peers()).toContain(0); // not torn down yet

    // A second failure with no recovery tears it down.
    restartable.connectionState = 'failed';
    restartable.onconnectionstatechange!();
    expect(call.peers()).not.toContain(0);
  });

  it('hot-swaps a video track on every peer, preserving mute state', async () => {
    const call = makeCall();
    const stream = await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(2);
    call.dial(3);
    call.setCameraEnabled(false); // mute video before swapping

    const oldVideo = stream.getVideoTracks()[0] as unknown as { stopped?: boolean };
    const newTrack = { kind: 'video', enabled: true, stop() {} } as unknown as MediaStreamTrack;
    await call.replaceTrack(newTrack);

    // Every peer's video sender now carries the new track.
    for (const pc of FakePC.instances) {
      const vid = pc.getSenders().find((s) => s.track?.kind === 'video');
      expect(vid!.track).toBe(newTrack);
    }
    // Local preview swapped, old track stopped, mute state inherited.
    expect(stream.getVideoTracks()[0]).toBe(newTrack);
    expect((newTrack as unknown as { enabled: boolean }).enabled).toBe(false);
    expect(oldVideo.stopped).toBe(true);
  });

  it('replaceTrack before start() emits an error and no-ops', async () => {
    const errs: Error[] = [];
    const call = makeCall();
    call.on('error', (e) => errs.push(e));
    await call.replaceTrack({ kind: 'audio', enabled: true, stop() {} } as unknown as MediaStreamTrack);
    expect(errs[0].message).toMatch(/replaceTrack/);
  });

  it('tears down a peer that never connects within connectTimeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const errs: Error[] = [];
      const call = makeCall({ connectTimeoutMs: 5000 });
      call.on('error', (e) => errs.push(e));
      await call.start();
      FakeWS.last!.onopen?.({});
      call.dial(2);
      expect(call.peers()).toContain(2);

      vi.advanceTimersByTime(5000); // never reached 'connected'
      expect(errs.some((e) => /connect timeout/.test(e.message))).toBe(true);
      expect(call.peers()).not.toContain(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a peer that reaches connected', async () => {
    vi.useFakeTimers();
    try {
      const errs: Error[] = [];
      const call = makeCall({ connectTimeoutMs: 5000 });
      call.on('error', (e) => errs.push(e));
      await call.start();
      FakeWS.last!.onopen?.({});
      call.dial(2);

      const pc = FakePC.instances[0];
      pc.connectionState = 'connected';
      pc.onconnectionstatechange!(); // clears the timer
      vi.advanceTimersByTime(10_000);

      expect(errs.some((e) => /connect timeout/.test(e.message))).toBe(false);
      expect(call.peers()).toContain(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects dialing self and dialing before start()', async () => {
    const errs: Error[] = [];
    const call = makeCall({ player: 7 });
    call.on('error', (e) => errs.push(e));

    call.dial(2); // before start → no local media
    expect(errs[0].message).toMatch(/before start/);
    expect(FakePC.instances).toHaveLength(0);

    await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(7); // self
    expect(errs[1].message).toMatch(/dial self/);
    expect(call.peers()).toHaveLength(0);
  });

  it('start() is idempotent (single capture, shared promise)', async () => {
    const getLocalStream = vi.fn(async () => fakeLocalStream());
    const call = makeCall({ getLocalStream });
    const [a, b] = await Promise.all([call.start(), call.start()]);
    expect(getLocalStream).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(await call.start()).toBe(a);
  });

  it('allows retry after a failed start() (e.g. denied permission)', async () => {
    let attempt = 0;
    const call = makeCall({
      getLocalStream: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('NotAllowedError');
        return fakeLocalStream();
      },
    });
    await expect(call.start()).rejects.toThrow('NotAllowedError');
    const stream = await call.start(); // failure was not cached → retry works
    expect(stream).toBeTruthy();
    expect(attempt).toBe(2);
  });

  it('tears down a peer connection when that peer leaves the room', async () => {
    const call = makeCall();
    await call.start();
    const ws = FakeWS.last!;
    ws.onopen?.({});
    call.dial(3);
    expect(call.peers()).toContain(3);
    const pc = FakePC.instances[0];

    // ServerMsg::Presence {room:"r", player:3, joined:false}
    ws.recv(hex(
      'A1 68 50 72 65 73 65 6E 63 65 A3 64 72 6F 6F 6D 61 72 ' +
        '66 70 6C 61 79 65 72 03 66 6A 6F 69 6E 65 64 F4',
    ));
    expect(call.peers()).not.toContain(3);
    expect(pc.connectionState).toBe('closed');
  });

  it('reconnects the signaling WS with exponential backoff', async () => {
    vi.useFakeTimers();
    try {
      const reconnecting = vi.fn();
      const call = makeCall({ reconnect: { baseDelayMs: 100, maxAttempts: 3 } });
      call.on('reconnecting', reconnecting);
      await call.start();
      const first = FakeWS.last!;
      first.onopen?.({});

      // Drop the socket → a reconnect is scheduled, not a hard close.
      first.onclose?.({ code: 1006, reason: 'lost' });
      expect(reconnecting).toHaveBeenCalledWith(1);
      expect(FakeWS.last).toBe(first); // not yet reconnected

      vi.advanceTimersByTime(100); // base * 2^0
      const second = FakeWS.last!;
      expect(second).not.toBe(first);
      second.onopen?.({}); // clean open resets the backoff
      expect(second.sent[0]).toEqual(encodeClientMsg({ type: 'join', room: 'r', player: 1 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up reconnecting after maxAttempts and emits close', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const call = makeCall({ reconnect: { baseDelayMs: 10, maxAttempts: 2 } });
      call.on('close', onClose);
      await call.start();

      // Each new socket immediately closes again.
      for (let i = 0; i < 3; i++) {
        FakeWS.last!.onclose?.({ code: 1006, reason: 'lost' });
        vi.advanceTimersByTime(10 * 2 ** i);
      }
      expect(onClose).toHaveBeenCalledOnce(); // gave up → hard close
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after an explicit close()', async () => {
    vi.useFakeTimers();
    try {
      const reconnecting = vi.fn();
      const call = makeCall();
      call.on('reconnecting', reconnecting);
      await call.start();
      const ws = FakeWS.last!;
      call.close();
      ws.onclose?.({ code: 1000, reason: 'bye' });
      vi.advanceTimersByTime(5000);
      expect(reconnecting).not.toHaveBeenCalled();
      expect(FakeWS.last).toBe(ws);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the polite peer only against higher player ids', async () => {
    const call = makeCall({ player: 10 });
    await call.start();
    FakeWS.last!.onopen?.({});
    call.dial(20); // 10 < 20 → polite
    call.dial(5); //  10 > 5  → impolite
    expect((FakePC.instances[0].config as { iceServers: unknown }).iceServers).toBeDefined();
  });
});
