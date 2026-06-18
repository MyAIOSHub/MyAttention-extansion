/**
 * 按视频时间持久化的同传转写。
 * - 每个视频(deriveVideoId)一份；跨「捕获 pass」(暂停/拖拽/重启)累积，不重置。
 * - 同一 pass 内按 key 原地更新（流式 source/译文）。
 * - 跨 pass 重看同一时间段：videoTime 落在已有节点窗口内 → keep-first 跳过。
 * - 节点按 videoTime 升序，反复拖拽不同段落最终拼出整片转写。
 */
export interface TranscriptNode {
  /** 稳定身份：`${passId}:${sourceSegmentId}`，同一 pass 同一句的流式更新共用。 */
  key: string;
  /** 该句对应的视频播放位置(秒)。 */
  videoTime: number;
  source: string;
  translation: string;
  /** 产生该节点的捕获 pass 序号（用于区分重看 vs 同句流式更新）。 */
  passId: number;
}

export interface TranscriptNodeInput {
  key: string;
  videoTime: number;
  source: string;
  translation: string;
  passId: number;
}

function findIndexByKey(nodes: TranscriptNode[], key: string): number {
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].key === key) {
      return i;
    }
  }
  return -1;
}

function findNearbyDifferentPass(
  nodes: TranscriptNode[],
  videoTime: number,
  passId: number,
  windowSec: number
): boolean {
  return nodes.some(
    (n) => n.passId !== passId && Math.abs(n.videoTime - videoTime) <= windowSec
  );
}

function insertSortedByVideoTime(nodes: TranscriptNode[], incoming: TranscriptNode): TranscriptNode[] {
  let insertAt = nodes.length;
  for (let i = 0; i < nodes.length; i += 1) {
    if (incoming.videoTime < nodes[i].videoTime) {
      insertAt = i;
      break;
    }
  }
  return [...nodes.slice(0, insertAt), incoming, ...nodes.slice(insertAt)];
}

/**
 * 合并一句转写到持久化列表，返回新数组（不可变）。
 * 规则见文件头注释。无效输入（空 source/译文 且空文本）原样返回。
 */
export function upsertTranscriptNode(
  nodes: TranscriptNode[],
  incoming: TranscriptNodeInput,
  dedupWindowSec: number
): TranscriptNode[] {
  if (!Number.isFinite(incoming.videoTime)) {
    return nodes;
  }
  const text = `${incoming.source}${incoming.translation}`.trim();
  if (!text) {
    return nodes;
  }

  const existingIndex = findIndexByKey(nodes, incoming.key);
  if (existingIndex >= 0) {
    // 同句流式更新：原地替换文本（videoTime 保持首次戳，位置不变）
    const updated = nodes.slice();
    updated[existingIndex] = {
      ...updated[existingIndex],
      source: incoming.source,
      translation: incoming.translation,
    };
    return updated;
  }

  // 新 key：跨 pass 重看去重（keep-first）
  if (findNearbyDifferentPass(nodes, incoming.videoTime, incoming.passId, dedupWindowSec)) {
    return nodes;
  }

  return insertSortedByVideoTime(nodes, {
    key: incoming.key,
    videoTime: incoming.videoTime,
    source: incoming.source,
    translation: incoming.translation,
    passId: incoming.passId,
  });
}

/** 由页面 URL 推出稳定的视频标识；YouTube 用 v= 参数，其它去掉 hash/query 噪声。 */
export function deriveVideoId(url: string | undefined): string {
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v) {
        return `youtube:${v}`;
      }
    }
    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\//, '');
      if (id) {
        return `youtube:${id}`;
      }
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}
