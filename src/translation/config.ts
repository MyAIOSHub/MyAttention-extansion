export const TRANSLATION_FEATURES = [
  'general',
  'apiProviders',
  'customActions',
  'pageTranslation',
  'videoSubtitles',
  'floatingButton',
  'selectionToolbar',
  'contextMenu',
  'inputTranslation',
  'textToSpeech',
  'statistics',
  'configSync',
  'simultaneousInterpretation',
] as const;

export type TranslationFeature = (typeof TRANSLATION_FEATURES)[number];

export const REQUIRED_TRANSLATION_PERMISSIONS = [
  'storage',
  'tabs',
  'contextMenus',
  'scripting',
  'alarms',
  'cookies',
  'identity',
  'webNavigation',
  'offscreen',
  'sidePanel',
  'tabCapture',
] as const;

export const REQUIRED_TRANSLATION_HOST_PERMISSIONS = ['*://*/*'] as const;

export type TranslationMode = 'bilingual' | 'translationOnly' | 'hoverOriginal';
export type TranslationProvider = 'browser' | 'openaiCompatible' | 'volcengine';
export type TranslationRange = 'main' | 'selection' | 'fullPage' | 'all';
export type SubtitleDisplayMode = 'bilingual' | 'originalOnly' | 'translationOnly' | 'off';
export type AudioOutputMode = 'translatedOnly' | 'dualTrack' | 'mixed' | 'subtitlesOnly';
/** 翻译质量取向：fast=更快(qwen-turbo)，accurate=更准(deepseek-v4-flash)。均关闭思考链。 */
export type TranslationQuality = 'fast' | 'accurate';

const DEFAULT_VOLCENGINE_AST_MODEL_ID = 'Doubao_scene_SLM_Doubao_SI_model2000000748711437826';

export interface ImmersiveTranslationConfig {
  enabled: boolean;
  sourceLanguage: 'auto' | string;
  targetLanguage: string;
  provider: TranslationProvider;
  mode: TranslationMode;
  range: TranslationRange;
  translationQuality: TranslationQuality;
  contextAware: boolean;
  floatingButtonEnabled: boolean;
  selectionToolbarEnabled: boolean;
  inputTranslationEnabled: boolean;
  videoSubtitlesEnabled: boolean;
  textToSpeechEnabled: boolean;
  requestBatchingEnabled: boolean;
  autoTranslatePatterns: string[];
  neverTranslatePatterns: string[];
  skipLanguages: string[];
}

export interface SimultaneousInterpretationConfig {
  enabled: boolean;
  sourceLanguage: 'auto' | string;
  targetLanguage: string;
  provider: 'volcengine';
  model: string;
  audioOutputMode: AudioOutputMode;
  originalVolume: number;
  translatedVolume: number;
  translatedAudioDelayMs: number;
  translatedMaxPlaybackRate?: number;
  subtitleDisplayMode: SubtitleDisplayMode;
  voiceCloneEnabled: boolean;
  credentials: {
    apiKey: string;
    appId: string;
    accessToken: string;
    secretKey: string;
    resourceId: string;
  };
}

export function createDefaultImmersiveTranslationConfig(): ImmersiveTranslationConfig {
  return {
    enabled: true,
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    provider: 'browser',
    mode: 'bilingual',
    range: 'main',
    translationQuality: 'fast',
    contextAware: true,
    floatingButtonEnabled: true,
    selectionToolbarEnabled: true,
    inputTranslationEnabled: true,
    videoSubtitlesEnabled: true,
    textToSpeechEnabled: true,
    requestBatchingEnabled: true,
    autoTranslatePatterns: [],
    neverTranslatePatterns: [],
    skipLanguages: [],
  };
}

export function createDefaultSimultaneousInterpretationConfig(): SimultaneousInterpretationConfig {
  return {
    enabled: false,
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    provider: 'volcengine',
    model: DEFAULT_VOLCENGINE_AST_MODEL_ID,
    audioOutputMode: 'translatedOnly',
    originalVolume: 0,
    translatedVolume: 1,
    translatedAudioDelayMs: 0,
    translatedMaxPlaybackRate: 1,
    subtitleDisplayMode: 'bilingual',
    voiceCloneEnabled: true,
    credentials: {
      apiKey: '',
      appId: '',
      accessToken: '',
      secretKey: '',
      resourceId: 'volc.service_type.10053',
    },
  };
}
