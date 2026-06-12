/**
 * Realtime wire protocol — browser side.
 *
 * Byte-for-byte compatible with `kotoba-rt`'s `protocol.rs` (CBOR via ciborium,
 * serde data model). We mirror only the subset a 1:1 media call needs:
 *
 *  - encode `ClientMsg::{Join, Leave, Signal}`
 *  - decode `ServerMsg::{Welcome, Presence, Signal}` (others are skipped)
 *
 * serde/ciborium encoding rules we depend on:
 *  - newtype tuple structs `PlayerId(u32)` / `Tick(u64)` are *transparent*:
 *    they serialize as the bare integer.
 *  - externally-tagged enums: a unit variant is the bare variant name (text);
 *    a variant with data is a one-entry map `{ "Variant": <payload> }`.
 *  - structs / struct-variants serialize as maps keyed by field name, in
 *    declaration order (order is irrelevant for decoding).
 *
 * The SDK ships with zero runtime dependencies, so CBOR is hand-rolled for this
 * small, fixed schema rather than pulling in a general codec.
 */

/** The XRPC NSID of the realtime connect endpoint (see `kotoba-server`). */
export const NSID_SYNC_CONNECT = 'com.etzhayyim.apps.kotoba.sync.connect';

/** WebRTC signaling payload (T2). The authority relays these opaquely. */
export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: string };

/** Messages we send to the authority. */
export type ClientMsg =
  | { type: 'join'; room: string; player: number }
  | { type: 'leave'; room: string; player: number }
  | { type: 'signal'; room: string; to: number; payload: SignalPayload };

/** Messages the authority broadcasts that a call client acts on. */
export type ServerMsg =
  | { type: 'welcome'; room: string; player: number; tick: number }
  | { type: 'presence'; room: string; player: number; joined: boolean }
  | { type: 'signal'; room: string; from: number; to: number; payload: SignalPayload }
  /** Any frame this client does not model (Input/Bundle/Confirm/Snapshot…). */
  | { type: 'other'; tag: string };

// ───────────────────────────── CBOR writer ──────────────────────────────────

function head(out: number[], major: number, n: number): void {
  const mt = major << 5;
  if (n < 24) out.push(mt | n);
  else if (n < 0x100) out.push(mt | 24, n);
  else if (n < 0x10000) out.push(mt | 25, (n >> 8) & 0xff, n & 0xff);
  else if (n < 0x100000000)
    out.push(mt | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else {
    // 64-bit. Safe for integers up to 2^53 (Number.MAX_SAFE_INTEGER).
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    out.push(
      mt | 27,
      (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    );
  }
}

function writeText(out: number[], s: string): void {
  const bytes = new TextEncoder().encode(s);
  head(out, 3, bytes.length);
  for (const b of bytes) out.push(b);
}

function writeUint(out: number[], n: number): void {
  head(out, 0, n);
}

/** Encode `SignalPayload` as ciborium would: `{ "Offer" | "Answer" | "Ice": <string> }`. */
function writeSignalPayload(out: number[], p: SignalPayload): void {
  head(out, 5, 1); // map, 1 entry
  if (p.kind === 'offer') {
    writeText(out, 'Offer');
    writeText(out, p.sdp);
  } else if (p.kind === 'answer') {
    writeText(out, 'Answer');
    writeText(out, p.sdp);
  } else {
    writeText(out, 'Ice');
    writeText(out, p.candidate);
  }
}

/** Encode a `ClientMsg` to CBOR bytes for the WS transport. */
export function encodeClientMsg(msg: ClientMsg): Uint8Array {
  const out: number[] = [];
  head(out, 5, 1); // outer enum map, 1 entry
  if (msg.type === 'join') {
    writeText(out, 'Join');
    head(out, 5, 2);
    writeText(out, 'room'); writeText(out, msg.room);
    writeText(out, 'player'); writeUint(out, msg.player);
  } else if (msg.type === 'leave') {
    writeText(out, 'Leave');
    head(out, 5, 2);
    writeText(out, 'room'); writeText(out, msg.room);
    writeText(out, 'player'); writeUint(out, msg.player);
  } else {
    writeText(out, 'Signal');
    head(out, 5, 3);
    writeText(out, 'room'); writeText(out, msg.room);
    writeText(out, 'to'); writeUint(out, msg.to);
    writeText(out, 'payload'); writeSignalPayload(out, msg.payload);
  }
  return new Uint8Array(out);
}

// ───────────────────────────── CBOR reader ──────────────────────────────────

class Reader {
  constructor(private readonly b: Uint8Array, public pos = 0) {}

  private u8(): number {
    if (this.pos >= this.b.length) throw new RangeError('CBOR: unexpected end');
    return this.b[this.pos++];
  }

  private argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.u8();
    if (info === 25) return (this.u8() << 8) | this.u8();
    if (info === 26) {
      // assemble without sign issues
      return this.u8() * 0x1000000 + (this.u8() << 16) + (this.u8() << 8) + this.u8();
    }
    if (info === 27) {
      const hi = this.u8() * 0x1000000 + (this.u8() << 16) + (this.u8() << 8) + this.u8();
      const lo = this.u8() * 0x1000000 + (this.u8() << 16) + (this.u8() << 8) + this.u8();
      return hi * 0x100000000 + lo;
    }
    throw new RangeError(`CBOR: bad additional info ${info}`);
  }

  /** Decode one CBOR data item into a plain JS value. */
  value(): unknown {
    const ib = this.u8();
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case 0: // unsigned int
        return this.argument(info);
      case 1: // negative int
        return -1 - this.argument(info);
      case 2: { // byte string
        const len = this.argument(info);
        const slice = this.b.slice(this.pos, this.pos + len);
        this.pos += len;
        return slice;
      }
      case 3: { // text string
        const len = this.argument(info);
        const slice = this.b.subarray(this.pos, this.pos + len);
        this.pos += len;
        return new TextDecoder().decode(slice);
      }
      case 4: { // array
        const len = this.argument(info);
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(this.value());
        return arr;
      }
      case 5: { // map
        const len = this.argument(info);
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          const k = this.value();
          obj[String(k)] = this.value();
        }
        return obj;
      }
      case 7: // simple / float
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25 || info === 26 || info === 27) {
          // floats — call client never reads these; consume and return NaN-ish.
          this.argument(info);
          return 0;
        }
        return this.argument(info);
      default:
        throw new RangeError(`CBOR: unsupported major type ${major}`);
    }
  }
}

function parseSignalPayload(v: unknown): SignalPayload | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (typeof m.Offer === 'string') return { kind: 'offer', sdp: m.Offer };
  if (typeof m.Answer === 'string') return { kind: 'answer', sdp: m.Answer };
  if (typeof m.Ice === 'string') return { kind: 'ice', candidate: m.Ice };
  return null;
}

/** Decode a `ServerMsg` frame; unmodeled variants collapse to `{type:'other'}`. */
export function decodeServerMsg(bytes: Uint8Array): ServerMsg {
  const v = new Reader(bytes).value();

  // Unit variants would arrive as a bare string; none we care about, but guard.
  if (typeof v === 'string') return { type: 'other', tag: v };
  if (!v || typeof v !== 'object') return { type: 'other', tag: '?' };

  const map = v as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length !== 1) return { type: 'other', tag: keys.join(',') };
  const tag = keys[0];
  const body = map[tag] as Record<string, unknown>;

  switch (tag) {
    case 'Welcome':
      return {
        type: 'welcome',
        room: String(body.room),
        player: Number(body.player),
        tick: Number(body.tick),
      };
    case 'Presence':
      return {
        type: 'presence',
        room: String(body.room),
        player: Number(body.player),
        joined: Boolean(body.joined),
      };
    case 'Signal': {
      const payload = parseSignalPayload(body.payload);
      if (!payload) return { type: 'other', tag };
      return {
        type: 'signal',
        room: String(body.room),
        from: Number(body.from),
        to: Number(body.to),
        payload,
      };
    }
    default:
      return { type: 'other', tag };
  }
}

// ───────────────────────────── connect URL ──────────────────────────────────

export interface ConnectUrlParams {
  /** Room id to join. */
  room: string;
  /** This client's stable player id within the room. */
  player: number;
  /** Worker-issued room token (HS256 JWT). Required when the node enforces it. */
  token?: string;
}

/**
 * Build the WebSocket URL for the realtime connect endpoint.
 *
 * `base` may be the node origin (`wss://node.example`) or already include the
 * XRPC path; the NSID path is appended only when absent.
 */
export function buildConnectUrl(base: string, params: ConnectUrlParams): string {
  let root = base.replace(/\/+$/, '');
  if (!root.includes(`/xrpc/${NSID_SYNC_CONNECT}`)) {
    root = `${root}/xrpc/${NSID_SYNC_CONNECT}`;
  }
  const q = new URLSearchParams({ room: params.room, player: String(params.player) });
  if (params.token) q.set('token', params.token);
  return `${root}?${q.toString()}`;
}
