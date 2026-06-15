import { describe, expect, it } from 'vitest';

import {
  VOLCENGINE_AST_EVENTS,
  buildAstFinishSessionFrame,
  buildAstStartSessionFrame,
  buildAstTaskRequestFrame,
  decodeAstResponseFrame,
} from '@/translation/volcengine-ast-protobuf';

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

describe('Volcengine AST protobuf frames', () => {
  it('encodes StartSession, TaskRequest, and FinishSession frames with official event ids', () => {
    const start = buildAstStartSessionFrame({
      sessionId: 'session-1',
      mode: 's2s',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      sourceAudio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      targetAudio: { format: 'ogg_opus', rate: 24000 },
      user: { uid: 'user-1', did: 'browser-extension', platform: 'Chrome' },
    });
    const task = buildAstTaskRequestFrame('session-1', new Uint8Array([1, 2, 3]), 7);
    const finish = buildAstFinishSessionFrame('session-1');

    expect([...start]).toContain(VOLCENGINE_AST_EVENTS.StartSession);
    expect([...task]).toContain(VOLCENGINE_AST_EVENTS.TaskRequest);
    expect([...task]).toContain(1);
    expect([...task]).toContain(2);
    expect([...task]).toContain(3);
    expect([...finish]).toContain(VOLCENGINE_AST_EVENTS.FinishSession);
  });

  it('decodes response frames carrying subtitle text and translated audio bytes', () => {
    const responseMeta = new Uint8Array([
      ...fieldString(1, 'session-1'),
      ...fieldVarint(2, 3),
      ...fieldVarint(3, 21000),
      ...fieldString(4, 'ok'),
    ]);
    const responseFrame = new Uint8Array([
      ...fieldBytes(1, responseMeta),
      ...fieldVarint(2, VOLCENGINE_AST_EVENTS.TTSResponse),
      ...fieldBytes(3, new Uint8Array([9, 8, 7])),
      ...fieldString(4, 'translated text'),
      ...fieldVarint(5, 100),
      ...fieldVarint(6, 260),
      ...fieldVarint(7, 1),
    ]);

    expect(decodeAstResponseFrame(responseFrame)).toEqual({
      event: VOLCENGINE_AST_EVENTS.TTSResponse,
      sessionId: 'session-1',
      sequence: 3,
      statusCode: 21000,
      message: 'ok',
      data: new Uint8Array([9, 8, 7]),
      text: 'translated text',
      startTime: 100,
      endTime: 260,
      spkChg: true,
      mutedDurationMs: 0,
      speakerId: '',
    });
  });
});
