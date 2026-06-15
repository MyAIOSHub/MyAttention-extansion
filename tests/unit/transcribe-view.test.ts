import { describe, it, expect, beforeEach } from 'vitest';
import { VOLCENGINE_AST_EVENTS } from '../../src/translation/volcengine-ast-protobuf';
import {
  applyTranscribeSubtitle,
  resetTranscript,
  getTranscriptText,
  buildTranscriptExport,
  hasTranscript,
  setEditMode,
  setSegmentText,
  renameSpeaker,
} from '../../src/popup/transcribe-view';

function setupDom(): void {
  document.body.innerHTML =
    '<div id="transcribe-segments"></div><span id="transcribe-meta"></span>';
}

describe('transcribe-view', () => {
  beforeEach(() => {
    setupDom();
    resetTranscript();
  });

  it('commits a segment on Start→Response→End and exposes its text', () => {
    const speakerId = 'spk-1';
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleStart, text: '', startTime: 3000, speakerId });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleResponse, text: '你好世', startTime: 3000, speakerId });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: '你好世界', startTime: 3000, speakerId });

    expect(getTranscriptText()).toBe('[00:03] S1: 你好世界');
    expect(document.getElementById('transcribe-segments')?.textContent).toContain('你好世界');
    expect(document.getElementById('transcribe-meta')?.textContent).toContain('1 段');
  });

  it('assigns stable incremental speaker labels', () => {
    const commit = (id: string, text: string): void => {
      applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleStart, text: '', speakerId: id });
      applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text, speakerId: id });
    };
    commit('a', 'first');
    commit('b', 'second');
    commit('a', 'third');
    expect(getTranscriptText()).toBe('[00:00] S1: first\n[00:00] S2: second\n[00:00] S1: third');
  });

  it('ignores translation/other events and empty finals', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.TranslationSubtitleResponse, text: 'translated' });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: '' });
    expect(getTranscriptText()).toBe('');
  });

  it('resets all state', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'x', speakerId: 's' });
    expect(getTranscriptText()).not.toBe('');
    resetTranscript();
    expect(getTranscriptText()).toBe('');
    expect(document.getElementById('transcribe-segments')?.textContent).toContain('开始转写');
  });

  it('builds txt / md / srt exports', () => {
    expect(hasTranscript()).toBe(false);
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleStart, text: '', startTime: 1000, endTime: 1000, speakerId: 's' });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: '你好', startTime: 1000, endTime: 4500, speakerId: 's' });
    expect(hasTranscript()).toBe(true);

    expect(buildTranscriptExport('txt')).toBe('[00:01] S1: 你好');
    expect(buildTranscriptExport('md')).toBe('# 转写\n\n**[00:01] S1:** 你好\n');

    const srt = buildTranscriptExport('srt');
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:04,500\nS1: 你好');
  });

  it('falls back srt end time when endTime missing', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'x', startTime: 2000, speakerId: 's' });
    const srt = buildTranscriptExport('srt');
    // endTime defaults to startTime, so srt uses startTime+2000
    expect(srt).toContain('00:00:02,000 --> 00:00:04,000');
  });

  it('marks committed segments seekable with data-start (ms)', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'done', startTime: 5000, speakerId: 's' });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleStart, text: 'live…', startTime: 9000, speakerId: 's' });
    const html = document.getElementById('transcribe-segments')?.innerHTML ?? '';
    expect(html).toContain('data-start="5000"'); // committed → seekable
    expect(html).not.toContain('data-start="9000"'); // live row → not seekable
  });

  it('edits segment text via setSegmentText', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'orig', startTime: 0, speakerId: 's' });
    setSegmentText(0, '  fixed text  ');
    expect(getTranscriptText()).toBe('[00:00] S1: fixed text');
  });

  it('renames a speaker across all its segments', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'a', startTime: 0, speakerId: 'x' });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'b', startTime: 1000, speakerId: 'y' });
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'c', startTime: 2000, speakerId: 'x' });
    renameSpeaker('x', '王');
    expect(getTranscriptText()).toBe('[00:00] 王: a\n[00:01] S2: b\n[00:02] 王: c');
    // empty rename is ignored
    renameSpeaker('y', '   ');
    expect(getTranscriptText()).toContain('S2: b');
  });

  it('edit mode renders contenteditable rows with data-index / data-speaker-id', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: 'hello', startTime: 0, speakerId: 's' });
    setEditMode(true);
    const html = document.getElementById('transcribe-segments')?.innerHTML ?? '';
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-speaker-id="s"');
    expect(html).not.toContain('data-start='); // seek disabled in edit mode
    setEditMode(false);
  });

  it('escapes HTML in transcript text', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: '<b>x</b>', speakerId: 's' });
    const html = document.getElementById('transcribe-segments')?.innerHTML ?? '';
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});
