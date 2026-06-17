/**
 * 导出功能模块
 * 支持 TXT 和 ZIP 格式导出
 */

import type { Conversation, ExportConfig, PlatformName } from '@/types';
import { Logger, ErrorFactory } from '@/core/errors';
import { PLATFORM_NAMES } from '@/types';
import { EXPORT_FILENAME_PREFIX } from '@/core/constants';

/**
 * 导出格式类型
 */
export type ExportFormat = 'separate' | 'merged';

/**
 * 导出元数据
 */
export interface ExportMetadata {
  searchTerm?: string;
  filter?: {
    startDate?: string;
    endDate?: string;
    platforms?: PlatformName[];
  };
}

/**
 * 导出管理器
 */
export class ExportManager {
  /**
   * 根据对话ID列表导出对话
   * @param conversationIds - 要导出的对话ID列表
   * @param exportType - 导出类型
   * @param metadata - 元数据
   * @returns 导出文件的 dataURL
   */
  async exportConversations(
    conversationIds: string[],
    exportType: ExportFormat = 'separate',
    metadata: ExportMetadata = {}
  ): Promise<string | null> {
    Logger.info('[Export] 开始导出', {
      count: conversationIds.length,
      type: exportType,
    });

    // 获取对话数据（由调用者提供，这里只处理导出逻辑）
    const conversations: Conversation[] = [];

    // 根据ID列表获取对话（需要外部传入 conversations）
    if (conversations.length === 0) {
      Logger.warn('[Export] 没有对话可导出');
      return null;
    }

    // 按创建时间倒序排列（最新的在前面）
    const sortedConversations = conversations.sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });

    if (exportType === 'merged') {
      return this.exportAsMergedFile(sortedConversations, metadata);
    } else {
      return this.exportAsSeparateFiles(sortedConversations, metadata);
    }
  }

  /**
   * 导出为单个合并文件（TXT 格式）
   */
  private async exportAsMergedFile(
    conversations: Conversation[],
    metadata: ExportMetadata
  ): Promise<string | null> {
    Logger.info('[Export] 导出为合并 TXT 文件');

    return new Promise((resolve) => {
      try {
        // 生成合并内容
        const mergedContent = this.generateMergedExportContent(
          conversations,
          metadata
        );

        // 生成统一格式文件名
        const count = conversations.length;
        const filename = this.generateStandardExportFilename(count, 'txt');

        // 创建 Blob
        const blob = new Blob([mergedContent], {
          type: 'text/plain;charset=utf-8',
        });

        // 使用 FileReader 创建 Data URL
        const reader = new FileReader();
        reader.onload = function () {
          const dataUrl = reader.result as string;

          // 使用 chrome.downloads API 下载文件
          chrome.downloads.download(
            {
              url: dataUrl,
              filename: filename,
              saveAs: true,
            },
            (downloadId) => {
              if (chrome.runtime.lastError) {
                Logger.error('[Export] 下载失败', chrome.runtime.lastError);
                resolve(null);
              } else {
                Logger.info('[Export] 下载成功', { filename, downloadId });
                resolve(dataUrl);
              }
            }
          );
        };
        reader.onerror = function () {
          Logger.error('[Export] 读取文件失败', reader.error);
          resolve(null);
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        Logger.error('[Export] 导出合并文件失败', error);
        resolve(null);
      }
    });
  }

  /**
   * 导出为多个独立文件（ZIP 格式）
   */
  private async exportAsSeparateFiles(
    conversations: Conversation[],
    metadata: ExportMetadata
  ): Promise<string | null> {
    Logger.warn('[Export] ZIP 导出在当前构建模式下暂不可用，已回退为合并 TXT 导出');
    return this.exportAsMergedFile(conversations, metadata);
  }

  /**
   * 生成合并导出内容（纯文本格式）
   */
  private generateMergedExportContent(
    conversations: Conversation[],
    metadata: ExportMetadata
  ): string {
    let content = `# SaySo Scribe - All Conversations\n`;
    content += `Export Time: ${this.formatDateTimeForDisplay(new Date())}\n`;
    content += `Total Conversations: ${conversations.length}\n`;

    // 添加筛选条件信息
    if (metadata.searchTerm || metadata.filter) {
      content += `\nFilter Conditions: \n`;
      if (metadata.searchTerm) {
        content += `- Search Term: ${metadata.searchTerm}\n`;
      }
      if (metadata.filter) {
        if (metadata.filter.startDate) {
          content += `- Start Date: ${metadata.filter.startDate}\n`;
        }
        if (metadata.filter.endDate) {
          content += `- End Date: ${metadata.filter.endDate}\n`;
        }
        if (
          metadata.filter.platforms &&
          metadata.filter.platforms.length > 0
        ) {
          const selectedPlatforms = metadata.filter.platforms
            .map((p) => PLATFORM_NAMES[p] || p)
            .join(', ');
          content += `- Selected Platforms: ${selectedPlatforms}\n`;
        }
      }
    }

    content += '\n' + '='.repeat(80) + '\n\n';

    // 按时间排序对话（最新的在前）
    const sortedConversations = conversations.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // 添加每个对话
    sortedConversations.forEach((conversation, index) => {
      content += this.formatConversationForExport(conversation);
      if (index < sortedConversations.length - 1) {
        content += '\n' + '='.repeat(80) + '\n\n';
      }
    });

    return content;
  }

  /**
   * 格式化对话内容用于导出
   */
  private formatConversationForExport(conversation: Conversation): string {
    // 构建标题部分
    let output = `Title: ${conversation.title || 'Untitled Conversation'}\n`;
    output += `URL: ${conversation.link}\n`;
    output += `Platform: ${this.getPlatformDisplayName(conversation.platform)}\n`;

    // 格式化创建时间为 yyyy-MM-DD hh:mm:ss
    const createdAtFormatted = this.formatDateTimeForDisplay(
      new Date(conversation.createdAt)
    );
    output += `Created: ${createdAtFormatted}\n`;
    output += `Messages: ${conversation.messages.length}\n\n`;

    // 添加每条消息
    conversation.messages.forEach((message) => {
      const sender = message.sender === 'user' ? 'User' : 'AI';

      // 格式化消息时间为 yyyy-MM-DD hh:mm:ss
      let timestamp = message.createdAt || message.updatedAt;
      if (timestamp) {
        try {
          timestamp = this.formatDateTimeForDisplay(new Date(timestamp));
        } catch (e) {
          // 如果无法解析时间戳，保持原样
        }
      }

      output += `${sender}: [${timestamp}]\n`;

      // 如果是 AI 消息且有 thinking 内容
      if (sender === 'AI' && message.thinking) {
        output += '<thinking>\n';
        output += `${message.thinking}\n`;
        output += '</thinking>\n';
      }

      output += `${message.content}\n\n`;
    });

    return output;
  }

  /**
   * 获取平台的显示名称
   */
  private getPlatformDisplayName(platform: PlatformName): string {
    return PLATFORM_NAMES[platform] || platform;
  }

  /**
   * 生成统一的导出文件名
   */
  private generateStandardExportFilename(
    count: number,
    fileType: 'txt' | 'zip'
  ): string {
    const timestamp = this.formatDateForFilename(new Date());
    return `${EXPORT_FILENAME_PREFIX}${count}_${timestamp}.${fileType}`;
  }

  /**
   * 生成导出文件名
   */
  private generateExportFilename(conversation: Conversation): string {
    // 获取平台名称
    const platform = conversation.platform || 'Unknown';

    // 格式化创建时间，精确到秒 (yyyyMMddHHmmss)
    let timestamp;
    try {
      const createdDate = new Date(conversation.createdAt);
      timestamp = this.formatDateForFilename(createdDate);
    } catch (e) {
      // 如果日期解析失败，使用当前时间
      const now = new Date();
      timestamp = this.formatDateForFilename(now);
    }

    // 使用清理函数处理标题
    const title = conversation.title
      ? this.cleanFilename(conversation.title, 30)
      : 'conversation';

    return `${platform}_${timestamp}_${title}.txt`;
  }

  /**
   * 格式化日期时间为 yyyy-MM-DD hh:mm:ss 格式
   */
  private formatDateTimeForDisplay(date: Date): string {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      return 'Invalid Date';
    }

    const year = date.getFullYear();
    const month = ('0' + (date.getMonth() + 1)).slice(-2);
    const day = ('0' + date.getDate()).slice(-2);
    const hours = ('0' + date.getHours()).slice(-2);
    const minutes = ('0' + date.getMinutes()).slice(-2);
    const seconds = ('0' + date.getSeconds()).slice(-2);

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * 格式化日期时间为 yyyyMMddHHmmss 格式，用于文件名
   */
  private formatDateForFilename(date: Date): string {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      return 'InvalidDate';
    }

    const year = date.getFullYear();
    const month = ('0' + (date.getMonth() + 1)).slice(-2);
    const day = ('0' + date.getDate()).slice(-2);
    const hours = ('0' + date.getHours()).slice(-2);
    const minutes = ('0' + date.getMinutes()).slice(-2);
    const seconds = ('0' + date.getSeconds()).slice(-2);

    return `${year}${month}${day}${hours}${minutes}${seconds}`;
  }

  /**
   * 清理文件名字符串，处理空格、下划线等特殊字符
   */
  private cleanFilename(filename: string, maxLength: number = 30): string {
    if (!filename || typeof filename !== 'string') {
      return 'untitled';
    }

    // 截取指定长度
    let cleaned = filename.substring(0, maxLength);

    // 保留中文、日文、韩文、英文、数字，将其他字符替换为下划线
    cleaned = cleaned.replace(
      /[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/gi,
      '_'
    );

    // 将空格替换为下划线
    cleaned = cleaned.replace(/\s+/g, '_');

    // 合并连续的下划线为单个下划线
    cleaned = cleaned.replace(/_+/g, '_');

    // 移除开头和结尾的下划线
    cleaned = cleaned.replace(/^_+|_+$/g, '');

    // 如果清理后为空，使用默认名称
    if (!cleaned) {
      return 'untitled';
    }

    return cleaned;
  }
}

// 导出单例
export const exportManager = new ExportManager();
