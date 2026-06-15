import { describe, it, expect, beforeEach } from 'vitest';
import { VOLCENGINE_AST_EVENTS } from '../../src/translation/volcengine-ast-protobuf';
import {
  applyTranscribeSubtitle,
  resetTranscript,
  getTranscriptText,
  buildTranscriptExport,
  hasTranscript,
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

  it('escapes HTML in transcript text', () => {
    applyTranscribeSubtitle({ event: VOLCENGINE_AST_EVENTS.SourceSubtitleEnd, text: '<b>x</b>', speakerId: 's' });
    const html = document.getElementById('transcribe-segments')?.innerHTML ?? '';
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});
