import { describe, it, expect } from 'vitest';
import { interpretRunError } from '../lib/pipeline-run-error-interpreter';

describe('interpretRunError', () => {
  it('returns null for unknown errors', () => {
    expect(interpretRunError('Something totally unexpected happened')).toBeNull();
    expect(interpretRunError('')).toBeNull();
  });

  it('interprets read-message-window payload error', () => {
    const result = interpretRunError('ReadMessageWindow requires payload in pipelineInput');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
    expect(result!.diagnosis).toContain('session-level trigger');
  });

  it('interprets sessionId missing error', () => {
    const result = interpretRunError(
      'ReadConversation requires sessionId in pipeline context or input',
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
    expect(result!.diagnosis.toLowerCase()).toContain('sessionid');
  });

  it('interprets INVALID_TABLE error with the bad name', () => {
    const result = interpretRunError('Invalid table name: test_custom_politeness');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
    expect(result!.diagnosis).toContain('test_custom_politeness');
    expect(result!.diagnosis).toContain('database.table');
  });

  it('interprets MongoDB collection missing error', () => {
    const result = interpretRunError(
      "MongoDB destination requires 'collection' or 'table' in config",
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
  });

  it('interprets callback URL missing error', () => {
    const result = interpretRunError('Callback destination requires callbackUrl');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
  });

  it('interprets rate-limit error and suggests redrive', () => {
    const result = interpretRunError('Rate limit exceeded: 429 Too Many Requests');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('redrive');
  });

  it('interprets timeout error', () => {
    const result = interpretRunError('Activity timed out after 30000ms');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
  });

  it('interprets filter missing source config', () => {
    const result = interpretRunError("filter requires 'source' and 'expression' in config");
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open-in-editor');
  });

  it('is case-insensitive for trigger mismatch', () => {
    // Server error is CamelCase "ReadMessageWindow" — the /i flag handles casing variants
    const result = interpretRunError('READMESSAGEWINDOW REQUIRES PAYLOAD IN PIPELINEINPUT');
    expect(result).not.toBeNull();
  });
});
