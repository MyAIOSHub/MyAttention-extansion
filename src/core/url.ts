/**
 * 去掉 URL 的查询串(?)与片段(#)，返回纯净路径。
 * 供消息路由 / 数据库索引 / 右键菜单等共用，统一空值与分隔处理。
 */
export function cleanUrl(url: unknown): string {
  return String(url || '').split(/[?#]/)[0];
}
