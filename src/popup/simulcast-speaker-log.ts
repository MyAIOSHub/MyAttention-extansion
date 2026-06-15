export type SimulcastSubtitleChannel = 'source' | 'translation';

export interface SimulcastSpeakerUpdate {
  channel: SimulcastSubtitleChannel;
  text: string;
  speakerId?: string;
  startTime?: number;
  endTime?: number;
  spkChg?: boolean;
  replaceText?: boolean;
}

export interface SimulcastSpeakerSegment {
  id: string;
  channel: SimulcastSubtitleChannel;
  speakerId: string;
  speakerLabel: string;
  startTime: number;
  endTime: number;
  text: string;
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
    },
  ];
}
