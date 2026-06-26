/**
 * 平台适配器基类
 * 抽取所有平台的公共逻辑，各平台只需实现特定的抽象方法
 */

import type {
  PlatformName,
  Message,
  Conversation,
  ConversationInfo,
} from '@/types';
import { chromeMessageAdapter } from '@/core/chrome-message';
import { eventBus } from '@/core/event-bus';
import { DEFAULT_SETTINGS, MANUAL_SAVE_EVENT, URL_CHANGED_EVENT } from '@/core/constants';
import { Logger } from '@/core/errors';

/**
 * 平台适配器基类
 * 所有平台适配器必须继承此类
 */
export abstract class BasePlatformAdapter {
  /** 平台名称 */
  protected readonly platform: PlatformName;

  /** 当前页面 URL */
  protected pageUrl: string;

  /** 当前对话 ID */
  protected currentConversationId: string | null = null;

  /** 已保存的消息 ID 集合 */
  protected savedMessageIds: Set<string> = new Set();

  /** 最后检查时间 */
  protected lastCheckTime: number = 0;

  /** 是否正在检查 */
  protected isChecking: boolean = false;

  /** 内容观察器 */
  protected contentObserver: MutationObserver | null = null;

  /** 检查间隔 */
  protected readonly CHECK_INTERVAL: number = 2000;

  /** 当前消息映射 */
  protected currentMessagesMap: Map<string, string> = new Map();

  /** 防抖定时器 */
  protected debounceTimer: number | null = null;

  /** 防抖延迟 */
  protected readonly DEBOUNCE_DELAY: number = 1000;

  /** 上次消息 JSON */
  protected lastMessagesJson: string | null = null;

  /** 上次已知 URL */
  protected lastKnownUrl: string = '';

  /** 上次已知对话 ID */
  protected lastKnownConversationId: string | null = null;

  /** URL 检查定时器 */
  protected urlCheckInterval: number | null = null;

  /** 是否正在创建对话 */
  protected isCreatingConversation: boolean = false;

  /** 创建对话 Promise */
  protected creationPromise: Promise<string | null> | null = null;

  /** 当前 URL 键 */
  protected currentUrlKey: string | null = null;

  /** 全局设置 */
  protected settings: typeof DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  /**
   * 构造函数
   * @param platform - 平台名称
   */
  constructor(platform: PlatformName) {
    this.platform = platform;
    this.pageUrl = window.location.href;
    this.settings = DEFAULT_SETTINGS;
    this.initializeSettings();
  }

  /**
   * 初始化设置
   */
  protected initializeSettings(): void {
    if (window.saySoSettings) {
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...window.saySoSettings,
      };
    }

    // 监听设置更新
    chromeMessageAdapter.onMessage('settingsUpdated', (message, sender, sendResponse) => {
      if (message.settings) {
        this.settings = {
          ...this.settings,
          ...message.settings,
        };
        console.log(`[Adapter] ${this.platform} 设置已更新`);
      }
      sendResponse({ status: 'ok' });
      return true;
    });
  }

  // ==================== 抽象方法（子类必须实现）===================

  /**
   * 验证是否为有效的对话 URL
   * @param url - 要验证的 URL
   * @returns 是否为有效的对话 URL
   */
  abstract isValidConversationUrl(url: string): boolean;

  /**
   * 从 URL 中提取对话信息
   * @param url - 要分析的 URL
   * @returns 对话信息
   */
  abstract extractConversationInfo(url: string): ConversationInfo;

  /**
   * 提取页面上的所有消息
   * @returns 消息数组
   */
  abstract extractMessages(): Message[];

  /**
   * 检查元素是否为消息元素
   * @param node - 要检查的 DOM 节点
   * @returns 是否为消息元素
   */
  abstract isMessageElement(node: Node): boolean;

  /**
   * 从页面提取标题（可选实现）
   * @returns 提取的标题或 null
   */
  extractTitle(): string | null {
    return null;
  }

  // ==================== 公共方法 ====================

  /**
   * 初始化适配器
   */
  init(): void {
    if (this.isValidConversationUrl(this.pageUrl)) {
      setTimeout(() => {
        this.initAdapter();
      }, 100);
    } else {
      console.log(`[Adapter] 当前页面不是有效的 ${this.platform} 对话页面`);
    }
  }

  /**
   * 初始化适配器核心逻辑
   * @param options - 初始化选项
   */
  protected initAdapter(options: {
    url?: string;
    conversationId?: string | null;
    isNewConversation?: boolean;
  } = {}): void {
    // 断开之前的内容观察器
    if (this.contentObserver) {
      console.log('[Adapter] 断开之前的内容观察器');
      this.contentObserver.disconnect();
      this.contentObserver = null;
    }

    this.pageUrl = options.url || window.location.href;
    const extractedConversationId = options.conversationId;
    const isNewConversation = options.isNewConversation;

    console.log(`[Adapter] 初始化适配器 - URL: ${this.pageUrl}`);
    console.log(`[Adapter] 对话 ID: ${extractedConversationId || '未提取'}`);
    console.log(`[Adapter] 是否新对话: ${isNewConversation || false}`);

    const cleanUrl = this.pageUrl.split('?')[0];
    const urlKey = `${this.platform}_${cleanUrl}`;

    // URL 变化时重置创建状态
    if (this.currentUrlKey !== urlKey) {
      this.isCreatingConversation = false;
      this.creationPromise = null;
      this.currentUrlKey = urlKey;
    }

    this.connectToDatabase()
      .then(() => {
        if (this.settings.autoSave) {
          return this.findOrCreateConversation();
        }
        return this.findConversation();
      })
      .then((conversationId) => {
        if (!conversationId) {
          console.log('[Adapter] 未找到对话 ID 或无法创建对话。停止初始化。');
          return Promise.reject('No conversation ID');
        }

        this.currentConversationId = conversationId;
        console.log('[Adapter] 当前对话 ID:', this.currentConversationId);

        if (this.settings.autoSave) {
          console.log('[Adapter] 自动保存模式 - 执行初始保存');
          return this.saveAllMessages();
        } else {
          console.log('[Adapter] 手动保存模式 - 跳过初始保存');
          return Promise.resolve();
        }
      })
      .then((saveResult) => {
        if (!this.currentConversationId) return;

        if (this.settings.autoSave) {
          console.log('[Adapter] 自动保存模式 - 设置内容变化监听器');
          this.contentObserver = this.setupMutationObserver();
        } else {
          console.log('[Adapter] 手动保存模式 - 不设置自动监听器');
        }
      })
      .catch((error) => {
        if (error !== 'No conversation ID') {
          console.error('[Adapter] 初始化失败:', error);
        }
      });
  }

  /**
   * 连接到数据库
   */
  protected async connectToDatabase(): Promise<void> {
    const response = await chromeMessageAdapter.sendMessage({
      type: 'connectDB',
    });

    if (response?.status === 'ok') {
      console.log('[Adapter] 数据库连接成功');
    } else {
      throw new Error('数据库连接失败');
    }
  }

  /**
   * 仅查找对话，不创建新对话
   * @returns 对话 ID 或 null
   */
  protected async findConversation(): Promise<string | null> {
    const conversationId = this.lastKnownConversationId;

    if (conversationId && !conversationId.startsWith('new_conversation_')) {
      console.log(`[Adapter] 使用对话 ID 查询对话: ${conversationId}`);

      const response = await chromeMessageAdapter.sendMessage({
        type: 'getConversationById',
        conversationId,
      });

      if (response?.conversation) {
        console.log(`[Adapter] 通过 ID 找到对话: ${response.conversation.conversationId}`);
        return response.conversation.conversationId;
      }

      return this.fallbackToUrlSearch();
    }

    return this.fallbackToUrlSearch();
  }

  /**
   * 回退到 URL 查询
   */
  protected async fallbackToUrlSearch(): Promise<string | null> {
    const cleanUrl = this.pageUrl.split('?')[0];
    console.log(`[Adapter] 回退到 URL 查询: ${cleanUrl}`);

    const response = await chromeMessageAdapter.sendMessage({
      type: 'findConversationByUrl',
      url: cleanUrl,
    });

    if (response?.conversation) {
      console.log(`[Adapter] 通过 URL 找到对话: ${response.conversation.conversationId}`);
      return response.conversation.conversationId;
    }

    console.log('[Adapter] 未找到对话，不创建新对话');
    return null;
  }

  /**
   * 查找或创建对话
   * @returns 对话 ID 或 null
   */
  protected async findOrCreateConversation(): Promise<string | null> {
    const cleanUrl = this.pageUrl.split('?')[0];
    const urlKey = `${this.platform}_${cleanUrl}`;

    // 如果正在为同一 URL 创建对话，返回现有的 Promise
    if (
      this.isCreatingConversation &&
      this.currentUrlKey === urlKey &&
      this.creationPromise
    ) {
      console.log(`[Adapter] 正在为 URL 创建对话，等待现有操作完成: ${cleanUrl}`);
      return this.creationPromise;
    }

    // URL 变化时重置创建状态
    if (this.currentUrlKey !== urlKey) {
      this.isCreatingConversation = false;
      this.creationPromise = null;
      this.currentUrlKey = urlKey;
    }

    // 设置创建锁
    this.isCreatingConversation = true;
    this.currentUrlKey = urlKey;

    this.creationPromise = new Promise<string | null>((resolve, reject) => {
      const attemptExtraction = (retryCount: number = 0): void => {
        const messages = this.extractMessages();

        if (messages.length === 0 && retryCount < 3) {
          console.log(
            `[Adapter] 页面暂无消息内容，${1000 * (retryCount + 1)}ms 后重试 (${
              retryCount + 1
            }/3)`
          );
          setTimeout(() => attemptExtraction(retryCount + 1), 1000 * (retryCount + 1));
          return;
        }

        if (messages.length === 0) {
          console.log('[Adapter] 页面无消息内容，不创建新对话');
          this.isCreatingConversation = false;
          this.creationPromise = null;
          resolve(null);
          return;
        }

        this.processConversation(messages, resolve, reject);
      };

      attemptExtraction();
    });

    // 处理 Promise 完成后的清理
    this.creationPromise.finally(() => {
      this.isCreatingConversation = false;
      this.creationPromise = null;
    });

    return this.creationPromise;
  }

  /**
   * 处理对话的核心逻辑
   */
  protected processConversation(
    messages: Message[],
    resolve: (id: string | null) => void,
    reject: (error: unknown) => void
  ): void {
    const conversationId = this.lastKnownConversationId;
    const isNewConversation =
      conversationId && conversationId.startsWith('new_conversation_');

    if (conversationId && !isNewConversation) {
      console.log(`[Adapter] 使用对话 ID 查询对话: ${conversationId}`);

      chromeMessageAdapter
        .sendMessage({
          type: 'getConversationById',
          conversationId,
        })
        .then((response) => {
          if (response?.conversation) {
            console.log(`[Adapter] 通过 ID 找到对话: ${response.conversation.conversationId}`);
            resolve(response.conversation.conversationId);
            return;
          }
          this.fallbackToUrlSearchForCreate(messages, resolve, reject);
        });

      return;
    }

    this.fallbackToUrlSearchForCreate(messages, resolve, reject);
  }

  /**
   * 创建新对话的 URL 查询回退
   */
  protected fallbackToUrlSearchForCreate(
    messages: Message[],
    resolve: (id: string | null) => void,
    reject: (error: unknown) => void
  ): void {
    const cleanUrl = this.pageUrl.split('?')[0];
    console.log(`[Adapter] 回退到 URL 查询: ${cleanUrl}`);

    chromeMessageAdapter
      .sendMessage({
        type: 'findConversationByUrl',
        url: cleanUrl,
      })
      .then((response) => {
        if (response?.conversation) {
          console.log(`[Adapter] 通过 URL 找到对话: ${response.conversation.conversationId}`);
          resolve(response.conversation.conversationId);
        } else {
          // 在创建新对话前再次检查，防止竞争条件
          this.doubleCheckBeforeCreate(messages, cleanUrl, resolve, reject);
        }
      });
  }

  /**
   * 创建前双重检查，防止竞争条件
   */
  protected doubleCheckBeforeCreate(
    messages: Message[],
    cleanUrl: string,
    resolve: (id: string | null) => void,
    reject: (error: unknown) => void
  ): void {
    console.log(`[Adapter] 创建前双重检查 URL: ${cleanUrl}`);

    chromeMessageAdapter
      .sendMessage({
        type: 'findConversationByUrl',
        url: cleanUrl,
      })
      .then((response) => {
        if (response?.conversation) {
          console.log(`[Adapter] 双重检查找到现有对话: ${response.conversation.conversationId}`);
          resolve(response.conversation.conversationId);
        } else {
          console.log(`[Adapter] 确认需要创建新对话: ${cleanUrl}`);
          this.createNewConversation(messages, cleanUrl, resolve, reject);
        }
      });
  }

  /**
   * 创建新对话
   */
  protected async createNewConversation(
    messages: Message[],
    cleanUrl: string,
    resolve: (id: string | null) => void,
    reject: (error: unknown) => void
  ): Promise<void> {
    const title = this.extractTitle() || this.generateTitleFromMessages(messages);

    const conversation: Partial<Conversation> = {
      link: cleanUrl,
      title,
      platform: this.platform,
      messages,
      externalId: this.lastKnownConversationId || null,
    };

    console.log(`[Adapter] 创建新对话，包含消息数量: ${messages.length}`);

    try {
      const response = await chromeMessageAdapter.sendMessage({
        type: 'createConversation',
        conversation: conversation as Conversation,
      });

      if (response?.conversationId) {
        // 触发保存成功事件
        eventBus.publish('message:saved', { messageId: response.conversationId });

        console.log(`[Adapter] 成功创建新对话: ${response.conversationId}`);
        resolve(response.conversationId);
      } else {
        throw new Error('创建对话失败');
      }
    } catch (error) {
      console.error('[Adapter] 创建对话失败:', error);
      reject(error);
    }
  }

  /**
   * 从消息中生成标题
   */
  protected generateTitleFromMessages(messages: Message[]): string {
    const firstUserMessage = messages.find((m) => m.sender === 'user');
    if (firstUserMessage) {
      const text = firstUserMessage.content;
      return text.length > 50 ? text.substring(0, 50) + '...' : text;
    }
    return '新对话';
  }

  // ==================== DOM 监听逻辑 ====================

  /**
   * 设置 DOM 变化监听
   */
  protected setupMutationObserver(): MutationObserver {
    console.log('[Adapter] 设置内容观察器');

    this.updateCurrentMessagesMap();

    const observer = new MutationObserver((mutations) => {
      if (!this.settings.autoSave) {
        return;
      }

      let hasRelevantChanges = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // 检查新增的节点
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && this.isMessageElement(node)) {
              hasRelevantChanges = true;
              break;
            }
          }

          // 检查删除的节点
          if (!hasRelevantChanges) {
            for (const node of mutation.removedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE && this.isMessageElement(node)) {
                hasRelevantChanges = true;
                break;
              }
            }
          }
        } else if (mutation.type === 'characterData') {
          let targetNode = mutation.target as Node;
          while (targetNode && targetNode !== document.body) {
            if (this.isMessageElement(targetNode)) {
              hasRelevantChanges = true;
              break;
            }
            targetNode = targetNode.parentNode!;
          }
        }

        if (hasRelevantChanges) break;
      }

      if (hasRelevantChanges) {
        if (this.debounceTimer) {
          window.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
          this.checkForActualMessageChanges();
        }, this.DEBOUNCE_DELAY);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
    });

    return observer;
  }

  /**
   * 更新当前消息映射
   */
  protected updateCurrentMessagesMap(): Message[] {
    const messages = this.extractMessages();
    const newMap = new Map<string, string>();

    messages.forEach((message) => {
      newMap.set(message.messageId, message.content);
    });

    this.currentMessagesMap = newMap;
    return messages;
  }

  /**
   * 检查当前所有消息与上次比较，判断是否有变化
   */
  protected async checkForActualMessageChanges(): Promise<void> {
    if (!this.settings.autoSave) {
      return;
    }

    const currentUrl = window.location.href;
    if (!this.isValidConversationUrl(currentUrl)) {
      console.log('[Adapter] 当前 URL 不是有效的对话页面，跳过保存');
      return;
    }

    if (!this.currentConversationId) {
      return;
    }

    console.log('[Adapter] 检查消息实际变化...');

    const currentMessages = this.extractMessages();

    if (currentMessages.length === 0) {
      return;
    }

    const messagesForComparison = currentMessages.map((msg) => {
      const { timestamp, createdAt, updatedAt, ...rest } = msg;
      return rest;
    });
    const currentMessagesJson = JSON.stringify(messagesForComparison);

    if (this.lastMessagesJson === currentMessagesJson) {
      console.log('[Adapter] 消息内容无变化，跳过保存');
      return;
    }

    this.lastMessagesJson = currentMessagesJson;
    console.log('[Adapter] 检测到消息变化，触发保存');

    this.updateCurrentMessagesMap();
    await this.checkForNewMessages();
  }

  /**
   * 检查新消息
   */
  protected async checkForNewMessages(): Promise<void> {
    if (this.isChecking) return;

    if (!this.settings.autoSave) {
      return;
    }

    if (!this.currentConversationId) {
      try {
        this.isChecking = true;
        console.log('[Adapter] 自动保存模式，首次创建对话');
        const convId = await this.findOrCreateConversation();
        this.currentConversationId = convId;
      } catch (error) {
        console.error('[Adapter] 创建对话失败:', error);
      } finally {
        this.isChecking = false;
      }
      return;
    }

    this.isChecking = true;

    try {
      await this.saveAllMessages();
    } catch (error) {
      console.error('[Adapter] 检查新消息失败:', error);
    } finally {
      this.isChecking = false;
    }
  }

  // ==================== 保存逻辑 ====================

  /**
   * 处理手动保存按钮点击事件
   */
  protected async handleManualSave(): Promise<void> {
    console.log('[Adapter] 手动保存按钮被点击');

    const currentUrl = window.location.href;
    if (!this.isValidConversationUrl(currentUrl)) {
      console.log(`[Adapter] 当前页面不是有效的 ${this.platform} 对话页面，无法保存`);
      return;
    }

    try {
      const { conversationId, isNewConversation } = this.extractConversationInfo(currentUrl);

      if (conversationId) {
        this.lastKnownConversationId = conversationId;
      }

      await this.connectToDatabase();

      const foundConversationId = await this.findOrCreateConversation();

      if (!foundConversationId) {
        console.log('[Adapter] 手动保存 - 无法找到或创建对话');
        return;
      }

      this.currentConversationId = foundConversationId;
      console.log('[Adapter] 手动保存 - 当前对话 ID:', this.currentConversationId);

      await this.saveAllMessages();

      console.log('[Adapter] 手动保存完成');
    } catch (error) {
      console.error('[Adapter] 手动保存失败:', error);

      // 触发保存失败事件
      eventBus.publish('message:failed', { error: String(error) });
    }
  }

  /**
   * 保存所有消息
   */
  protected async saveAllMessages(): Promise<void> {
    try {
      if (!this.currentConversationId) {
        console.log('[Adapter] 未找到对话 ID，无法保存');
        return;
      }

      const attemptSave = async (retryCount: number = 0): Promise<void> => {
        const messages = this.extractMessages();
        console.log(`[Adapter] 提取到消息数量: ${messages.length}`);

        if (messages.length === 0 && retryCount < 2) {
          console.log(
            `[Adapter] 保存时暂无消息，${500 * (retryCount + 1)}ms 后重试 (${
              retryCount + 1
            }/2)`
          );
          await new Promise<void>((resolve) =>
            setTimeout(resolve, 500 * (retryCount + 1))
          );
          return attemptSave(retryCount + 1);
        }

        if (messages.length === 0) {
          console.log('[Adapter] 没有消息内容，跳过保存');
          return;
        }

        await this.performIncrementalSave(messages);
      };

      await attemptSave();
    } catch (error) {
      console.error('[Adapter] 保存消息失败:', error);
    }
  }

  /**
   * 执行增量保存
   */
  protected async performIncrementalSave(messages: Message[]): Promise<void> {
    console.log('[Adapter] 执行增量保存');

    const response = await chromeMessageAdapter.sendMessage({
      type: 'updateConversation',
      conversation: {
        conversationId: this.currentConversationId!,
        messages,
        updatedAt: new Date().toISOString(),
      } as Partial<Conversation>,
    });

    if (response?.status === 'ok') {
      console.log('[Adapter] 消息保存成功');
      eventBus.publish('message:saved', { messageId: this.currentConversationId });
    } else {
      throw new Error('消息保存失败');
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 生成消息唯一 ID
   */
  protected generateMessageId(sender: string, index: number): string {
    return `msg_${sender}_position_${index}`;
  }

  /**
   * 提取格式化内容的所有可见文本
   */
  protected extractFormattedContent(element: Element | null): string {
    if (!element) return '';

    const text = element.innerText || element.textContent || '';
    return text.trim().replace(/\n\s*\n\s*\n/g, '\n\n');
  }

  /**
   * 检查是否处于编辑状态
   */
  protected isInEditMode(element: Element): boolean {
    if (!element) return false;
    const activeTextarea = element.querySelector('textarea:focus');
    return !!activeTextarea;
  }

  // ==================== URL 监控逻辑 ====================

  /**
   * 启动 URL 监控
   */
  protected startUrlWatcher(): void {
    console.log('[Adapter] URL �望望员启动');

    if (this.urlCheckInterval) {
      window.clearInterval(this.urlCheckInterval);
    }

    this.handleUrlCheck();
    this.urlCheckInterval = window.setInterval(() => this.handleUrlCheck(), 1000);
  }

  /**
   * 检查 URL 变化并广播事件
   */
  protected handleUrlCheck(): void {
    const currentUrl = window.location.href;
    const currentBaseUrl = currentUrl.split('?')[0];

    if (!this.isValidConversationUrl(currentUrl)) {
      return;
    }

    const { conversationId, isNewConversation } = this.extractConversationInfo(currentUrl);

    if (!conversationId) {
      return;
    }

    if (currentBaseUrl !== this.lastKnownUrl || conversationId !== this.lastKnownConversationId) {
      console.log(`[Adapter] 检测到变化 - 新 URL: ${currentBaseUrl}`);
      console.log(
        `[Adapter] 对话 ID 变化: ${this.lastKnownConversationId || '无'} -> ${
          conversationId || '无'
        }`
      );

      this.lastKnownUrl = currentBaseUrl;
      this.lastKnownConversationId = conversationId;

      // 广播 URL 变化事件
      window.dispatchEvent(
        new CustomEvent(URL_CHANGED_EVENT, {
          detail: {
            url: currentUrl,
            conversationId,
            isNewConversation,
          },
        })
      );
    }
  }

  // ==================== 事件监听设置 ====================

  /**
   * 设置事件监听器
   */
  protected setupEventListeners(): void {
    // 手动保存监听器
    window.addEventListener(MANUAL_SAVE_EVENT, this.handleManualSave.bind(this));

    // URL 变化监听器
    window.addEventListener(URL_CHANGED_EVENT, (event) => {
      console.log('[Adapter] 监听器收到 URL 变化事件');

      const { url, conversationId, isNewConversation } = (event as CustomEvent).detail;

      if (url && this.isValidConversationUrl(url) && conversationId) {
        setTimeout(() => {
          this.initAdapter({
            url,
            conversationId,
            isNewConversation,
          });
        }, 100);
      }
    });
  }

  /**
   * 设置页面卸载检测
   */
  protected setupPageUnloadDetection(): void {
    let isUnloading = false;
    window.addEventListener('beforeunload', () => {
      isUnloading = true;
    });
  }

  // ==================== 启动逻辑 ====================

  /**
   * 初始启动
   */
  protected initialBoot(): void {
    if (this.settings) {
      this.startUrlWatcher();
    } else {
      setTimeout(() => this.initialBoot(), 100);
    }
  }

  /**
   * 启动适配器
   */
  start(): void {
    this.init();
    this.setupEventListeners();
    this.setupPageUnloadDetection();
    this.initialBoot();
  }
}
