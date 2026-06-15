import { describe, expect, it } from 'vitest';

import {
  VOLCENGINE_AST_RESOURCE_ID,
  VOLCENGINE_AST_WS_URL,
  buildVolcengineAstHeaders,
} from '@/translation/volcengine-ast';

describe('volcengine ast protocol helpers', () => {
  it('uses the official AST websocket endpoint and resource id', () => {
    expect(VOLCENGINE_AST_WS_URL).toBe('wss://openspeech.bytedance.com/api/v4/ast/v2/translate');
    expect(VOLCENGINE_AST_RESOURCE_ID).toBe('volc.service_type.10053');
  });

  it('builds new-console API key headers without leaking legacy credentials', () => {
    expect(
      buildVolcengineAstHeaders({
        apiKey: 'new-api-key',
        appId: 'legacy-app',
        accessToken: 'legacy-token',
        secretKey: '',
        resourceId: '',
      })
    ).toEqual({
      'X-Api-Key': 'new-api-key',
      'X-Api-Resource-Id': VOLCENGINE_AST_RESOURCE_ID,
    });
  });

  it('builds legacy app id and access key headers when apiKey is absent', () => {
    expect(
      buildVolcengineAstHeaders({
        apiKey: '',
        appId: 'legacy-app-id',
        accessToken: 'token',
        secretKey: '',
        resourceId: 'custom.resource',
      })
    ).toEqual({
      'X-Api-App-Id': 'legacy-app-id',
      'X-Api-Access-Key': 'token',
      'X-Api-Resource-Id': 'custom.resource',
    });
  });

  it('rejects missing AST credentials', () => {
    expect(() =>
      buildVolcengineAstHeaders({
        apiKey: '',
        appId: '',
        accessToken: '',
        secretKey: '',
        resourceId: '',
      })
    ).toThrow('请先配置火山同传 API Key 或旧版 App ID / Access Token');
  });
});
