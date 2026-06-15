export interface PageTranslationStatusInput {
  translatedCount: number;
  frameCount: number;
  failedFrameCount: number;
  errorMessage?: string;
}

export interface PageTranslationStatus {
  kind: 'success' | 'error';
  message: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 300;

export function formatPageTranslationStatus({
  translatedCount,
  frameCount,
  failedFrameCount,
  errorMessage,
}: PageTranslationStatusInput): PageTranslationStatus {
  if (translatedCount > 0) {
    return {
      kind: 'success',
      message: `已在 ${frameCount} 个 frame 中插入 ${translatedCount} 段译文`,
    };
  }

  if (errorMessage) {
    return {
      kind: 'error',
      message: `翻译失败：${errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)}`,
    };
  }

  if (frameCount > 0 && failedFrameCount >= frameCount) {
    return {
      kind: 'error',
      message: '当前页面翻译脚本未响应，请刷新页面后重试或重新加载扩展。',
    };
  }

  if (failedFrameCount > 0) {
    return {
      kind: 'error',
      message: '部分页面 frame 未响应，且未找到可翻译正文。请刷新页面后重试。',
    };
  }

  return {
    kind: 'success',
    message: '当前页面未找到可翻译文本',
  };
}
