import type { PageTranslationItem, PageTranslationRequest } from './service';
import type { TranslationMode, TranslationRange } from './config';

const TRANSLATION_ID_ATTR = 'data-sayso-translation-id';
const ORIGINAL_DISPLAY_ATTR = 'data-sayso-original-display';
const TRANSLATION_BLOCK_CLASS = 'sayso-translation-block';

const PAGE_TEXT_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'dt',
  'dd',
  'blockquote',
  'figcaption',
  'td',
  'th',
].join(',');

const FALLBACK_TEXT_BLOCK_SELECTOR = [
  'div',
  'section',
].join(',');

const MIN_FALLBACK_TEXT_LENGTH = 20;

const MAIN_CONTENT_ROOT_SELECTOR = [
  'article',
  'main',
  '[role="main"]',
  '[data-layout*="docs" i]',
  '[data-page*="docs" i]',
  '[class*="docs-page" i]',
  '[class*="doc-content" i]',
  '[class*="markdown" i]',
  '[class*="prose" i]',
].join(',');

const EXCLUDED_TEXT_CONTAINER_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'input',
  'select',
  'button',
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="tablist"]',
  '[contenteditable="true"]',
  `.${TRANSLATION_BLOCK_CLASS}`,
].join(',');

export interface CollectPageTranslationOptions {
  sourceLanguage: 'auto' | string;
  targetLanguage: string;
  mode: TranslationMode;
  range: TranslationRange;
  root?: Document;
}

export interface RenderPageTranslationsOptions {
  mode: TranslationMode;
  translations: PageTranslationItem[];
  root?: Document;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isElementHidden(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) {
    return true;
  }

  const htmlElement = element as HTMLElement;
  const inlineDisplay = htmlElement.style?.display;
  const inlineVisibility = htmlElement.style?.visibility;
  if (inlineDisplay === 'none' || inlineVisibility === 'hidden') {
    return true;
  }

  const view = element.ownerDocument.defaultView;
  if (view?.getComputedStyle) {
    const style = view.getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  return false;
}

function isTranslatableElement(element: Element): element is HTMLElement {
  if (element.closest(EXCLUDED_TEXT_CONTAINER_SELECTOR)) {
    return false;
  }

  if (isElementHidden(element)) {
    return false;
  }

  return normalizeText(element.textContent ?? '').length >= 2;
}

function getPageTranslationRoots(root: Document, range: TranslationRange): HTMLElement[] {
  if (range === 'fullPage' || range === 'all') {
    return [root.body].filter(Boolean) as HTMLElement[];
  }

  const roots = Array.from(root.querySelectorAll<HTMLElement>(MAIN_CONTENT_ROOT_SELECTOR)).filter(
    (element) => !element.closest(EXCLUDED_TEXT_CONTAINER_SELECTOR) && !isElementHidden(element)
  );

  return roots.length > 0 ? roots : ([root.body].filter(Boolean) as HTMLElement[]);
}

function getElementDepth(element: Element): number {
  let depth = 0;
  let current = element.parentElement;
  while (current) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function hasCollectedDescendant(element: HTMLElement, collected: Set<HTMLElement>): boolean {
  for (const child of collected) {
    if (child !== element && element.contains(child)) {
      return true;
    }
  }
  return false;
}

function collectSemanticTextElements(translationRoot: HTMLElement, seen: Set<HTMLElement>): HTMLElement[] {
  const elements: HTMLElement[] = [];
  translationRoot.querySelectorAll<HTMLElement>(PAGE_TEXT_SELECTOR).forEach((element) => {
    if (seen.has(element) || !isTranslatableElement(element)) {
      return;
    }
    seen.add(element);
    elements.push(element);
  });
  return elements;
}

function collectFallbackTextBlocks(
  translationRoot: HTMLElement,
  seen: Set<HTMLElement>
): HTMLElement[] {
  const candidates = Array.from(
    translationRoot.querySelectorAll<HTMLElement>(FALLBACK_TEXT_BLOCK_SELECTOR)
  )
    .filter((element) => {
      if (seen.has(element) || !isTranslatableElement(element)) {
        return false;
      }
      if (hasCollectedDescendant(element, seen)) {
        return false;
      }
      return normalizeText(element.textContent ?? '').length >= MIN_FALLBACK_TEXT_LENGTH;
    })
    .sort((a, b) => getElementDepth(b) - getElementDepth(a));

  const elements: HTMLElement[] = [];
  candidates.forEach((element) => {
    if (seen.has(element) || hasCollectedDescendant(element, seen)) {
      return;
    }
    seen.add(element);
    elements.push(element);
  });

  return elements.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
}

function collectTextElements(root: Document, range: TranslationRange): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const elements: HTMLElement[] = [];

  getPageTranslationRoots(root, range).forEach((translationRoot) => {
    elements.push(...collectSemanticTextElements(translationRoot, seen));
    elements.push(...collectFallbackTextBlocks(translationRoot, seen));
  });

  return elements;
}

function findTranslationTarget(root: Document, id: string): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(`[${TRANSLATION_ID_ATTR}]`);
  for (const candidate of candidates) {
    if (candidate.getAttribute(TRANSLATION_ID_ATTR) === id) {
      return candidate;
    }
  }
  return null;
}

function getOrCreateTranslationId(element: HTMLElement, nextId: () => string): string {
  const existingId = element.getAttribute(TRANSLATION_ID_ATTR);
  if (existingId) {
    return existingId;
  }

  const id = nextId();
  element.setAttribute(TRANSLATION_ID_ATTR, id);
  return id;
}

function collectPageContext(root: Document, items: PageTranslationItem[]): string {
  const headingText = Array.from(root.querySelectorAll<HTMLElement>('h1, h2'))
    .map((element) => normalizeText(element.textContent ?? ''))
    .filter(Boolean)
    .slice(0, 6);
  const sampleText = items
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 8);

  return [...headingText, ...sampleText].join('\n').slice(0, 4000);
}

export function collectPageTranslationRequest(
  options: CollectPageTranslationOptions
): PageTranslationRequest {
  const root = options.root ?? document;
  let counter = 0;
  const nextId = (): string => `sayso-t-${++counter}`;

  const items = collectTextElements(root, options.range).map((element) => ({
      id: getOrCreateTranslationId(element, nextId),
      text: normalizeText(element.textContent ?? ''),
    }));

  return {
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    pageTitle: root.title || '',
    pageUrl: root.location?.href || '',
    contextText: collectPageContext(root, items),
    items,
  };
}

function createTranslationBlock(root: Document, id: string, text: string): HTMLElement {
  const block = root.createElement('div');
  block.className = TRANSLATION_BLOCK_CLASS;
  block.setAttribute('data-sayso-translation-for', id);
  block.textContent = text;
  block.style.cssText = [
    'margin: 4px 0 10px',
    'padding: 6px 8px',
    'border-left: 3px solid #5e6ad2',
    'background: rgba(94, 106, 210, 0.08)',
    'color: #374151',
    'font-size: 0.95em',
    'line-height: 1.5',
  ].join('; ');
  return block;
}

function removeExistingTranslationAfter(target: HTMLElement, id: string): void {
  const next = target.nextElementSibling as HTMLElement | null;
  if (
    next?.classList.contains(TRANSLATION_BLOCK_CLASS) &&
    next.getAttribute('data-sayso-translation-for') === id
  ) {
    next.remove();
  }
}

export function renderPageTranslations(options: RenderPageTranslationsOptions): void {
  const root = options.root ?? document;

  options.translations.forEach((translation) => {
    const target = findTranslationTarget(root, translation.id);
    if (!target) {
      return;
    }

    removeExistingTranslationAfter(target, translation.id);

    if (options.mode === 'translationOnly') {
      target.setAttribute(ORIGINAL_DISPLAY_ATTR, target.style.display);
      target.style.display = 'none';
    }

    const block = createTranslationBlock(root, translation.id, translation.text);
    target.insertAdjacentElement('afterend', block);
  });
}

export interface BatchedTranslationOptions {
  items: PageTranslationItem[];
  batchSize: number;
  concurrency: number;
  /** Translate one batch; should reject/throw on failure. */
  translateBatch: (items: PageTranslationItem[]) => Promise<PageTranslationItem[]>;
  /** Called for each completed batch so its translations can be rendered immediately. */
  onBatch: (translations: PageTranslationItem[]) => void;
}

export interface BatchedTranslationResult {
  translatedCount: number;
  firstError?: string;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, size);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    batches.push(items.slice(i, i + safeSize));
  }
  return batches;
}

/**
 * 将整页文本切成多个小批次并发翻译，每批返回即回调渲染，
 * 让译文逐段出现而不是等整页一次性返回，体感更快。
 */
export async function runBatchedTranslation(
  options: BatchedTranslationOptions
): Promise<BatchedTranslationResult> {
  const batches = chunkItems(options.items, options.batchSize);
  let translatedCount = 0;
  let firstError: string | undefined;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      try {
        const translations = await options.translateBatch(batch);
        options.onBatch(translations);
        translatedCount += translations.length;
      } catch (error) {
        if (firstError === undefined) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency, batches.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { translatedCount, ...(firstError !== undefined ? { firstError } : {}) };
}

export function clearPageTranslations(root: Document = document): void {
  root.querySelectorAll(`.${TRANSLATION_BLOCK_CLASS}`).forEach((element) => element.remove());
  root.querySelectorAll<HTMLElement>(`[${TRANSLATION_ID_ATTR}]`).forEach((element) => {
    if (element.hasAttribute(ORIGINAL_DISPLAY_ATTR)) {
      element.style.display = element.getAttribute(ORIGINAL_DISPLAY_ATTR) ?? '';
      element.removeAttribute(ORIGINAL_DISPLAY_ATTR);
    }
    element.removeAttribute(TRANSLATION_ID_ATTR);
  });
}
