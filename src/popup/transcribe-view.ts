/**
 * 转写结果视图：把火山 AST s2t 的源字幕事件累积成分段并渲染。
 * 复用同传管线下发的 SourceSubtitle 事件（Start/Response/End），仅做展示与取文本。
 */

import { VOLCENGINE_AST_EVENTS } from '@/translation/volcengine-ast-protobuf';

interface TranscribeSubtitle {
  event?: number;
  text?: string;
  startTime?: number;
  endTime?: number;
  speakerId?: string;
}

interface TranscribeSegment {
  startTime: number;
  speakerLabel: string;
  text: string;
}

const speakerLabels = new Map<string, string>();
let committed: TranscribeSegment[] = [];
let live: TranscribeSegment | null = null;

function labelForSpeaker(speakerId?: string): string {
  const id = speakerId && speakerId.trim().length > 0 ? speakerId : 'S';
  let label = speakerLabels.get(id);
  if (!label) {
    label = `S${speakerLabels.size + 1}`;
    speakerLabels.set(id, label);
  }
  return label;
}

function formatTime(ms?: number): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function render(): void {
  const container = document.getElementById('transcribe-segments');
  if (!container) return;

  const rows = [...committed, ...(live ? [live] : [])];
  if (rows.length === 0) {
    container.innerHTML =
      '<div id="transcribe-empty" class="h-full flex flex-col items-center justify-center text-center text-gray-400">' +
      '<i class="fas fa-closed-captioning text-3xl mb-2"></i>' +
      '<p class="text-xs">点击「开始转写」捕获当前标签页音频</p></div>';
    return;
  }

  container.innerHTML = rows
    .map((seg, i) => {
      const isLive = live !== null && i === rows.length - 1;
      return (
        `<div class="flex gap-2 ${isLive ? 'opacity-70' : ''}">` +
        `<span class="text-xs text-gray-400 font-mono shrink-0 mt-0.5">${formatTime(seg.startTime)}</span>` +
        `<span class="text-xs font-semibold text-brand shrink-0 mt-0.5">${escapeHtml(seg.speakerLabel)}</span>` +
        `<span class="text-gray-800 leading-relaxed">${escapeHtml(seg.text)}</span>` +
        `</div>`
      );
    })
    .join('');

  const meta = document.getElementById('transcribe-meta');
  if (meta) {
    meta.textContent = `${committed.length} 段 · ${speakerLabels.size} 位说话人`;
  }
  container.scrollTop = container.scrollHeight;
}

/** 接收一条源字幕事件并更新视图。 */
export function applyTranscribeSubtitle(subtitle: TranscribeSubtitle): void {
  const event = subtitle.event;
  const text = (subtitle.text ?? '').trim();

  if (event === VOLCENGINE_AST_EVENTS.SourceSubtitleStart) {
    live = { startTime: subtitle.startTime ?? 0, speakerLabel: labelForSpeaker(subtitle.speakerId), text };
  } else if (event === VOLCENGINE_AST_EVENTS.SourceSubtitleResponse) {
    if (!live) {
      live = { startTime: subtitle.startTime ?? 0, speakerLabel: labelForSpeaker(subtitle.speakerId), text };
    } else if (text) {
      live.text = text;
    }
  } else if (event === VOLCENGINE_AST_EVENTS.SourceSubtitleEnd) {
    const seg = live ?? {
      startTime: subtitle.startTime ?? 0,
      speakerLabel: labelForSpeaker(subtitle.speakerId),
      text,
    };
    if (text) seg.text = text;
    if (seg.text) committed.push(seg);
    live = null;
  } else {
    return;
  }
  render();
}

/** 清空转写结果（开始新会话时调用）。 */
export function resetTranscript(): void {
  committed = [];
  live = null;
  speakerLabels.clear();
  render();
}

/** 取完整转写纯文本，供复制/导出。 */
export function getTranscriptText(): string {
  return committed
    .map((seg) => `[${formatTime(seg.startTime)}] ${seg.speakerLabel}: ${seg.text}`)
    .join('\n');
}
