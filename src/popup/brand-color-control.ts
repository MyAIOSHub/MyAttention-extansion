/**
 * 设置页「外观 · 自定义主题色」控件。
 * 参考 say-so-desktop 的 BrandColorPicker：预设色板 + 自定义取色 + hex 输入 + 恢复默认。
 * 选中即时应用到 :root，并通过 updateSettings 持久化到 chrome.storage.sync。
 */

import {
  applyBrandColor,
  normalizeHex,
  isDefaultBrandColor,
  DEFAULT_BRAND_COLOR,
  BRAND_PRESETS,
} from './theme-color';
import { safeSendRuntimeMessage } from './chrome-safe';
import { Logger } from '@/core/errors';

interface BrandColorEls {
  presets: HTMLElement | null;
  colorInput: HTMLInputElement | null;
  hexInput: HTMLInputElement | null;
  resetBtn: HTMLButtonElement | null;
}

let els: BrandColorEls | null = null;
/** 当前值：'' 表示默认主色 */
let currentColor = '';

function persist(brandColor: string): void {
  void safeSendRuntimeMessage({ type: 'updateSettings', settings: { brandColor } }).catch(
    (error) => Logger.warn('[Popup] 保存主题色失败', error),
  );
}

/** 当前生效的展示 hex（默认时回落到默认主色） */
function effectiveHex(): string {
  return isDefaultBrandColor(currentColor)
    ? DEFAULT_BRAND_COLOR
    : (normalizeHex(currentColor) as string);
}

function renderState(): void {
  if (!els) return;
  const hex = effectiveHex();
  if (els.colorInput) els.colorInput.value = hex;
  if (els.hexInput) els.hexInput.value = hex;
  els.presets
    ?.querySelectorAll<HTMLElement>('[data-color]')
    .forEach((btn) => {
      const on = normalizeHex(btn.dataset.color ?? '') === hex;
      btn.classList.toggle('brand-swatch-active', on);
    });
}

/** 设定颜色并应用；选默认色统一存为 '' 以便跟随未来默认 */
function setColor(value: string, options: { persist?: boolean } = {}): void {
  const norm = normalizeHex(value);
  currentColor = !norm || norm === DEFAULT_BRAND_COLOR ? '' : norm;
  applyBrandColor(currentColor);
  renderState();
  if (options.persist !== false) persist(currentColor);
}

function renderPresets(): void {
  if (!els?.presets) return;
  els.presets.innerHTML = BRAND_PRESETS.map(
    (c) =>
      `<button type="button" class="brand-swatch" data-color="${c}" style="background-color:${c}" title="${c}" aria-label="${c}"></button>`,
  ).join('');
}

/** 初始化控件（绑定一次）。无相关 DOM 时安全跳过。 */
export function initBrandColorControl(): void {
  els = {
    presets: document.getElementById('brand-color-presets'),
    colorInput: document.getElementById('brand-color-input') as HTMLInputElement | null,
    hexInput: document.getElementById('brand-color-hex') as HTMLInputElement | null,
    resetBtn: document.getElementById('brand-color-reset') as HTMLButtonElement | null,
  };
  if (!els.presets && !els.colorInput && !els.hexInput) return;

  renderPresets();

  els.presets?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-color]');
    if (btn?.dataset.color) setColor(btn.dataset.color);
  });

  // 拖动取色器时实时预览，松开（change）才落库，避免刷消息
  els.colorInput?.addEventListener('input', (event) => {
    setColor((event.target as HTMLInputElement).value, { persist: false });
  });
  els.colorInput?.addEventListener('change', () => persist(currentColor));

  const commitHex = (): void => {
    if (!els?.hexInput) return;
    const norm = normalizeHex(els.hexInput.value);
    if (norm) setColor(norm);
    else renderState(); // 非法输入还原
  };
  els.hexInput?.addEventListener('blur', commitHex);
  els.hexInput?.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') commitHex();
  });

  els.resetBtn?.addEventListener('click', () => setColor(''));

  renderState();
}

/** 加载/外部更新设置时调用：应用并同步控件，不回写持久化。 */
export function syncBrandColor(brandColor: string | undefined): void {
  const norm = normalizeHex(brandColor ?? '');
  currentColor = isDefaultBrandColor(brandColor) || !norm ? '' : norm;
  applyBrandColor(currentColor);
  renderState();
}
