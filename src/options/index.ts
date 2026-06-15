import type { AppSettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';

type ExperienceSettings = NonNullable<AppSettings['experience']>;
type ThemeMode = ExperienceSettings['theme'];
type LanguageMode = ExperienceSettings['language'];

interface CommandItem {
  id: string;
  label: string;
  keywords: string;
  run: () => void | Promise<void>;
}

let currentSettings: AppSettings = { ...DEFAULT_SETTINGS };
let commands: CommandItem[] = [];

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing options element: ${id}`);
  }
  return element as T;
}

function getExperience(settings: AppSettings): ExperienceSettings {
  return {
    ...DEFAULT_SETTINGS.experience!,
    ...(settings.experience ?? {}),
  };
}

function mergeSettings(settings?: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    experience: getExperience((settings ?? {}) as AppSettings),
    immersiveTranslation: {
      ...DEFAULT_SETTINGS.immersiveTranslation!,
      ...(settings?.immersiveTranslation ?? {}),
    },
    simultaneousInterpretation: {
      ...DEFAULT_SETTINGS.simultaneousInterpretation!,
      ...(settings?.simultaneousInterpretation ?? {}),
    },
  };
}

function getCheckedTheme(): ThemeMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="theme"]:checked');
  const value = checked?.value;
  return value === 'light' || value === 'dark' ? value : 'system';
}

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme !== 'system') {
    return theme;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

function setStatus(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const status = getElement<HTMLParagraphElement>('options-status');
  const className =
    kind === 'success'
      ? 'mt-4 text-sm text-green-700'
      : kind === 'error'
        ? 'mt-4 text-sm text-red-700'
        : 'mt-4 text-sm text-slate-600';
  status.textContent = message;
  status.className = className;
  status.classList.remove('hidden');
}

function readSettingsFromForm(): AppSettings {
  const language = getElement<HTMLSelectElement>('options-language').value;

  return {
    ...currentSettings,
    experience: {
      ...getExperience(currentSettings),
      theme: getCheckedTheme(),
      language: language === 'zh-CN' || language === 'en' ? language : 'system',
      betaExperienceEnabled: getElement<HTMLInputElement>('beta-experience-toggle').checked,
      commandPaletteEnabled: getElement<HTMLInputElement>('command-palette-toggle').checked,
      settingsSearchEnabled: getElement<HTMLInputElement>('settings-search-toggle').checked,
    },
  };
}

function loadSettingsFromStorage(): Promise<AppSettings> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(['settings'], (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(mergeSettings(result.settings as Partial<AppSettings> | undefined));
    });
  });
}

function saveSettingsToStorage(settings: AppSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ settings }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

function renderSettings(settings: AppSettings): void {
  const experience = getExperience(settings);
  document
    .querySelectorAll<HTMLInputElement>('input[name="theme"]')
    .forEach((input) => {
      input.checked = input.value === experience.theme;
    });
  getElement<HTMLSelectElement>('options-language').value = experience.language;
  getElement<HTMLInputElement>('beta-experience-toggle').checked =
    experience.betaExperienceEnabled;
  getElement<HTMLInputElement>('command-palette-toggle').checked =
    experience.commandPaletteEnabled;
  getElement<HTMLInputElement>('settings-search-toggle').checked =
    experience.settingsSearchEnabled;
  applyTheme(experience.theme);
}

async function saveCurrentSettings(): Promise<void> {
  currentSettings = readSettingsFromForm();
  await saveSettingsToStorage(currentSettings);
  applyTheme(getExperience(currentSettings).theme);
  setStatus('设置已保存', 'success');
}

function filterSettings(query: string): void {
  const normalizedQuery = query.trim().toLowerCase();
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-setting-item]'));
  let visibleCount = 0;

  items.forEach((item) => {
    const haystack = `${item.textContent ?? ''} ${item.dataset.search ?? ''}`.toLowerCase();
    const visible = !normalizedQuery || haystack.includes(normalizedQuery);
    item.classList.toggle('setting-hidden', !visible);
    if (visible) {
      visibleCount += 1;
    }
  });

  getElement<HTMLParagraphElement>('settings-search-empty').classList.toggle(
    'hidden',
    visibleCount > 0
  );
}

function setThemeSelection(theme: ThemeMode): void {
  const target = document.querySelector<HTMLInputElement>(`input[name="theme"][value="${theme}"]`);
  if (target) {
    target.checked = true;
  }
  applyTheme(theme);
}

function setLanguageSelection(language: LanguageMode): void {
  getElement<HTMLSelectElement>('options-language').value = language;
}

function openCommandPalette(): void {
  const experience = getExperience(currentSettings);
  if (!experience.commandPaletteEnabled) {
    setStatus('Command palette 已关闭', 'info');
    return;
  }

  getElement<HTMLDivElement>('command-palette').classList.remove('hidden');
  const search = getElement<HTMLInputElement>('command-palette-search');
  search.value = '';
  renderCommandResults('');
  search.focus();
}

function closeCommandPalette(): void {
  getElement<HTMLDivElement>('command-palette').classList.add('hidden');
}

function renderCommandResults(query: string): void {
  const normalizedQuery = query.trim().toLowerCase();
  const resultRoot = getElement<HTMLDivElement>('command-palette-results');
  const matches = commands.filter((command) => {
    const haystack = `${command.label} ${command.keywords}`.toLowerCase();
    return !normalizedQuery || haystack.includes(normalizedQuery);
  });

  resultRoot.innerHTML = matches
    .map(
      (command) => `
        <button
          type="button"
          class="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-blue-50"
          data-command-id="${command.id}"
        >
          ${command.label}
        </button>
      `
    )
    .join('');

  resultRoot.querySelectorAll<HTMLButtonElement>('[data-command-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const command = commands.find((item) => item.id === button.dataset.commandId);
      if (!command) {
        return;
      }
      void Promise.resolve(command.run()).finally(closeCommandPalette);
    });
  });
}

function initializeCommands(): void {
  commands = [
    {
      id: 'save-settings',
      label: '保存设置',
      keywords: 'save settings',
      run: saveCurrentSettings,
    },
    {
      id: 'theme-system',
      label: '主题：System',
      keywords: 'theme appearance system',
      run: (): void => setThemeSelection('system'),
    },
    {
      id: 'theme-dark',
      label: '主题：Dark',
      keywords: 'theme appearance dark',
      run: (): void => setThemeSelection('dark'),
    },
    {
      id: 'language-zh',
      label: '界面语言：简体中文',
      keywords: 'language i18n zh cn',
      run: (): void => setLanguageSelection('zh-CN'),
    },
    {
      id: 'language-en',
      label: 'Interface language: English',
      keywords: 'language i18n english en',
      run: (): void => setLanguageSelection('en'),
    },
    {
      id: 'toggle-beta',
      label: '切换 Beta Experience',
      keywords: 'beta experience experimental',
      run: (): void => {
        const toggle = getElement<HTMLInputElement>('beta-experience-toggle');
        toggle.checked = !toggle.checked;
      },
    },
  ];
}

async function initializeOptions(): Promise<void> {
  initializeCommands();
  currentSettings = await loadSettingsFromStorage();
  renderSettings(currentSettings);

  getElement<HTMLButtonElement>('save-options').addEventListener('click', () => {
    void saveCurrentSettings().catch((error) => setStatus(String(error), 'error'));
  });
  getElement<HTMLInputElement>('settings-search').addEventListener('input', (event) => {
    filterSettings((event.target as HTMLInputElement).value);
  });
  getElement<HTMLButtonElement>('open-command-palette').addEventListener('click', openCommandPalette);
  getElement<HTMLInputElement>('command-palette-search').addEventListener('input', (event) => {
    renderCommandResults((event.target as HTMLInputElement).value);
  });
  getElement<HTMLDivElement>('command-palette').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeCommandPalette();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
    }
    if (event.key === 'Escape') {
      closeCommandPalette();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void initializeOptions().catch((error) => setStatus(String(error), 'error'));
  });
} else {
  void initializeOptions().catch((error) => setStatus(String(error), 'error'));
}
