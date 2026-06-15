import type { SimultaneousInterpretationConfig } from './config';

export const VOLCENGINE_AST_WS_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';
export const VOLCENGINE_AST_RESOURCE_ID = 'volc.service_type.10053';

export type VolcengineAstCredentials = SimultaneousInterpretationConfig['credentials'];

export function buildVolcengineAstHeaders(
  credentials: VolcengineAstCredentials
): Record<string, string> {
  const resourceId = credentials.resourceId || VOLCENGINE_AST_RESOURCE_ID;

  if (credentials.apiKey) {
    return {
      'X-Api-Key': credentials.apiKey,
      'X-Api-Resource-Id': resourceId,
    };
  }

  if (credentials.appId && credentials.accessToken) {
    return {
      'X-Api-App-Id': credentials.appId,
      'X-Api-Access-Key': credentials.accessToken,
      'X-Api-Resource-Id': resourceId,
    };
  }

  throw new Error('请先配置火山同传 API Key 或旧版 App ID / Access Token');
}
