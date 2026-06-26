/**
 * Chrome 消息通信适配器
 * 提供 Chrome Runtime Message API 的类型安全封装
 */

import type { ChromeMessageType, ChromeMessageRequest, ChromeMessageResponse } from '@/types';

/**
 * Message callback type for onMessage
 */
type MessageCallback<T> = (message: ChromeMessageRequest<T>, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void;

function getRuntimeLastErrorSafe(): unknown | null {
  try {
    return chrome.runtime.lastError || null;
  } catch (error) {
    return error;
  }
}

export function isRuntimeContextAvailable(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch (error) {
    return false;
  }
}

const CONTEXT_INVALIDATED_LOG_SAMPLE_MS = 60_000;
const contextInvalidatedLastLoggedAt = new Map<string, number>();

function shouldLogContextInvalidated(level: 'message' | 'tab message' | 'broadcast', type: unknown): boolean {
  const key = `${level}:${String(type ?? '__unknown__')}`;
  const now = Date.now();
  const lastLoggedAt = contextInvalidatedLastLoggedAt.get(key);

  if (lastLoggedAt === undefined || now - lastLoggedAt >= CONTEXT_INVALIDATED_LOG_SAMPLE_MS) {
    contextInvalidatedLastLoggedAt.set(key, now);
    return true;
  }

  return false;
}

function toRuntimeErrorMessage(rawError: unknown): string {
  if (typeof rawError === 'string') {
    return rawError;
  }

  if (rawError && typeof rawError === 'object') {
    const maybeMessage = (rawError as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }

    try {
      return JSON.stringify(rawError);
    } catch {
      return String(rawError);
    }
  }

  return String(rawError);
}

function normalizeRuntimeError(rawError: unknown): Error {
  if (rawError instanceof Error) {
    return rawError;
  }

  const message = toRuntimeErrorMessage(rawError);
  return new Error(message || 'Unknown Chrome runtime error');
}

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = toRuntimeErrorMessage(error).toLowerCase();
  return (
    message.includes('extension context invalidated') ||
    message.includes('could not establish connection') ||
    message.includes('receiving end does not exist') ||
    message.includes('message channel closed before a response was received')
  );
}

function logMessageFailure(level: 'message' | 'tab message' | 'broadcast', type: unknown, error: unknown): void {
  const message = toRuntimeErrorMessage(error);
  if (isExtensionContextInvalidatedError(error)) {
    if (shouldLogContextInvalidated(level, type)) {
      console.debug(`[ChromeMessageAdapter] ${level} failed:`, type, message);
    }
    return;
  }
  console.error(`[ChromeMessageAdapter] ${level} failed:`, type, message);
}

// ============================================================================
// ChromeMessageAdapter 类
// ============================================================================

/**
 * Chrome 消息适配器
 * 封装 Chrome Runtime Message API
 */
class ChromeMessageAdapter {
  private static instance: ChromeMessageAdapter | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * 获取 ChromeMessageAdapter 单例
   */
  static getInstance(): ChromeMessageAdapter {
    if (!ChromeMessageAdapter.instance) {
      ChromeMessageAdapter.instance = new ChromeMessageAdapter();
    }
    return ChromeMessageAdapter.instance;
  }

  /**
   * 发送消息并等待响应
   * @param message - 消息对象
   * @returns Promise 响应
   */
  async sendMessage<T = any, R = any>(
    message: ChromeMessageRequest<T>
  ): Promise<ChromeMessageResponse<R>> {
    return new Promise((resolve, reject) => {
      if (!isRuntimeContextAvailable()) {
        const error = new Error('Extension context invalidated.');
        logMessageFailure('message', message.type, error);
        reject(error);
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const rawLastError = getRuntimeLastErrorSafe();
            if (rawLastError) {
              const error = normalizeRuntimeError(rawLastError);
              logMessageFailure('message', message.type, error);
              reject(error);
              return;
            }
            resolve(response as ChromeMessageResponse<R>);
          } catch (callbackError) {
            const runtimeError = normalizeRuntimeError(callbackError);
            logMessageFailure('message', message.type, runtimeError);
            reject(runtimeError);
          }
        });
      } catch (error) {
        const runtimeError = normalizeRuntimeError(error);
        logMessageFailure('message', message.type, runtimeError);
        reject(runtimeError);
      }
    });
  }

  /**
   * 发送消息（不等待响应）
   * @param message - 消息对象
   */
  send(message: ChromeMessageRequest): void {
    if (!isRuntimeContextAvailable()) {
      logMessageFailure('message', message.type, new Error('Extension context invalidated.'));
      return;
    }

    try {
      chrome.runtime.sendMessage(message, () => {
        const rawLastError = getRuntimeLastErrorSafe();
        if (rawLastError) {
          logMessageFailure('message', message.type, rawLastError);
        }
      });
    } catch (error) {
      logMessageFailure('message', message.type, error);
    }
  }

  /**
   * 监听消息
   * @param messageType - 消息类型
   * @param callback - 回调函数
   * @returns 取消监听的函数
   */
  onMessage<T = any>(messageType: ChromeMessageType, callback: MessageCallback<T>): () => void {
    if (!isRuntimeContextAvailable()) {
      logMessageFailure('message', messageType, new Error('Extension context invalidated.'));
      return () => undefined;
    }

    const listener = (
      message: ChromeMessageRequest<T>,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void
    ) => {
      if (message.type === messageType) {
        callback(message, sender, sendResponse);
      }
    };

    try {
      chrome.runtime.onMessage.addListener(listener);
    } catch (error) {
      logMessageFailure('message', messageType, error);
      return () => undefined;
    }

    // 返回取消监听的函数
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(listener);
      } catch {
        // ignore
      }
    };
  }

  /**
   * 发送消息到指定的标签页
   * @param tabId - 标签页 ID
   * @param message - 消息对象
   * @returns Promise 响应
   */
  async sendMessageToTab<T = any, R = any>(
    tabId: number,
    message: ChromeMessageRequest<T>
  ): Promise<ChromeMessageResponse<R>> {
    return new Promise((resolve, reject) => {
      if (!isRuntimeContextAvailable()) {
        const error = new Error('Extension context invalidated.');
        logMessageFailure('tab message', message.type, error);
        reject(error);
        return;
      }

      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          try {
            const rawLastError = getRuntimeLastErrorSafe();
            if (rawLastError) {
              const error = normalizeRuntimeError(rawLastError);
              logMessageFailure('tab message', message.type, error);
              reject(error);
              return;
            }
            resolve(response as ChromeMessageResponse<R>);
          } catch (callbackError) {
            const runtimeError = normalizeRuntimeError(callbackError);
            logMessageFailure('tab message', message.type, runtimeError);
            reject(runtimeError);
          }
        });
      } catch (error) {
        const runtimeError = normalizeRuntimeError(error);
        logMessageFailure('tab message', message.type, runtimeError);
        reject(runtimeError);
      }
    });
  }

  /**
   * 广播消息到所有扩展视图
   * @param message - 消息对象
   */
  broadcast(message: ChromeMessageRequest): void {
    if (!isRuntimeContextAvailable()) {
      logMessageFailure('broadcast', message.type, new Error('Extension context invalidated.'));
      return;
    }

    try {
      chrome.runtime.sendMessage(message, () => {
        const rawLastError = getRuntimeLastErrorSafe();
        if (rawLastError) {
          logMessageFailure('broadcast', message.type, rawLastError);
        }
      });
    } catch (error) {
      logMessageFailure('broadcast', message.type, error);
    }
  }

  /**
   * 获取当前标签页
   */
  async getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
    return new Promise((resolve, reject) => {
      if (!isRuntimeContextAvailable()) {
        reject(new Error('Extension context invalidated.'));
        return;
      }

      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          try {
            const rawLastError = getRuntimeLastErrorSafe();
            if (rawLastError) {
              reject(normalizeRuntimeError(rawLastError));
              return;
            }
            resolve(tabs[0]);
          } catch (callbackError) {
            reject(normalizeRuntimeError(callbackError));
          }
        });
      } catch (error) {
        reject(normalizeRuntimeError(error));
      }
    });
  }

  /**
   * 获取所有标签页
   */
  async getAllTabs(): Promise<chrome.tabs.Tab[]> {
    return new Promise((resolve, reject) => {
      if (!isRuntimeContextAvailable()) {
        reject(new Error('Extension context invalidated.'));
        return;
      }

      try {
        chrome.tabs.query({}, (tabs) => {
          try {
            const rawLastError = getRuntimeLastErrorSafe();
            if (rawLastError) {
              reject(normalizeRuntimeError(rawLastError));
              return;
            }
            resolve(tabs);
          } catch (callbackError) {
            reject(normalizeRuntimeError(callbackError));
          }
        });
      } catch (error) {
        reject(normalizeRuntimeError(error));
      }
    });
  }

  /**
   * 打开标签页
   */
  async createTab(options: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    return new Promise((resolve, reject) => {
      if (!isRuntimeContextAvailable()) {
        reject(new Error('Extension context invalidated.'));
        return;
      }

      try {
        chrome.tabs.create(options, (tab) => {
          try {
            const rawLastError = getRuntimeLastErrorSafe();
            if (rawLastError) {
              reject(normalizeRuntimeError(rawLastError));
              return;
            }
            resolve(tab);
          } catch (callbackError) {
            reject(normalizeRuntimeError(callbackError));
          }
        });
      } catch (error) {
        reject(normalizeRuntimeError(error));
      }
    });
  }

  /**
   * 获取扩展信息
   */
  getExtensionInfo(): chrome.runtime.Manifest {
    try {
      return chrome.runtime.getManifest();
    } catch {
      return { manifest_version: 3, name: '', version: '' } as chrome.runtime.Manifest;
    }
  }

  /**
   * 获取扩展 ID
   */
  getExtensionId(): string {
    try {
      return chrome.runtime.id || '';
    } catch {
      return '';
    }
  }

  /**
   * 获取扩展 URL
   */
  getExtensionURL(path: string): string {
    try {
      return chrome.runtime.getURL(path);
    } catch {
      return '';
    }
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const chromeMessageAdapter = ChromeMessageAdapter.getInstance();

export { ChromeMessageAdapter };
