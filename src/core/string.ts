/**
 * 非空字符串校验：非 string 或 trim 后为空 → null，否则返回 trim 后的值。
 * 用于从不可信入参中安全提取字符串（消息路由 / HTTP client 等）。
 */
export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
