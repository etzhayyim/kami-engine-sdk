import { describe, expect, it } from 'vitest';
import {
  buildConnectUrl,
  decodeServerMsg,
  encodeClientMsg,
  NSID_SYNC_CONNECT,
} from './index.js';

/** Build a byte array from a spaced hex string for readable golden vectors. */
function hex(s: string): Uint8Array {
  return new Uint8Array(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));
}

describe('call wire codec (ciborium compatibility)', () => {
  it('encodes ClientMsg::Join byte-for-byte like ciborium', () => {
    // {"Join": {"room": "r", "player": 0}}
    const expected = hex('A1 64 4A 6F 69 6E A2 64 72 6F 6F 6D 61 72 66 70 6C 61 79 65 72 00');
    expect(encodeClientMsg({ type: 'join', room: 'r', player: 0 })).toEqual(expected);
  });

  it('encodes ClientMsg::Signal with an Offer payload', () => {
    // {"Signal": {"room": "r", "to": 1, "payload": {"Offer": "x"}}}
    const expected = hex(
      'A1 66 53 69 67 6E 61 6C A3 64 72 6F 6F 6D 61 72 62 74 6F 01 ' +
        '67 70 61 79 6C 6F 61 64 A1 65 4F 66 66 65 72 61 78',
    );
    expect(
      encodeClientMsg({ type: 'signal', room: 'r', to: 1, payload: { kind: 'offer', sdp: 'x' } }),
    ).toEqual(expected);
  });

  it('decodes ServerMsg::Welcome', () => {
    // {"Welcome": {"room": "r", "player": 1, "tick": 0}}
    const bytes = hex(
      'A1 67 57 65 6C 63 6F 6D 65 A3 64 72 6F 6F 6D 61 72 ' +
        '66 70 6C 61 79 65 72 01 64 74 69 63 6B 00',
    );
    expect(decodeServerMsg(bytes)).toEqual({ type: 'welcome', room: 'r', player: 1, tick: 0 });
  });

  it('decodes ServerMsg::Signal addressed via from/to', () => {
    // {"Signal": {"room": "r", "from": 2, "to": 1, "payload": {"Offer": "x"}}}
    const bytes = hex(
      'A1 66 53 69 67 6E 61 6C A4 64 72 6F 6F 6D 61 72 64 66 72 6F 6D 02 ' +
        '62 74 6F 01 67 70 61 79 6C 6F 61 64 A1 65 4F 66 66 65 72 61 78',
    );
    expect(decodeServerMsg(bytes)).toEqual({
      type: 'signal', room: 'r', from: 2, to: 1, payload: { kind: 'offer', sdp: 'x' },
    });
  });

  it('decodes ServerMsg::Presence', () => {
    // {"Presence": {"room": "r", "player": 3, "joined": true}}
    const bytes = hex(
      'A1 68 50 72 65 73 65 6E 63 65 A3 64 72 6F 6F 6D 61 72 ' +
        '66 70 6C 61 79 65 72 03 66 6A 6F 69 6E 65 64 F5',
    );
    expect(decodeServerMsg(bytes)).toEqual({
      type: 'presence', room: 'r', player: 3, joined: true,
    });
  });

  it('collapses unmodeled ServerMsg variants to {type:"other"}', () => {
    // {"Confirm": {...}} — a frame the call client ignores.
    const bytes = hex('A1 67 43 6F 6E 66 69 72 6D A0');
    expect(decodeServerMsg(bytes)).toEqual({ type: 'other', tag: 'Confirm' });
  });

  it('round-trips larger integers (multi-byte CBOR heads)', () => {
    // tick = 1_000_000 exercises the 4-byte uint head on decode.
    // {"Welcome": {"room": "r", "player": 300, "tick": 1000000}}
    const bytes = hex(
      'A1 67 57 65 6C 63 6F 6D 65 A3 64 72 6F 6F 6D 61 72 ' +
        '66 70 6C 61 79 65 72 19 01 2C 64 74 69 63 6B 1A 00 0F 42 40',
    );
    expect(decodeServerMsg(bytes)).toEqual({
      type: 'welcome', room: 'r', player: 300, tick: 1_000_000,
    });
  });
});

describe('buildConnectUrl', () => {
  it('appends the NSID path and query when given a bare origin', () => {
    const url = buildConnectUrl('wss://node.example', { room: 'r1', player: 7, token: 'tok' });
    expect(url).toBe(
      `wss://node.example/xrpc/${NSID_SYNC_CONNECT}?room=r1&player=7&token=tok`,
    );
  });

  it('does not double-append the NSID path', () => {
    const base = `wss://node.example/xrpc/${NSID_SYNC_CONNECT}`;
    const url = buildConnectUrl(base, { room: 'r1', player: 0 });
    expect(url).toBe(`${base}?room=r1&player=0`);
  });
});
