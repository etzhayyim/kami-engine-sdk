import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CallPanel from './CallPanel.svelte';

/** Injected fakes so the panel exercises the real engine without WebRTC/WS. */
function injectedOptions() {
  const tracks = [{ kind: 'audio', enabled: true, stop() {} }];
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    getVideoTracks: () => [],
  } as unknown as MediaStream;
  return {
    endpoint: 'wss://node.example', room: 'r', player: 1,
    getLocalStream: async () => stream,
    RTCPeerConnectionCtor: class {} as unknown as typeof RTCPeerConnection,
    createWebSocket: (url: string) => ({
      url, binaryType: '', send() {}, close() {},
      onopen: null, onmessage: null, onclose: null, onerror: null,
    }),
  };
}

describe('CallPanel', () => {
  it('mounts and shows the Start control before a call begins (autoStart off)', () => {
    render(CallPanel, { props: { options: { endpoint: 'wss://node.example', room: 'r', player: 1 } } });
    // No call yet → the Start button is shown and in-call controls are not.
    expect(screen.getByText('Start')).toBeTruthy();
    expect(screen.queryByText('Hang up')).toBeNull();
    expect(screen.queryByText('Share screen')).toBeNull();
    // Idle status line renders.
    expect(screen.getByText('idle')).toBeTruthy();
  });

  it('swaps to in-call controls after Start is clicked', async () => {
    render(CallPanel, { props: { options: injectedOptions() } });
    await fireEvent.click(screen.getByText('Start'));

    // Once a call exists the control bar shows Mute / Camera / Share / Hang up.
    expect(await screen.findByText('Hang up')).toBeTruthy();
    expect(screen.getByText('Mute')).toBeTruthy();
    expect(screen.getByText('Share screen')).toBeTruthy();
    expect(screen.queryByText('Start')).toBeNull();
  });
});
