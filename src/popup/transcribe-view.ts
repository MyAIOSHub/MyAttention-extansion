/**
 * 转写结果视图：把火山 AST s2t 的源字幕事件累积成分段并渲染。
 * 复用同传管线下发的 SourceSubtitle 事件（Start/Response/End）。
 * 支持回放跳转（data-start）与编辑模式（改分段文本 / 重命名说话人）。
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
  endTime: number;
  speakerId: string;
  text: string;
}

export type TranscriptExportFormat = 'txt' | 'srt' | 'md';

const speakerLabels = new Map<string, string>();
let committed: TranscribeSegment[] = [];
let live: TranscribeSegment | null = null;
let editMode = false;

function normalizeSpeakerId(speakerId?: string): string {
  return speakerId && speakerId.trim().length > 0 ? speakerId : 'S';
}

/** 返回说话人显示标签：已命名取自定义名，否则按出现顺序分配 S1/S2…。 */
function labelForSpeaker(speakerId?: string): string {
  const id = normalizeSpeakerId(speakerId);
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRow(seg: TranscribeSegment, committedIndex: number, isLive: boolean): string {
  const label = labelForSpeaker(seg.speakerId);
  const time = `<span class="text-xs text-gray-400 font-mono shrink-0 mt-0.5">${formatTime(seg.startTime)}</span>`;

  if (editMode && !isLive) {
    return (
      `<div class="flex gap-2 rounded">${time}` +
      `<span class="text-xs font-semibold text-brand shrink-0 mt-0.5 outline-none border-b border-dashed border-brand/40 px-0.5" contenteditable="true" data-speaker-id="${escapeHtml(seg.speakerId)}">${escapeHtml(label)}</span>` +
      `<span class="text-gray-800 leading-relaxed flex-1 outline-none rounded px-1 bg-yellow-50" contenteditable="true" data-index="${committedIndex}">${escapeHtml(seg.text)}</span>` +
      `</div>`
    );
  }

  const seekAttrs = isLive ? '' : ` data-start="${seg.startTime}"`;
  const cls = isLive ? 'opacity-70' : 'cursor-pointer hover:bg-gray-50 rounded';
  return (
    `<div class="flex gap-2 ${cls}"${seekAttrs}>${time}` +
    `<span class="text-xs font-semibold text-brand shrink-0 mt-0.5">${escapeHtml(label)}</span>` +
    `<span class="text-gray-800 leading-relaxed">${escapeHtml(seg.text)}</span>` +
    `</div>`
  );
}

function render(): void {
  const container = document.getElementById('transcribe-segments');
  if (!container) return;

  const liveRow = editMode ? null : live;
  const rows: TranscribeSegment[] = liveRow ? [...committed, liveRow] : [...committed];
  if (rows.length === 0) {
    container.innerHTML =
      '<div id="transcribe-empty" class="h-full flex flex-col items-center justify-center text-center text-gray-400">' +
      '<i class="fas fa-closed-captioning text-3xl mb-2"></i>' +
      '<p class="text-xs">点击「开始转写」捕获当前标签页音频</p></div>';
    return;
  }

  container.innerHTML = rows.map((seg, i) => renderRow(seg, i, seg === liveRow)).join('');

  const meta = document.getElementById('transcribe-meta');
  if (meta) {
    meta.textContent = `${committed.length} 段 · ${speakerLabels.size} 位说话人`;
  }
  if (!editMode) container.scrollTop = container.scrollHeight;
}

/** 接收一条源字幕事件并更新视图。 */
export function applyTranscribeSubtitle(subtitle: TranscribeSubtitle): void {
  const event = subtitle.event;
  const text = (subtitle.text ?? '').trim();
  const start = subtitle.startTime ?? 0;
  const end = subtitle.endTime ?? start;
  const speakerId = normalizeSpeakerId(subtitle.speakerId);
  labelForSpeaker(speakerId); // 确保已登记，便于统计/重命名

  if (event === VOLCENGINE_AST_EVENTS.SourceSubtitleStart) {
    live = { startTime: start, endTime: end, speakerId, text };
  } else if (event === VOLCENGINE_AST_EVENTS.SourceSubtitleResponse) {
    if (!live) {
      live = { startTime: start, endTime: end, speakerId, text };
    } else {
      live.endTime = end;
      if (text) live.text = text;
    }
  } else if (event === VOLCENGINE_AST_EVENTS.SourceSubtitleEnd) {
    const seg = live ?? { startTime: start, endTime: end, speakerId, text };
    seg.endTime = end;
    if (text) seg.text = text;
    if (seg.text) committed.push(seg);
    live = null;
  } else {
    return;
  }
  render();
}

/** 一次性载入已完成的转写（批处理结果，如 Say-So-Scribe 后端返回）。 */
export function loadTranscript(
  segments: { startSec: number; endSec: number; speakerId: string; text: string }[],
  speakers: { id: string; name: string }[] = []
): void {
  committed = segments
    .map((s) => ({
      startTime: Math.round((s.startSec ?? 0) * 1000),
      endTime: Math.round((s.endSec ?? s.startSec ?? 0) * 1000),
      speakerId: normalizeSpeakerId(s.speakerId),
      text: (s.text ?? '').trim(),
    }))
    .filter((s) => s.text);
  live = null;
  editMode = false;
  speakerLabels.clear();
  speakers.forEach((sp) => {
    if (sp.id && sp.name) {
      speakerLabels.set(normalizeSpeakerId(sp.id), sp.name);
    }
  });
  committed.forEach((s) => labelForSpeaker(s.speakerId)); // 补齐未命名说话人标签
  render();
}

/** 清空转写结果（开始新会话时调用）。 */
export function resetTranscript(): void {
  committed = [];
  live = null;
  editMode = false;
  speakerLabels.clear();
  render();
}

/** 切换编辑模式（编辑时禁用点击跳转，分段文本/说话人可改）。 */
export function setEditMode(on: boolean): void {
  editMode = on;
  render();
}

export function isEditMode(): boolean {
  return editMode;
}

/** 提交某条分段的文本编辑（不重渲染，避免光标跳动）。 */
export function setSegmentText(index: number, text: string): void {
  if (index >= 0 && index < committed.length) {
    committed[index].text = text.trim();
  }
}

/** 重命名说话人（同一说话人的所有分段同步更新）。 */
export function renameSpeaker(speakerId: string, name: string): void {
  const trimmed = name.trim();
  if (!speakerId || !trimmed) {
    render();
    return;
  }
  speakerLabels.set(normalizeSpeakerId(speakerId), trimmed);
  render();
}

/** 取完整转写纯文本，供复制/导出。 */
export function getTranscriptText(): string {
  return committed
    .map((seg) => `[${formatTime(seg.startTime)}] ${labelForSpeaker(seg.speakerId)}: ${seg.text}`)
    .join('\n');
}

/** 是否已有可导出/保存的转写内容。 */
export function hasTranscript(): boolean {
  return committed.length > 0;
}

function srtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(millis, 3)}`;
}

/** 按格式构建导出文本。txt=纯文本 / srt=字幕 / md=Markdown。 */
export function buildTranscriptExport(format: TranscriptExportFormat): string {
  if (format === 'txt') {
    return getTranscriptText();
  }
  if (format === 'md') {
    const body = committed
      .map((seg) => `**[${formatTime(seg.startTime)}] ${labelForSpeaker(seg.speakerId)}:** ${seg.text}`)
      .join('\n\n');
    return `# 转写\n\n${body}\n`;
  }
  // srt
  return committed
    .map((seg, i) => {
      const end = seg.endTime > seg.startTime ? seg.endTime : seg.startTime + 2000;
      return `${i + 1}\n${srtTime(seg.startTime)} --> ${srtTime(end)}\n${labelForSpeaker(seg.speakerId)}: ${seg.text}\n`;
    })
    .join('\n');
}
