export const AST_TARGET_SAMPLE_RATE = 16000;
export const AST_PCM_CHUNK_BYTES = 3200;

export function downsampleFloat32(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = AST_TARGET_SAMPLE_RATE
): Float32Array {
  if (inputSampleRate <= targetSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    output[i] = input[Math.floor(i * ratio)];
  }

  return output;
}

export function floatTo16BitPcm(input: Float32Array): Uint8Array {
  const output = new Uint8Array(input.length * 2);
  const view = new DataView(output.buffer);

  input.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(index * 2, value, true);
  });

  return output;
}

export class PcmChunker {
  private pending = new Uint8Array();

  constructor(
    private readonly chunkSize: number,
    private readonly onChunk: (chunk: Uint8Array) => void
  ) {}

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }

    const merged = new Uint8Array(this.pending.length + bytes.length);
    merged.set(this.pending, 0);
    merged.set(bytes, this.pending.length);
    this.pending = merged;

    while (this.pending.length >= this.chunkSize) {
      const chunk = this.pending.slice(0, this.chunkSize);
      this.onChunk(chunk);
      this.pending = this.pending.slice(this.chunkSize);
    }
  }

  flush(): void {
    if (this.pending.length === 0) {
      return;
    }

    this.onChunk(this.pending);
    this.pending = new Uint8Array();
  }
}
