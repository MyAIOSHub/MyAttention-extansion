import { describe, expect, it } from 'vitest';

import {
  upsertTranscriptNode,
  deriveVideoId,
  type TranscriptNode,
} from '@/popup/simulcast-transcript';

const WINDOW = 1;

function node(partial: Partial<TranscriptNode>): Parameters<typeof upsertTranscriptNode>[1] {
  return {
    key: partial.key ?? 'p1:source-0',
    videoTime: partial.videoTime ?? 0,
    source: partial.source ?? '',
    translation: partial.translation ?? '',
    passId: partial.passId ?? 1,
  };
}

describe('upsertTranscriptNode', () => {
  it('inserts nodes ordered by video time regardless of arrival order', () => {
    let nodes: TranscriptNode[] = [];
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-0', videoTime: 30, source: 'b' }), WINDOW);
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-1', videoTime: 10, source: 'a' }), WINDOW);
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-2', videoTime: 20, source: 'c' }), WINDOW);

    expect(nodes.map((n) => n.videoTime)).toEqual([10, 20, 30]);
    expect(nodes.map((n) => n.source)).toEqual(['a', 'c', 'b']);
  });

  it('updates the same node in place by key (streaming source/translation of one turn)', () => {
    let nodes: TranscriptNode[] = [];
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-0', videoTime: 12, source: 'Hello' }), WINDOW);
    nodes = upsertTranscriptNode(
      nodes,
      node({ key: 'p1:s-0', videoTime: 12, source: 'Hello world', translation: '你好世界' }),
      WINDOW
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ source: 'Hello world', translation: '你好世界' });
  });

  it('keeps distinct same-pass utterances even when within the dedup window', () => {
    let nodes: TranscriptNode[] = [];
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-0', videoTime: 12.0, source: 'one' }), WINDOW);
    // 0.4s 后的另一句，同一 pass，不同 key → 必须保留为独立节点
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-1', videoTime: 12.4, source: 'two' }), WINDOW);

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.source)).toEqual(['one', 'two']);
  });

  it('skips a re-watched utterance from a later pass within the window (keep-first)', () => {
    let nodes: TranscriptNode[] = [];
    nodes = upsertTranscriptNode(
      nodes,
      node({ key: 'p1:s-0', videoTime: 12.0, source: 'original', translation: '原' }),
      WINDOW
    );
    // 重看：新 pass、不同 key、videoTime 在窗口内 → 跳过，保留旧的
    nodes = upsertTranscriptNode(
      nodes,
      node({ key: 'p2:s-0', videoTime: 12.6, source: 'rewatch', translation: '重', passId: 2 }),
      WINDOW
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ key: 'p1:s-0', source: 'original', translation: '原' });
  });

  it('fills a gap on re-watch when no committed node is near that time', () => {
    let nodes: TranscriptNode[] = [];
    nodes = upsertTranscriptNode(nodes, node({ key: 'p1:s-0', videoTime: 10, source: 'a' }), WINDOW);
    // 第一遍漏掉的 20s 处，第二遍补上（无邻近节点）→ 插入
    nodes = upsertTranscriptNode(
      nodes,
      node({ key: 'p2:s-0', videoTime: 20, source: 'b', passId: 2 }),
      WINDOW
    );

    expect(nodes.map((n) => n.videoTime)).toEqual([10, 20]);
  });
});

describe('deriveVideoId', () => {
  it('uses the YouTube video id', () => {
    expect(deriveVideoId('https://www.youtube.com/watch?v=RkQQ7WEor7w&t=48s')).toBe('youtube:RkQQ7WEor7w');
  });

  it('falls back to the URL without hash/query noise for non-YouTube', () => {
    expect(deriveVideoId('https://example.com/talk/123#t=5')).toBe('https://example.com/talk/123');
  });

  it('returns empty string for blank input', () => {
    expect(deriveVideoId('')).toBe('');
    expect(deriveVideoId(undefined)).toBe('');
  });
});
