import { expect, it } from 'vitest';
import { ToolCallRequest } from '../../src/providers/base.js';
import { buildToolEventStartPayload, buildToolEventFinishPayloads } from '../../src/utils/progress-events.js';
import { formatToolHints } from '../../src/utils/tool-hints.js';
import { publicBrowserAuthResult } from '../../src/utils/browser-auth-privacy.js';

it('keeps provided sign-in values executable while removing them from history, checkpoints and progress', () => {
  const secret = 'provided-code-246810';
  const call = new ToolCallRequest({ id: 'auth-1', name: 'browser_auth_request', arguments: {
    origin: 'https://example.test', fields: [{ id: 'code' }], provided_values: { code: secret },
  } });
  expect(call.arguments.provided_values.code).toBe(secret);
  const recorded = [JSON.parse(JSON.stringify(call)), call.toOpenAIToolCall(), buildToolEventStartPayload(call),
    ...buildToolEventFinishPayloads({ toolCalls: [call], toolResults: ['{"status":"submitted"}'],
      toolEvents: [{ status: 'ok' }] }), formatToolHints([call])];
  expect(JSON.stringify(recorded)).not.toContain(secret);
  expect(JSON.stringify(recorded)).toContain('[REDACTED]');
});

it('returns only auth status and bounded control identifiers, including for unexpected browser response fields', () => {
  expect(publicBrowserAuthResult({ status: 'submitted', values: { password: 'never-return' },
    debug: 'never-return' })).toBe('{"status":"submitted"}');
  expect(() => publicBrowserAuthResult({ status: 'never-return' })).toThrow('Invalid browser auth response');
});
