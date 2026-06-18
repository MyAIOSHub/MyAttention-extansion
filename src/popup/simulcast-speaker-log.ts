export type SimulcastSubtitleChannel = 'source' | 'translation';

export interface SimulcastSpeakerUpdate {
  channel: SimulcastSubtitleChannel;
  text: string;
  speakerId?: string;
  startTime?: number;
  endTime?: number;
  spkChg?: boolean;
  replaceText?: boolean;
  /** 墙钟时刻(ms)：火山实时 AST 不给可用 startTime，用墙钟时间做分段时间戳。 */
  clockWall?: number;
  /** 该轮次首次出现时主视频的播放位置(秒)；用于按视频时间显示时间戳。 */
  videoTime?: number;
}

export interface SimulcastSpeakerSegment {
  id: string;
  channel: SimulcastSubtitleChannel;
  speakerId: string;
  speakerLabel: string;
  startTime: number;
  endTime: number;
  text: string;
  /** 该轮次首次出现的墙钟时刻(ms)；渲染时相对会话起点格式化。 */
  clockWall: number;
  /** 该轮次首次出现时主视频的播放位置(秒)；优先用它显示时间戳。 */
  videoTime?: number;
}

const UNKNOWN_SPEAKER_ID = '__unknown__';

function getSpeakerKey(speakerId: string | undefined): string {
  return speakerId && speakerId.trim().length > 0 ? speakerId.trim() : UNKNOWN_SPEAKER_ID;
}

function getSpeakerLabel(segments: SimulcastSpeakerSegment[], speakerId: string): string {
  if (speakerId === UNKNOWN_SPEAKER_ID) {
    return '未知说话人';
  }

  const knownSpeakers = Array.from(
    new Set(
      segments
        .map((segment) => segment.speakerId)
        .filter((id) => id !== UNKNOWN_SPEAKER_ID)
    )
  );
  const existingIndex = knownSpeakers.indexOf(speakerId);
  return `说话人 ${existingIndex >= 0 ? existingIndex + 1 : knownSpeakers.length + 1}`;
}

function normalizeSegmentTime(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatSimulcastTimestamp(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--:--';
  }

  const totalSeconds = Math.floor(Math.max(0, value) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 卡拉OK式：按主视频播放头(秒)挑出当前应显示的源句序号。
 * 返回最后一个「videoTime 已被播放头越过(含容差)」的段；播放头早于首段时返回 -1。
 * 容差吸收 live 边缘的采样抖动，避免刚打戳的最新句被瞬时回退到上一句。
 */
export function pickActiveSegmentIndex(
  sources: Pick<SimulcastSpeakerSegment, 'videoTime'>[],
  currentTime: number,
  toleranceSec = 0.5
): number {
  if (!Number.isFinite(currentTime)) {
    return -1;
  }
  let active = -1;
  for (let i = 0; i < sources.length; i += 1) {
    const t = sources[i].videoTime;
    if (typeof t === 'number' && Number.isFinite(t) && t <= currentTime + toleranceSec) {
      active = i;
    }
  }
  return active;
}

/**
 * 选取面板可见窗口起点：默认显示末尾 windowSize 条（直播）；
 * 当高亮段（回退/拖动定位的当前句）落在默认窗口之前时，把窗口前移以包含它。
 */
export function computeVisibleWindowStart(
  total: number,
  activeIndex: number,
  windowSize: number
): number {
  let start = Math.max(0, total - windowSize);
  if (activeIndex >= 0 && activeIndex < start) {
    start = Math.max(0, activeIndex - Math.floor(windowSize / 2));
  }
  return start;
}

export function reduceSimulcastSpeakerSegments(
  segments: SimulcastSpeakerSegment[],
  update: SimulcastSpeakerUpdate
): SimulcastSpeakerSegment[] {
  const text = update.text.trim();
  if (!text) {
    return segments;
  }

  const speakerId = getSpeakerKey(update.speakerId);
  const startTime = normalizeSegmentTime(update.startTime);
  const endTime = normalizeSegmentTime(update.endTime || update.startTime);
  const lastSegment = segments[segments.length - 1];

  if (
    lastSegment &&
    !update.spkChg &&
    lastSegment.channel === update.channel &&
    lastSegment.speakerId === speakerId
  ) {
    return [
      ...segments.slice(0, -1),
      {
        ...lastSegment,
        endTime: Math.max(lastSegment.endTime, endTime),
        text: update.replaceText ? text : `${lastSegment.text} ${text}`.trim(),
      },
    ];
  }

  const speakerLabel = getSpeakerLabel(segments, speakerId);
  return [
    ...segments,
    {
      id: `${update.channel}-${speakerId}-${segments.length}`,
      channel: update.channel,
      speakerId,
      speakerLabel,
      startTime,
      endTime,
      text,
      clockWall: typeof update.clockWall === 'number' ? update.clockWall : 0,
      videoTime:
        typeof update.videoTime === 'number' && Number.isFinite(update.videoTime)
          ? Math.max(0, update.videoTime)
          : undefined,
    },
  ];
}
