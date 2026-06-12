/**
 * `@etzhayyim/kami-engine-sdk/call` — real-media 1:1 WebRTC calling over the
 * kotoba realtime signaling relay.
 */

export { createKotobaCall } from './call.js';
export type {
  KotobaCall,
  KotobaCallOptions,
  KotobaCallEvents,
  PeerConnectionState,
  WebSocketLike,
  CallStats,
} from './call.js';

export {
  NSID_SYNC_CONNECT,
  buildConnectUrl,
  encodeClientMsg,
  decodeServerMsg,
} from './wire.js';
export type {
  ClientMsg,
  ServerMsg,
  SignalPayload,
  ConnectUrlParams,
} from './wire.js';

export {
  mintTurnCredential,
  verifyTurnCredential,
  buildIceServers,
  hmacSha1Base64,
} from './turn.js';
export type {
  TurnCredential,
  MintTurnOptions,
  VerifyTurnOptions,
  VerifyTurnResult,
} from './turn.js';
