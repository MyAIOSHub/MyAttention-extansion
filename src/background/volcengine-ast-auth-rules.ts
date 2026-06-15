export const VOLCENGINE_AST_AUTH_RULE_ID = 19053;
export const VOLCENGINE_AST_URL_FILTER =
  '||openspeech.bytedance.com/api/v4/ast/v2/translate';

export interface VolcengineAstAuthRuleApi {
  updateSessionRules(options: {
    removeRuleIds?: number[];
    addRules?: chrome.declarativeNetRequest.Rule[];
  }): Promise<void>;
}

export function buildVolcengineAstAuthRule(
  headers: Record<string, string>
): chrome.declarativeNetRequest.Rule {
  return {
    id: VOLCENGINE_AST_AUTH_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: Object.entries(headers).map(([header, value]) => ({
        header,
        operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
        value,
      })),
    },
    condition: {
      urlFilter: VOLCENGINE_AST_URL_FILTER,
      resourceTypes: ['websocket' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

export async function installVolcengineAstAuthRule(
  api: VolcengineAstAuthRuleApi,
  headers: Record<string, string>
): Promise<void> {
  await api.updateSessionRules({
    removeRuleIds: [VOLCENGINE_AST_AUTH_RULE_ID],
    addRules: [buildVolcengineAstAuthRule(headers)],
  });
}

export async function removeVolcengineAstAuthRule(
  api: VolcengineAstAuthRuleApi
): Promise<void> {
  await api.updateSessionRules({
    removeRuleIds: [VOLCENGINE_AST_AUTH_RULE_ID],
  });
}
