import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime log noise', () => {
  it('does not surface expected extension-context-loss snippet paths as warnings', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'content', 'snippets', 'snippet-capture-controller.ts'),
      'utf8'
    );

    expect(source).toContain(
      "Logger.debug('[SnippetCapture] 恢复高光跳过：扩展上下文已失效')"
    );
    expect(source).not.toContain(
      "Logger.warn('[SnippetCapture] 恢复高光跳过：扩展上下文已失效')"
    );
  });

  it('does not surface Local Store offline health checks as background errors', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'background', 'index.ts'), 'utf8');

    expect(source).toContain("Logger.debug('[Background] Local Store 健康检查失败:', message)");
    expect(source).not.toContain("Logger.error('[Background] Local Store 健康检查失败:', message)");
  });

  it('does not surface expected EverMemOS offline message failures as background errors', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'background', 'index.ts'), 'utf8');

    expect(source).toContain('function logBackgroundMessageError');
    expect(source).toContain("Logger.debug('[Background] EverMemOS 服务不可用，消息处理返回错误:'");
    expect(source).toContain('logBackgroundMessageError(message.type, error)');
    expect(source).not.toContain(
      ".catch((error) => {\n          Logger.error('[Background] 处理消息失败:', error);"
    );
  });
});
