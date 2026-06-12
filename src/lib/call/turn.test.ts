import { describe, expect, it } from 'vitest';
import {
  buildIceServers,
  hmacSha1Base64,
  mintTurnCredential,
  verifyTurnCredential,
} from './turn.js';

describe('TURN ephemeral credentials', () => {
  it('computes HMAC-SHA1 matching the RFC 2202 test vector', async () => {
    // RFC 2202 §3 case 2: key="Jefe", data="what do ya want for nothing?"
    // → 0xeffcdf6ae5eb2fa2d27416d5f184df9c259a7c79 (base64 below).
    const expected = '7/zfauXrL6LSdBbV8YTfnCWafHk=';
    expect(await hmacSha1Base64('Jefe', 'what do ya want for nothing?')).toBe(expected);
  });

  it('mints a credential with expiry-prefixed, scoped username', async () => {
    const now = 1_700_000_000_000; // fixed clock (ms)
    const cred = await mintTurnCredential({
      secret: 's3cret', room: 'room-1', player: 7,
      urls: ['turn:node:3478'], ttlSec: 600, now,
    });
    expect(cred.username).toBe('1700000600:room-1:7'); // floor(now/1000)+600
    expect(cred.expiresAt).toBe(1_700_000_600);
    expect(cred.ttlSec).toBe(600);
    expect(cred.credential).toBe(await hmacSha1Base64('s3cret', cred.username));
  });

  it('round-trips mint → verify and recovers room/player', async () => {
    const now = 1_700_000_000_000;
    const cred = await mintTurnCredential({
      secret: 'k', room: 'r', player: 3, urls: ['turn:n:3478'], now,
    });
    const res = await verifyTurnCredential({
      secret: 'k', username: cred.username, credential: cred.credential, now,
    });
    expect(res).toEqual({ ok: true, room: 'r', player: 3 });
  });

  it('rejects an expired credential', async () => {
    const issued = 1_700_000_000_000;
    const cred = await mintTurnCredential({
      secret: 'k', room: 'r', player: 1, urls: ['turn:n'], ttlSec: 60, now: issued,
    });
    const res = await verifyTurnCredential({
      secret: 'k', username: cred.username, credential: cred.credential,
      now: issued + 61_000, // 61s later — past the 60s ttl
    });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered credential and a wrong secret', async () => {
    const now = 1_700_000_000_000;
    const cred = await mintTurnCredential({ secret: 'k', room: 'r', player: 1, urls: ['turn:n'], now });

    expect((await verifyTurnCredential({
      secret: 'k', username: cred.username, credential: `${cred.credential}x`, now,
    })).reason).toBe('bad-signature');

    expect((await verifyTurnCredential({
      secret: 'WRONG', username: cred.username, credential: cred.credential, now,
    })).reason).toBe('bad-signature');
  });

  it('rejects a malformed username', async () => {
    const res = await verifyTurnCredential({ secret: 'k', username: 'no-colons', credential: 'x' });
    expect(res).toEqual({ ok: false, reason: 'malformed' });
  });

  it('builds iceServers with STUN first then the TURN credential', () => {
    const servers = buildIceServers(
      { urls: ['turn:node:3478', 'turns:node:443?transport=tcp'], username: 'u', credential: 'c' },
      ['stun:stun.example:3478'],
    );
    expect(servers).toEqual([
      { urls: 'stun:stun.example:3478' },
      { urls: ['turn:node:3478', 'turns:node:443?transport=tcp'], username: 'u', credential: 'c' },
    ]);
  });
});
