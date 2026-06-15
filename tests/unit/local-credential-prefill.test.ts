import { describe, expect, it } from 'vitest';

import {
  normalizeLocalCredentialPrefill,
  resolveLlmCredentialPrefill,
  resolveSimulcastCredentialPrefill,
} from '@/popup/local-credential-prefill';
import { createDefaultSimultaneousInterpretationConfig } from '@/translation/config';

describe('local credential prefill', () => {
  it('normalizes only supported local prefill fields', () => {
    const prefill = normalizeLocalCredentialPrefill({
      llmApi: {
        provider: 'bailian',
        apiKey: ' bailian-key ',
        baseUrl: 42,
        model: ' qwen-plus ',
      },
      simultaneousInterpretation: {
        model: ' Doubao_scene ',
        translatedAudioDelayMs: '1200',
        credentials: {
          apiKey: ' ast-api-key ',
          appId: ' app-id ',
          accessToken: ' token ',
          secretKey: ' secret ',
          resourceId: ' resource ',
          ignored: 'ignored',
        },
      },
    });

    expect(prefill).toEqual({
      llmApi: {
        provider: 'bailian',
        apiKey: 'bailian-key',
        model: 'qwen-plus',
      },
      simultaneousInterpretation: {
        model: 'Doubao_scene',
        translatedAudioDelayMs: 1200,
        credentials: {
          apiKey: 'ast-api-key',
          appId: 'app-id',
          accessToken: 'token',
          secretKey: 'secret',
          resourceId: 'resource',
        },
      },
    });
  });

  it('uses saved LLM config before local prefill', () => {
    expect(
      resolveLlmCredentialPrefill(
        {
          provider: 'custom',
          apiKey: 'saved-key',
          baseUrl: 'https://example.test/v1',
          model: 'saved-model',
        },
        {
          provider: 'bailian',
          apiKey: 'local-key',
          model: 'qwen-plus',
        }
      )
    ).toEqual({
      provider: 'custom',
      apiKey: 'saved-key',
      baseUrl: 'https://example.test/v1',
      model: 'saved-model',
    });
  });

  it('does not let empty saved LLM fields hide local prefill defaults', () => {
    expect(
      resolveLlmCredentialPrefill(
        {
          provider: 'bailian',
          apiKey: '',
          model: '',
        },
        {
          provider: 'bailian',
          apiKey: 'local-key',
          model: 'qwen-plus',
        }
      )
    ).toEqual({
      provider: 'bailian',
      apiKey: 'local-key',
      model: 'qwen-plus',
    });
  });

  it('merges simulcast defaults, local prefill, and saved settings in priority order', () => {
    const defaults = createDefaultSimultaneousInterpretationConfig();

    const resolved = resolveSimulcastCredentialPrefill(
      {
        targetLanguage: 'ja-JP',
        credentials: {
          accessToken: 'saved-token',
        },
      },
      {
        model: 'local-model',
        translatedAudioDelayMs: 800,
        credentials: {
          appId: 'local-app-id',
          accessToken: 'local-token',
          secretKey: 'local-secret',
        },
      },
      defaults
    );

    expect(resolved.model).toBe('local-model');
    expect(resolved.targetLanguage).toBe('ja-JP');
    expect(resolved.translatedAudioDelayMs).toBe(800);
    expect(resolved.credentials).toMatchObject({
      appId: 'local-app-id',
      accessToken: 'saved-token',
      secretKey: 'local-secret',
      resourceId: 'volc.service_type.10053',
    });
  });

  it('does not let empty saved simulcast credentials hide local prefill defaults', () => {
    const defaults = createDefaultSimultaneousInterpretationConfig();

    const resolved = resolveSimulcastCredentialPrefill(
      {
        model: '',
        credentials: {
          appId: '',
          accessToken: '',
          secretKey: '',
        },
      },
      {
        model: 'local-model',
        credentials: {
          appId: 'local-app-id',
          accessToken: 'local-token',
          secretKey: 'local-secret',
        },
      },
      defaults
    );

    expect(resolved.model).toBe('local-model');
    expect(resolved.credentials).toMatchObject({
      appId: 'local-app-id',
      accessToken: 'local-token',
      secretKey: 'local-secret',
    });
  });
});
