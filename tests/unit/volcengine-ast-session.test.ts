import { describe, expect, it, vi } from 'vitest';

import { VolcengineAstSession } from '@/offscreen/volcengine-ast-session';
import { VOLCENGINE_AST_EVENTS } from '@/translation/volcengine-ast-protobuf';

class FakeSocket {
  static readonly OPEN = 1;

  binaryType: BinaryType = 'blob';
  readyState = FakeSocket.OPEN;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return bytes;
}

function fieldVarint(field: number, value: number): number[] {
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fieldString(field: number, value: string): number[] {
  const payload = new TextEncoder().encode(value);
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload];
}

function fieldBytes(field: number, value: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(value.length), ...value];
}

function includesSubsequence(bytes: Uint8Array, expected: number[]): boolean {
  return bytes.some((_, index) =>
    expected.every((byte, offset) => bytes[index + offset] === byte)
  );
}

function buildResponse(event: number, text = '', data = new Uint8Array()): ArrayBuffer {
  const meta = new Uint8Array([...fieldString(1, 'session-1'), ...fieldVarint(3, 21000)]);
  return new Uint8Array([
    ...fieldBytes(1, meta),
    ...fieldVarint(2, event),
    ...fieldBytes(3, data),
    ...fieldString(4, text),
  ]).buffer;
}

describe('VolcengineAstSession', () => {
  it('opens websocket, sends session/audio/finish frames, and emits subtitles/audio', async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const onSubtitle = vi.fn();
    const onAudioChunk = vi.fn();

    const session = new VolcengineAstSession(
      {
        url: 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate',
        sessionId: 'session-1',
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        mode: 's2s',
        voiceCloneEnabled: true,
      },
      {
        createWebSocket,
        onSubtitle,
        onAudioChunk,
      }
    );

    await session.start();
    socket.onopen?.();
    socket.onmessage?.({ data: buildResponse(VOLCENGINE_AST_EVENTS.SessionStarted) });
    await session.waitUntilStarted();
    session.sendAudioChunk(new Uint8Array([1, 2, 3]));
    session.finish();

    expect(createWebSocket).toHaveBeenCalledWith(
      'wss://openspeech.bytedance.com/api/v4/ast/v2/translate'
    );
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.sent).toHaveLength(3);
    expect([...socket.sent[0]]).toContain(VOLCENGINE_AST_EVENTS.StartSession);
    expect(new TextDecoder().decode(socket.sent[0])).toContain('wav');
    expect(new TextDecoder().decode(socket.sent[0])).toContain('ogg_opus');
    expect(new TextDecoder().decode(socket.sent[0])).not.toContain('pcm');
    expect(includesSubsequence(socket.sent[0], [0x38, ...varint(48000)])).toBe(true);
    expect([...socket.sent[1]]).toContain(VOLCENGINE_AST_EVENTS.TaskRequest);
    expect([...socket.sent[2]]).toContain(VOLCENGINE_AST_EVENTS.FinishSession);

    socket.onmessage?.({
      data: buildResponse(VOLCENGINE_AST_EVENTS.TranslationSubtitleResponse, 'hello'),
    });
    socket.onmessage?.({
      data: buildResponse(VOLCENGINE_AST_EVENTS.TTSResponse, '', new Uint8Array([9, 8])),
    });

    await vi.waitFor(() => {
      expect(onSubtitle).toHaveBeenCalledWith({
        event: VOLCENGINE_AST_EVENTS.TranslationSubtitleResponse,
        text: 'hello',
        startTime: 0,
        endTime: 0,
        spkChg: false,
        mutedDurationMs: 0,
        speakerId: '',
      });
      expect(onAudioChunk).toHaveBeenCalledWith(new Uint8Array([9, 8]));
    });
  });

  it('reports an unexpected websocket close after startup without reporting intentional close', async () => {
    const socket = new FakeSocket();
    const onClose = vi.fn();

    const session = new VolcengineAstSession(
      {
        url: 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate',
        sessionId: 'session-1',
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        mode: 's2t',
        voiceCloneEnabled: false,
      },
      {
        createWebSocket: () => socket,
        onClose,
      }
    );

    await session.start();
    socket.onopen?.();
    socket.onmessage?.({ data: buildResponse(VOLCENGINE_AST_EVENTS.SessionStarted) });
    await session.waitUntilStarted();

    socket.onclose?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(session.sendAudioChunk(new Uint8Array([1, 2, 3]))).toBe(false);

    const secondSocket = new FakeSocket();
    const intentionalClose = vi.fn();
    const secondSession = new VolcengineAstSession(
      {
        url: 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate',
        sessionId: 'session-2',
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        mode: 's2t',
        voiceCloneEnabled: false,
      },
      {
        createWebSocket: () => secondSocket,
        onClose: intentionalClose,
      }
    );
    await secondSession.start();
    secondSocket.onopen?.();
    secondSocket.onmessage?.({ data: buildResponse(VOLCENGINE_AST_EVENTS.SessionStarted) });
    await secondSession.waitUntilStarted();
    secondSession.close();

    expect(intentionalClose).not.toHaveBeenCalled();
  });
});
