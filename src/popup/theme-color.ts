/**
 * 自定义主题色（参考 say-so-desktop 的 BrandColorPicker 实现）。
 *
 * 实现方式与 sayso 一致：以单个品牌色为来源，运行时写入根元素 CSS 变量，
 * 其余浅色/描边/阴影通过 color-mix 由 --primary-color 自动派生（见 popup.html）。
 * 这里只负责纯函数（校验/规范化/提亮）与把颜色应用到 :root。
 */

/** 扩展默认主色（Linear 靛蓝），与 popup.html :root --primary-color 一致 */
export const DEFAULT_BRAND_COLOR = '#5E6AD2';

/** 预设色板：默认色 + sayso 风格若干 */
export const BRAND_PRESETS: readonly string[] = [
  '#5E6AD2', // 默认
  '#2EDDA8', // sayso mint
  '#6D3BF5', // violet
  '#CB30E0',
  '#FF2D55',
  '#FF7043',
  '#F5B301',
  '#34C759',
  '#14B8A6',
  '#0EA5E9',
  '#EC4899',
  '#AC7F5E', // sayso tan
];

const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** 是否合法 hex（#RRGGBB 或 #RRGGBBAA） */
export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}

/**
 * 规范化为 #RRGGBB 大写（缺省补 #，丢弃 alpha）。非法返回 null。
 */
export function normalizeHex(value: string): string | null {
  let v = value.trim();
  if (v && !v.startsWith('#')) v = `#${v}`;
  if (!isValidHex(v)) return null;
  return `#${v.slice(1, 7).toUpperCase()}`;
}

/**
 * 将颜色向白色混合提亮 amount(0~1)，返回 #RRGGBB 大写。
 * 用于派生 hover 态（默认 0.12 ≈ #5E6AD2 → 浅一档）。
 */
export function lightenHex(value: string, amount: number): string {
  const hex = normalizeHex(value);
  if (!hex) return value;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = Math.min(1, Math.max(0, amount));
  const mix = (ch: number): number => Math.round(ch + (255 - ch) * clamp);
  const to2 = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`.toUpperCase();
}

/** 是否为默认主色（空 / 无效 / 等于默认都视为默认） */
export function isDefaultBrandColor(value: string | null | undefined): boolean {
  if (!value) return true;
  const hex = normalizeHex(value);
  return !hex || hex === DEFAULT_BRAND_COLOR;
}

/**
 * 应用主题色到 :root。默认色 → 移除覆盖（回落到 CSS 内置默认）；
 * 自定义色 → 写 --primary-color 与派生的 --primary-hover。
 * 其余 --primary-light / --primary-a* 由 color-mix 自动跟随。
 */
export function applyBrandColor(value: string | null | undefined): void {
  const root = document.documentElement;
  if (isDefaultBrandColor(value)) {
    root.style.removeProperty('--primary-color');
    root.style.removeProperty('--primary-hover');
    return;
  }
  const hex = normalizeHex(value as string) as string;
  root.style.setProperty('--primary-color', hex);
  root.style.setProperty('--primary-hover', lightenHex(hex, 0.12));
}
