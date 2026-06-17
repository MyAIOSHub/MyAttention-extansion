import { describe, expect, it } from 'vitest';

import {
  reduceSimulcastSpeakerSegments,
  formatSimulcastTimestamp,
  pickActiveSegmentIndex,
  type SimulcastSpeakerSegment,
} from '@/popup/simulcast-speaker-log';

describe('simulcast speaker log', () => {
  it('groups consecutive subtitles by channel and speaker', () => {
    let segments: SimulcastSpeakerSegment[] = [];

    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'source',
      text: 'Hello',
      speakerId: 'speaker-a',
      startTime: 1000,
      endTime: 1600,
    });
    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'source',
      text: 'world',
      speakerId: 'speaker-a',
      startTime: 1700,
      endTime: 2400,
    });
    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'translation',
      text: '你好',
      speakerId: 'speaker-a',
      startTime: 1000,
      endTime: 2400,
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      channel: 'source',
      speakerLabel: '说话人 1',
      text: 'Hello world',
      startTime: 1000,
      endTime: 2400,
    });
    expect(segments[1]).toMatchObject({
      channel: 'translation',
      speakerLabel: '说话人 1',
      text: '你好',
    });
  });

  it('starts a new segment when AST marks a speaker change', () => {
    const segments = reduceSimulcastSpeakerSegments(
      [
        {
          id: 'source-speaker-a-0',
          channel: 'source',
          speakerId: 'speaker-a',
          speakerLabel: '说话人 1',
          startTime: 0,
          endTime: 1000,
          text: 'First',
        },
      ],
      {
        channel: 'source',
        text: 'Second',
        speakerId: 'speaker-a',
        startTime: 1200,
        endTime: 1800,
        spkChg: true,
      }
    );

    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({
      channel: 'source',
      speakerLabel: '说话人 1',
      text: 'Second',
      startTime: 1200,
    });
  });

  it('can replace a streaming partial in the current segment', () => {
    let segments: SimulcastSpeakerSegment[] = [];
    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'translation',
      text: '你好',
      speakerId: 'speaker-a',
      startTime: 0,
      endTime: 500,
    });
    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'translation',
      text: '你好，世界',
      speakerId: 'speaker-a',
      startTime: 0,
      endTime: 900,
      replaceText: true,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      text: '你好，世界',
      endTime: 900,
    });
  });

  it('stamps the spoken video time on a new segment', () => {
    const segments = reduceSimulcastSpeakerSegments([], {
      channel: 'source',
      text: 'Hello',
      speakerId: 'speaker-a',
      videoTime: 43.2,
    });

    expect(segments[0].videoTime).toBe(43.2);
  });

  it('keeps the first video time when merging streaming partials', () => {
    let segments: SimulcastSpeakerSegment[] = [];
    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'source',
      text: 'Hello',
      speakerId: 'speaker-a',
      videoTime: 43.2,
    });
    segments = reduceSimulcastSpeakerSegments(segments, {
      channel: 'source',
      text: 'world',
      speakerId: 'speaker-a',
      videoTime: 45.9,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].videoTime).toBe(43.2);
  });

  it('formats AST millisecond timestamps for the log', () => {
    expect(formatSimulcastTimestamp(0)).toBe('00:00');
    expect(formatSimulcastTimestamp(65_200)).toBe('01:05');
    expect(formatSimulcastTimestamp(undefined)).toBe('--:--');
  });

  describe('pickActiveSegmentIndex', () => {
    const at = (...times: (number | undefined)[]): { videoTime?: number }[] =>
      times.map((videoTime) => ({ videoTime }));

    it('returns -1 for empty input or non-finite playhead', () => {
      expect(pickActiveSegmentIndex([], 10)).toBe(-1);
      expect(pickActiveSegmentIndex(at(10, 20), Number.NaN)).toBe(-1);
    });

    it('returns -1 when the playhead is before the first stamped segment', () => {
      expect(pickActiveSegmentIndex(at(10, 20, 30), 5)).toBe(-1);
    });

    it('picks the last segment whose video time has been reached', () => {
      expect(pickActiveSegmentIndex(at(10, 20, 30), 22)).toBe(1);
      expect(pickActiveSegmentIndex(at(10, 20, 30), 30)).toBe(2);
    });

    it('keeps the latest segment selected within tolerance at the live edge', () => {
      // currentTime jitters just behind the freshly stamped segment
      expect(pickActiveSegmentIndex(at(10, 20), 19.8, 0.5)).toBe(1);
    });

    it('skips segments without a video time but keeps their position', () => {
      expect(pickActiveSegmentIndex(at(10, undefined, 30), 15)).toBe(0);
    });
  });
});
