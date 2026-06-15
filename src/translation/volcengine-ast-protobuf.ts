export const VOLCENGINE_AST_EVENTS = {
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  TaskRequest: 200,
  UpdateConfig: 201,
  AudioMuted: 250,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  SourceSubtitleStart: 650,
  SourceSubtitleResponse: 651,
  SourceSubtitleEnd: 652,
  TranslationSubtitleStart: 653,
  TranslationSubtitleResponse: 654,
  TranslationSubtitleEnd: 655,
} as const;

export type VolcengineAstEvent =
  (typeof VOLCENGINE_AST_EVENTS)[keyof typeof VOLCENGINE_AST_EVENTS];

export interface AstAudioFormat {
  format: string;
  rate: number;
  bits?: number;
  channel?: number;
}

export interface AstStartSessionConfig {
  sessionId: string;
  mode: 's2s' | 's2t';
  sourceLanguage: string;
  targetLanguage: string;
  sourceAudio: AstAudioFormat;
  targetAudio: AstAudioFormat;
  speakerId?: string;
  user?: {
    uid?: string;
    did?: string;
    platform?: string;
    sdkVersion?: string;
    appVersion?: string;
  };
}

export interface AstResponseFrame {
  event: number;
  sessionId: string;
  sequence: number;
  statusCode: number;
  message: string;
  data: Uint8Array;
  text: string;
  startTime: number;
  endTime: number;
  spkChg: boolean;
  mutedDurationMs: number;
  speakerId: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class ProtoWriter {
  private readonly chunks: Uint8Array[] = [];

  uint32(field: number, value: number | undefined): void {
    if (value === undefined) {
      return;
    }
    this.pushVarint((field << 3) | 0);
    this.pushVarint(value);
  }

  bool(field: number, value: boolean | undefined): void {
    if (value === undefined) {
      return;
    }
    this.uint32(field, value ? 1 : 0);
  }

  string(field: number, value: string | undefined): void {
    if (!value) {
      return;
    }
    this.bytes(field, textEncoder.encode(value));
  }

  bytes(field: number, value: Uint8Array | undefined): void {
    if (!value || value.length === 0) {
      return;
    }
    this.pushVarint((field << 3) | 2);
    this.pushVarint(value.length);
    this.chunks.push(value);
  }

  message(field: number, value: Uint8Array): void {
    this.bytes(field, value);
  }

  finish(): Uint8Array {
    const length = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    this.chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  private pushVarint(value: number): void {
    let current = value >>> 0;
    const bytes: number[] = [];
    while (current >= 0x80) {
      bytes.push((current & 0x7f) | 0x80);
      current >>>= 7;
    }
    bytes.push(current);
    this.chunks.push(new Uint8Array(bytes));
  }
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.offset >= this.bytes.length;
  }

  readTag(): { field: number; wireType: number } {
    const tag = this.readVarint();
    return {
      field: tag >>> 3,
      wireType: tag & 0x07,
    };
  }

  readVarint(): number {
    let shift = 0;
    let result = 0;

    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result >>> 0;
      }
      shift += 7;
    }

    throw new Error('Invalid protobuf varint');
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    const start = this.offset;
    const end = start + length;
    if (end > this.bytes.length) {
      throw new Error('Invalid protobuf length');
    }
    this.offset = end;
    return this.bytes.slice(start, end);
  }

  readString(): string {
    return textDecoder.decode(this.readBytes());
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint();
      return;
    }
    if (wireType === 2) {
      this.readBytes();
      return;
    }
    if (wireType === 5) {
      if (this.offset + 4 > this.bytes.length) {
        throw new Error('Invalid protobuf length');
      }
      this.offset += 4;
      return;
    }
    if (wireType === 1) {
      if (this.offset + 8 > this.bytes.length) {
        throw new Error('Invalid protobuf length');
      }
      this.offset += 8;
      return;
    }
    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function encodeRequestMeta(sessionId: string, sequence?: number): Uint8Array {
  const writer = new ProtoWriter();
  writer.string(6, sessionId);
  writer.uint32(7, sequence);
  return writer.finish();
}

function encodeUser(user: AstStartSessionConfig['user']): Uint8Array {
  const writer = new ProtoWriter();
  writer.string(1, user?.uid ?? 'my-attention-extension');
  writer.string(2, user?.did ?? 'browser-extension');
  writer.string(3, user?.platform ?? 'Chrome Extension');
  writer.string(4, user?.sdkVersion);
  writer.string(5, user?.appVersion);
  return writer.finish();
}

function encodeAudio(audio: Partial<AstAudioFormat> & { binaryData?: Uint8Array }): Uint8Array {
  const writer = new ProtoWriter();
  writer.string(4, audio.format);
  writer.uint32(7, audio.rate);
  writer.uint32(8, audio.bits);
  writer.uint32(9, audio.channel);
  writer.bytes(14, audio.binaryData);
  return writer.finish();
}

function encodeRequestParams(config: AstStartSessionConfig): Uint8Array {
  const writer = new ProtoWriter();
  writer.string(1, config.mode);
  writer.string(2, config.sourceLanguage);
  writer.string(3, config.targetLanguage);
  writer.string(4, config.speakerId);
  return writer.finish();
}

function buildRequestFrame(options: {
  sessionId: string;
  event: VolcengineAstEvent;
  sequence?: number;
  user?: AstStartSessionConfig['user'];
  sourceAudio?: Partial<AstAudioFormat> & { binaryData?: Uint8Array };
  targetAudio?: Partial<AstAudioFormat>;
  requestParams?: AstStartSessionConfig;
}): Uint8Array {
  const writer = new ProtoWriter();
  writer.message(1, encodeRequestMeta(options.sessionId, options.sequence));
  writer.uint32(2, options.event);
  if (options.user !== undefined || options.event === VOLCENGINE_AST_EVENTS.StartSession) {
    writer.message(3, encodeUser(options.user));
  }
  if (options.sourceAudio) {
    writer.message(4, encodeAudio(options.sourceAudio));
  }
  if (options.targetAudio) {
    writer.message(5, encodeAudio(options.targetAudio));
  }
  if (options.requestParams) {
    writer.message(6, encodeRequestParams(options.requestParams));
  }
  return writer.finish();
}

export function buildAstStartSessionFrame(config: AstStartSessionConfig): Uint8Array {
  return buildRequestFrame({
    sessionId: config.sessionId,
    event: VOLCENGINE_AST_EVENTS.StartSession,
    user: config.user,
    sourceAudio: config.sourceAudio,
    targetAudio: config.targetAudio,
    requestParams: config,
  });
}

export function buildAstTaskRequestFrame(
  sessionId: string,
  audioChunk: Uint8Array,
  sequence?: number
): Uint8Array {
  return buildRequestFrame({
    sessionId,
    event: VOLCENGINE_AST_EVENTS.TaskRequest,
    sequence,
    sourceAudio: { binaryData: audioChunk },
  });
}

export function buildAstFinishSessionFrame(sessionId: string): Uint8Array {
  return buildRequestFrame({
    sessionId,
    event: VOLCENGINE_AST_EVENTS.FinishSession,
    sourceAudio: {},
  });
}

function decodeResponseMeta(bytes: Uint8Array): {
  sessionId: string;
  sequence: number;
  statusCode: number;
  message: string;
} {
  const reader = new ProtoReader(bytes);
  const meta = {
    sessionId: '',
    sequence: 0,
    statusCode: 0,
    message: '',
  };

  while (!reader.done()) {
    const tag = reader.readTag();
    if (tag.field === 1 && tag.wireType === 2) {
      meta.sessionId = reader.readString();
    } else if (tag.field === 2 && tag.wireType === 0) {
      meta.sequence = reader.readVarint();
    } else if (tag.field === 3 && tag.wireType === 0) {
      meta.statusCode = reader.readVarint();
    } else if (tag.field === 4 && tag.wireType === 2) {
      meta.message = reader.readString();
    } else {
      reader.skip(tag.wireType);
    }
  }

  return meta;
}

export function decodeAstResponseFrame(bytes: Uint8Array): AstResponseFrame {
  const reader = new ProtoReader(bytes);
  const response: AstResponseFrame = {
    event: 0,
    sessionId: '',
    sequence: 0,
    statusCode: 0,
    message: '',
    data: new Uint8Array(),
    text: '',
    startTime: 0,
    endTime: 0,
    spkChg: false,
    mutedDurationMs: 0,
    speakerId: '',
  };

  while (!reader.done()) {
    const tag = reader.readTag();
    if (tag.field === 1 && tag.wireType === 2) {
      const meta = decodeResponseMeta(reader.readBytes());
      response.sessionId = meta.sessionId;
      response.sequence = meta.sequence;
      response.statusCode = meta.statusCode;
      response.message = meta.message;
    } else if (tag.field === 2 && tag.wireType === 0) {
      response.event = reader.readVarint();
    } else if (tag.field === 3 && tag.wireType === 2) {
      response.data = reader.readBytes();
    } else if (tag.field === 4 && tag.wireType === 2) {
      response.text = reader.readString();
    } else if (tag.field === 5 && tag.wireType === 0) {
      response.startTime = reader.readVarint();
    } else if (tag.field === 6 && tag.wireType === 0) {
      response.endTime = reader.readVarint();
    } else if (tag.field === 7 && tag.wireType === 0) {
      response.spkChg = reader.readVarint() === 1;
    } else if (tag.field === 8 && tag.wireType === 0) {
      response.mutedDurationMs = reader.readVarint();
    } else if (tag.field === 9 && tag.wireType === 2) {
      response.speakerId = reader.readString();
    } else {
      reader.skip(tag.wireType);
    }
  }

  return response;
}
