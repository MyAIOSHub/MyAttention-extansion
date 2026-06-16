/**
 * 同声传译：在页面主视频上叠加字幕（原文小字在上、译文大字在下）。
 * popup 通过 simulcast:subtitle 下发当前句；仅顶层页面渲染。
 * 定位锚到主视频底部居中，随滚动/全屏/缩放跟随。
 */
import { findMainVideo } from './simulcast-video-sync';

let overlay: HTMLDivElement | null = null;
let srcRow: HTMLDivElement | null = null;
let trRow: HTMLDivElement | null = null;
let followTimer: number | null = null;
let listenersBound = false;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  const box = document.createElement('div');
  box.id = '__ma_simulcast_subtitle__';
  box.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'pointer-events:none',
    'left:50%',
    'transform:translateX(-50%)',
    'bottom:12%',
    'max-width:84vw',
    'text-align:center',
    'display:none',
  ].join(';');

  const src = document.createElement('div');
  src.style.cssText =
    'font-size:17px;line-height:1.3;color:#e5e7eb;text-shadow:0 2px 6px rgba(0,0,0,.9);' +
    'background:rgba(0,0,0,.5);padding:1px 9px;border-radius:6px;width:fit-content;max-width:100%;margin:0 auto 4px;';
  const tr = document.createElement('div');
  tr.style.cssText =
    'font-size:25px;line-height:1.35;color:#fff;font-weight:600;text-shadow:0 2px 6px rgba(0,0,0,.95);' +
    'background:rgba(0,0,0,.58);padding:2px 11px;border-radius:7px;width:fit-content;max-width:100%;margin:0 auto;';

  box.appendChild(src);
  box.appendChild(tr);
  document.body.appendChild(box);
  overlay = box;
  srcRow = src;
  trRow = tr;

  if (!listenersBound) {
    listenersBound = true;
    const onChange = (): void => reposition();
    window.addEventListener('resize', onChange, true);
    window.addEventListener('scroll', onChange, true);
    document.addEventListener('fullscreenchange', onChange, true);
  }
  return box;
}

/** 锚到主视频底部居中。 */
function reposition(): void {
  if (!overlay || overlay.style.display === 'none') return;
  const v = findMainVideo();
  if (!v) return;
  const r = v.getBoundingClientRect();
  overlay.style.left = `${r.left + r.width / 2}px`;
  overlay.style.bottom = `${Math.max(8, window.innerHeight - r.bottom + r.height * 0.08)}px`;
}

function startFollow(): void {
  if (followTimer !== null) return;
  followTimer = window.setInterval(reposition, 400);
}

function stopFollow(): void {
  if (followTimer !== null) {
    window.clearInterval(followTimer);
    followTimer = null;
  }
}

function hideOverlay(): void {
  stopFollow();
  if (overlay) overlay.style.display = 'none';
}

function setSubtitle(source: string, translation: string, mode: string): void {
  if (mode === 'off') {
    hideOverlay();
    return;
  }
  const src = (source || '').trim();
  const tr = (translation || '').trim();
  if (!src && !tr) {
    hideOverlay();
    return;
  }
  const box = ensureOverlay();
  const showSrc = mode === 'bilingual' && !!src;
  if (srcRow) {
    srcRow.style.display = showSrc ? 'block' : 'none';
    srcRow.textContent = src;
  }
  if (trRow) {
    trRow.style.display = tr ? 'block' : 'none';
    trRow.textContent = tr;
  }
  box.style.display = 'block';
  reposition();
  startFollow();
}

/** 注册 simulcast:subtitle 监听（仅顶层页面调用）。 */
export function initSimulcastSubtitleOverlayListener(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'simulcast:subtitle') {
      return undefined;
    }
    if (message.clear) {
      hideOverlay();
    } else {
      setSubtitle(message.source ?? '', message.translation ?? '', message.mode ?? 'bilingual');
    }
    sendResponse({ status: 'ok' });
    return true;
  });
}
