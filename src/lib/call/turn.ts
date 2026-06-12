/**
 * TURN ephemeral-credential helpers (see `kotoba/docs/ADR-turn-relay.md`).
 *
 * The relay never stores per-user secrets. A short-lived credential is an
 * expiry-prefixed, room/player-scoped username signed with a shared secret —
 * the coturn `use-auth-secret` scheme that every major WebRTC stack accepts:
 *
 *   username   = "<expiry_unix>:<room>:<player>"
 *   credential = base64( HMAC_SHA1( RT_TURN_SECRET, username ) )
 *
 * `mintTurnCredential` runs in any Web Crypto runtime (Cloudflare Workers,
 * Node 20+, browsers) — the control plane mints, the SDK consumes. The secret
 * MUST stay server-side; never ship it to a browser. `verifyTurnCredential`
 * mirrors what the Rust `kotoba-turn` relay enforces, and backs a JS test/mock
 * relay.
 */

export interface TurnCredential {
  /** One or more TURN(S) URLs, e.g. `["turn:node:3478","turns:node:443?transport=tcp"]`. */
  urls: string[];
  username: string;
  credential: string;
  /** Seconds the credential remains valid from issuance. */
  ttlSec: number;
  /** Absolute expiry (unix seconds). */
  expiresAt: number;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** HMAC-SHA1 of `message` under `secret`, base64-encoded. */
export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', utf8(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(message) as BufferSource);
  return base64(new Uint8Array(sig));
}

/** Constant-time string comparison (avoids leaking the signature via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface MintTurnOptions {
  /** Shared TURN secret (`RT_TURN_SECRET`). Server-side only. */
  secret: string;
  room: string;
  player: number;
  urls: string[];
  /** Credential lifetime in seconds. Default: 3600 (1h). */
  ttlSec?: number;
  /** Override the clock (unix ms) — for tests/determinism. */
  now?: number;
}

/** Mint a short-lived TURN credential. Run this in the control plane, not the browser. */
export async function mintTurnCredential(opts: MintTurnOptions): Promise<TurnCredential> {
  const ttlSec = opts.ttlSec ?? 3600;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const expiresAt = nowSec + ttlSec;
  const username = `${expiresAt}:${opts.room}:${opts.player}`;
  const credential = await hmacSha1Base64(opts.secret, username);
  return { urls: opts.urls, username, credential, ttlSec, expiresAt };
}

export interface VerifyTurnResult {
  ok: boolean;
  reason?: 'malformed' | 'bad-expiry' | 'expired' | 'bad-signature';
  room?: string;
  player?: number;
}

export interface VerifyTurnOptions {
  secret: string;
  username: string;
  credential: string;
  now?: number;
}

/** Verify a TURN credential exactly as the relay does (HMAC + expiry + scope). */
export async function verifyTurnCredential(opts: VerifyTurnOptions): Promise<VerifyTurnResult> {
  const parts = opts.username.split(':');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [expStr, room, playerStr] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'bad-expiry' };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (expiresAt < nowSec) return { ok: false, reason: 'expired' };
  const expected = await hmacSha1Base64(opts.secret, opts.username);
  if (!timingSafeEqual(expected, opts.credential)) return { ok: false, reason: 'bad-signature' };
  return { ok: true, room, player: Number(playerStr) };
}

/** Assemble `iceServers` for `createKotobaCall` from a minted credential. */
export function buildIceServers(
  cred: Pick<TurnCredential, 'urls' | 'username' | 'credential'>,
  stun: string[] = ['stun:stun.l.google.com:19302'],
): RTCIceServer[] {
  return [
    ...stun.map((urls) => ({ urls })),
    { urls: cred.urls, username: cred.username, credential: cred.credential },
  ];
}
