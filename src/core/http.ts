/**
 * HTTP 工具：带超时的 fetch + 错误信息规范化。
 * 供 exa-client / evermemos-client / local-store-client 等 API client 共用，
 * 消除各自重复的 AbortController/超时样板与 error 规范化逻辑。
 */

/** fetchWithTimeout 超时专用错误，便于调用方区分超时与普通网络错误 */
export class FetchTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * 带超时的 fetch：超时触发 AbortController 并抛出 {@link FetchTimeoutError}，
 * 其余网络错误原样抛出；无论成败都清理定时器。
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将任意 error 规范化为可读字符串：
 * string 原样 → object.message → （可选）object.detail → JSON.stringify → String()。
 */
export function normalizeErrorMessage(
  error: unknown,
  options: { includeDetail?: boolean } = {},
): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
    if (options.includeDetail) {
      const detail = (error as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.trim().length > 0) {
        return detail;
      }
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
