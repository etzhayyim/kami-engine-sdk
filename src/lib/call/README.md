# `@etzhayyim/kami-engine-sdk/call`

Real-media **1:1 WebRTC calling** (audio/video) over the kotoba realtime
signaling relay. The browser owns the media plane end to end — capture, codecs,
SRTP, jitter buffer, ICE/DTLS all live in `RTCPeerConnection`. This module only
orchestrates it and shuttles SDP/ICE through the authority's existing
`ClientMsg::Signal` relay in `kotoba-rt`, which forwards payloads between peers
without parsing them.

Zero runtime dependencies. Headless and SSR-safe: `RTCPeerConnection`,
`WebSocket`, and media capture are all injectable.

## Usage

```ts
import { createKotobaCall } from '@etzhayyim/kami-engine-sdk/call';

const call = createKotobaCall({
  endpoint: 'wss://node.example',   // node origin or full XRPC connect URL
  room: 'room-1',
  player: 1,                         // this client's stable id in the room
  token,                             // Worker-issued room token (HS256 JWT)
  media: { audio: true, video: true },
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // add TURN for prod
});

call.on('remotestream', (peerId, stream) => { remoteVideo.srcObject = stream; });
call.on('peerstate', (peerId, state) => console.log(peerId, state));
call.on('presence', (peerId, joined) => { /* roster UI */ });
call.on('reconnecting', (attempt) => { /* signaling dropped; media survives */ });

await call.start();   // capture + connect + Join
call.dial(2);         // dial the callee's player id

call.setMicEnabled(false);    // mute
call.setCameraEnabled(false); // camera off

// Hot-swap the camera (device switch / screen share) — no renegotiation,
// inherits the current mute state, stops the old track:
const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
await call.replaceTrack(screen.getVideoTracks()[0]);

const s = await call.getStats(2); // { rttMs, jitterMs, packetsLost, ... }

// Live quality indicator — poll every 2s, auto-stops on close():
const stop = call.monitorStats(2, 2000, (s) => updateQualityBars(s));

call.hangup(2);
call.close();
```

## Drop-in UI

For a runnable demo (two tabs, two `player` ids), use the Svelte component:

```svelte
<script>
  import { CallPanel } from '@etzhayyim/kami-engine-sdk';
</script>

<CallPanel options={{ endpoint, room: 'r', player: 1, token, media: { audio: true, video: true } }}
           peerId={2} />
```

It wires `createKotobaCall` to local/remote `<video>` elements with
mute / camera / hang-up controls and a live status line.

## How it connects

- WebSocket endpoint: `/xrpc/com.etzhayyim.apps.kotoba.sync.connect?room=&player=&token=`
- Wire format: CBOR frames byte-compatible with `kotoba-rt`'s `protocol.rs`
  (`ClientMsg` / `ServerMsg`, externally-tagged enums, transparent `PlayerId`/`Tick`).
- Glare is resolved with WHATWG **perfect negotiation**; the polite peer is the
  one with the lower `player` id, so the two ends always disagree.
- On a hard `failed` connection the impolite (offerer) side attempts one ICE
  restart before tearing the peer down; transient `disconnected` is left to
  recover on its own.
- The signaling WS auto-reconnects with exponential backoff (default 5 attempts,
  500 ms base). Media is peer-to-peer, so it keeps flowing across a brief drop;
  the reconnect just restores the renegotiation/ICE-restart path. Disable or
  tune via the `reconnect` option.
- A peer that never reaches `connected` within `connectTimeoutMs` (default
  20 s — typically no viable ICE path without TURN) is torn down and surfaced via
  an `error` event, so the app never hangs in a silent "connecting" state.
- Signaling produced before the socket is OPEN (an offer from dialing right after
  `start()`, or ICE during a reconnect gap) is buffered and flushed in order once
  it opens — no offer/candidate is lost to a CONNECTING-socket send error.

## Not yet covered

- **TURN relay** — STUN alone fails behind symmetric NAT (~10–20% of real
  traffic). Deploy a TURN server and pass it in `iceServers` before production.
  Design: `kotoba/docs/ADR-turn-relay.md` (pure-Rust `kotoba-turn`, ephemeral
  HMAC creds; the SDK already accepts the `iceServers` it produces). The
  credential scheme is implemented here: `mintTurnCredential` (control-plane /
  Worker side) + `buildIceServers` (client side); `verifyTurnCredential` mirrors
  what the relay enforces.

```ts
import { mintTurnCredential, buildIceServers } from '@etzhayyim/kami-engine-sdk/call';

// Control plane (Worker/node) — secret never leaves the server:
const cred = await mintTurnCredential({
  secret: env.RT_TURN_SECRET, room, player,
  urls: ['turn:node:3478', 'turns:node:443?transport=tcp'], ttlSec: 3600,
});
// Client: createKotobaCall({ ..., iceServers: buildIceServers(cred) })
```
- **Multi-party (SFU)** — the peer map is mesh-ready (small N), but Zoom-scale
  conferencing needs a media server (planned pure-Rust SFU).
- **Telecom (PSTN/RCS/SIP)** — separate track; the `*-compat` actors remain the
  management plane.
