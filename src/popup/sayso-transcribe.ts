/**
 * 转写「文件/链接」走本地 Say-So-Scribe 后端，复用其 5 档 ASR 模式。
 * POST {base}/api/transcribe（multipart：file/mode/language）→ {segments,speakers}。
 */

export type SaysoMode = 'cheetah' | 'dolphin' | 'whale' | 'falcon' | 'globe';

export interface SaysoSegment {
  id: string;
  startSec: number;
  endSec: number;
  speakerId: string;
  text: string;
}

export interface SaysoResult {
  segments: SaysoSegment[];
  speakers: { id: string; name: string; color?: string }[];
  durationSec?: number;
}

export const SAYSO_MODES: { key: SaysoMode; icon: string; name: string; tier: string }[] = [
  { key: 'cheetah', icon: '🐆', name: '猎豹', tier: '最快·火山' },
  { key: 'dolphin', icon: '🐬', name: '海豚', tier: '快·阿里' },
  { key: 'whale', icon: '🐋', name: '鲸鱼', tier: '标准·阿里' },
  { key: 'falcon', icon: '🦅', name: '隼', tier: '高精度·火山' },
  { key: 'globe', icon: '🌐', name: '多语言', tier: '旗舰·Google' },
];

const DEFAULT_SAYSO_BASE = 'http://localhost:3000';
const SAYSO_BASE_KEY = 'saysoBackendUrl';

export async function getSaysoBackendUrl(): Promise<string> {
  const r = await chrome.storage.local.get(SAYSO_BASE_KEY);
  const v = (r?.[SAYSO_BASE_KEY] ?? '').toString().trim();
  return v || DEFAULT_SAYSO_BASE;
}

export async function setSaysoBackendUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [SAYSO_BASE_KEY]: url.trim() });
}

export function saysoModeLabel(mode: SaysoMode): string {
  const m = SAYSO_MODES.find((x) => x.key === mode);
  return m ? `${m.icon} ${m.name}` : mode;
}

/** 调用 Say-So-Scribe 后端转写一个文件，返回分段结果。 */
export async function transcribeViaSayso(
  file: File,
  mode: SaysoMode,
  language: string,
  signal?: AbortSignal
): Promise<SaysoResult> {
  const base = (await getSaysoBackendUrl()).replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('mode', mode);
  if (language && language !== 'auto') {
    form.append('language', language);
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}/api/transcribe`, { method: 'POST', body: form, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new Error(`无法连接 Say-So-Scribe 后端（${base}）。请确认服务已启动（在该项目 npm run dev）`);
  }

  if (resp.status === 501) {
    throw new Error('Say-So-Scribe 未启用真实 ASR：在其 .env 设 NEXT_PUBLIC_ASR_REAL=1 并填好该模式对应的 keys/存储桶');
  }
  if (resp.status === 413) {
    throw new Error('文件过大（上限 200MB）');
  }
  if (!resp.ok) {
    let raw = '';
    try {
      const j = await resp.json();
      raw = typeof j?.error === 'string' ? j.error : '';
    } catch {
      // ignore parse error
    }
    // 各家「无有效语音/静音」错误 → 友好提示（火山 20000003 / 阿里 NO_VALID_FRAGMENT）
    if (/no valid speech|silence|20000003|NO_VALID_FRAGMENT/i.test(raw)) {
      throw new Error('音频中未检测到有效语音（文件可能是静音或无人声）。请确认该文件能正常播放出声，或换一个有语音的文件。');
    }
    throw new Error(`转写失败 (${resp.status})${raw ? `：${raw}` : ''}`);
  }

  return (await resp.json()) as SaysoResult;
}
