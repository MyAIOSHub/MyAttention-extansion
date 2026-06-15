import type { AppSettings } from '@/types';
import type { SimultaneousInterpretationConfig } from '@/translation/config';
import { normalizeSimulcastPlaybackDelayMs } from '@/offscreen/simulcast-delay';

export interface LocalCredentialPrefill {
  llmApi?: NonNullable<AppSettings['llmApi']>;
  simultaneousInterpretation?: Partial<Omit<SimultaneousInterpretationConfig, 'credentials'>> & {
    credentials?: Partial<SimultaneousInterpretationConfig['credentials']>;
  };
}

const LOCAL_PREFILL_PATH = 'local-prefill.json';

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanProvider(value: unknown): NonNullable<AppSettings['llmApi']>['provider'] | undefined {
  return value === 'bailian' || value === 'openai' || value === 'custom' ? value : undefined;
}

function compactDefinedObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (entryValue === undefined || entryValue === null) {
        return false;
      }
      return typeof entryValue !== 'string' || entryValue.trim().length > 0;
    })
  ) as Partial<T>;
}

export function normalizeLocalCredentialPrefill(value: unknown): LocalCredentialPrefill {
  const input = value && typeof value === 'object' ? (value as Record<string, any>) : {};
  const llmInput = input.llmApi && typeof input.llmApi === 'object' ? input.llmApi : {};
  const simulcastInput =
    input.simultaneousInterpretation && typeof input.simultaneousInterpretation === 'object'
      ? input.simultaneousInterpretation
      : {};
  const credentialsInput =
    simulcastInput.credentials && typeof simulcastInput.credentials === 'object'
      ? simulcastInput.credentials
      : {};

  const provider = cleanProvider(llmInput.provider);
  const llmApiKey = cleanString(llmInput.apiKey);
  const llmBaseUrl = cleanString(llmInput.baseUrl);
  const llmModel = cleanString(llmInput.model);

  const astApiKey = cleanString(credentialsInput.apiKey);
  const appId = cleanString(credentialsInput.appId);
  const accessToken = cleanString(credentialsInput.accessToken);
  const secretKey = cleanString(credentialsInput.secretKey);
  const resourceId = cleanString(credentialsInput.resourceId);
  const model = cleanString(simulcastInput.model);
  const translatedAudioDelayMs =
    simulcastInput.translatedAudioDelayMs === undefined
      ? undefined
      : normalizeSimulcastPlaybackDelayMs(simulcastInput.translatedAudioDelayMs);

  const normalized: LocalCredentialPrefill = {};

  if (provider || llmApiKey || llmBaseUrl || llmModel) {
    normalized.llmApi = {
      provider: provider || 'bailian',
      apiKey: llmApiKey || '',
      ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}),
      ...(llmModel ? { model: llmModel } : {}),
    };
  }

  if (
    model ||
    translatedAudioDelayMs !== undefined ||
    astApiKey ||
    appId ||
    accessToken ||
    secretKey ||
    resourceId
  ) {
    normalized.simultaneousInterpretation = {
      ...(model ? { model } : {}),
      ...(translatedAudioDelayMs !== undefined ? { translatedAudioDelayMs } : {}),
      credentials: {
        ...(astApiKey ? { apiKey: astApiKey } : {}),
        ...(appId ? { appId } : {}),
        ...(accessToken ? { accessToken } : {}),
        ...(secretKey ? { secretKey } : {}),
        ...(resourceId ? { resourceId } : {}),
      },
    };
  }

  return normalized;
}

export async function loadLocalCredentialPrefill(): Promise<LocalCredentialPrefill> {
  try {
    const url = chrome.runtime.getURL(LOCAL_PREFILL_PATH);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    return normalizeLocalCredentialPrefill(await response.json());
  } catch {
    return {};
  }
}

export function resolveLlmCredentialPrefill(
  saved: AppSettings['llmApi'] | undefined,
  local: AppSettings['llmApi'] | undefined
): AppSettings['llmApi'] | undefined {
  if (!saved) {
    return local;
  }
  return {
    ...(local || {}),
    ...compactDefinedObject(saved),
    provider: saved.provider || local?.provider || 'bailian',
    apiKey: cleanString(saved.apiKey) || local?.apiKey || '',
  };
}

export function resolveSimulcastCredentialPrefill(
  saved: Partial<SimultaneousInterpretationConfig> | undefined,
  local: LocalCredentialPrefill['simultaneousInterpretation'] | undefined,
  defaults: SimultaneousInterpretationConfig
): SimultaneousInterpretationConfig {
  const savedWithoutCredentials = saved ? { ...saved } : undefined;
  if (savedWithoutCredentials) {
    delete savedWithoutCredentials.credentials;
  }

  return {
    ...defaults,
    ...(local || {}),
    ...compactDefinedObject(savedWithoutCredentials || {}),
    credentials: {
      ...defaults.credentials,
      ...(local?.credentials || {}),
      ...compactDefinedObject(saved?.credentials || {}),
    },
  };
}
