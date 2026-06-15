import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  VOLCENGINE_AST_AUTH_RULE_ID,
  buildVolcengineAstAuthRule,
} from '@/background/volcengine-ast-auth-rules';
import { VOLCENGINE_AST_RESOURCE_ID } from '@/translation/volcengine-ast';

describe('Volcengine AST auth rules', () => {
  it('declares declarativeNetRequest permissions for WebSocket handshake headers', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8')
    );

    expect(manifest.permissions).toContain('declarativeNetRequestWithHostAccess');
    expect(manifest.host_permissions).toContain('wss://openspeech.bytedance.com/*');
  });

  it('builds a session-scoped modifyHeaders rule for the official AST endpoint', () => {
    const rule = buildVolcengineAstAuthRule({
      'X-Api-Key': 'api-key',
      'X-Api-Resource-Id': VOLCENGINE_AST_RESOURCE_ID,
    });

    expect(rule).toMatchObject({
      id: VOLCENGINE_AST_AUTH_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
      },
      condition: {
        urlFilter: '||openspeech.bytedance.com/api/v4/ast/v2/translate',
        resourceTypes: ['websocket'],
      },
    });
    expect(rule.action.requestHeaders).toContainEqual({
      header: 'X-Api-Key',
      operation: 'set',
      value: 'api-key',
    });
  });

  it('updates Chrome session rules by removing stale rules before adding current headers', async () => {
    const updateSessionRules = vi.fn().mockResolvedValue(undefined);
    const { installVolcengineAstAuthRule } = await import('@/background/volcengine-ast-auth-rules');

    await installVolcengineAstAuthRule(
      {
        updateSessionRules,
      },
      {
        'X-Api-Key': 'api-key',
        'X-Api-Resource-Id': VOLCENGINE_AST_RESOURCE_ID,
      }
    );

    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [VOLCENGINE_AST_AUTH_RULE_ID],
      addRules: [expect.objectContaining({ id: VOLCENGINE_AST_AUTH_RULE_ID })],
    });
  });
});
