import { describe, test, expect, vi, beforeEach } from 'vitest';
import { PromptTemplateLoader } from '../../services/execution/prompt-template-loader';
import { PromptCatalog } from '../../services/execution/prompt-catalog';

describe('PromptTemplateLoader', () => {
  let loader: PromptTemplateLoader;

  beforeEach(() => {
    loader = new PromptTemplateLoader();
  });

  test('returns catalog fallback when DB not loaded', () => {
    const template = loader.getSystemPrompt('supervisor');
    expect(template).toBe(PromptCatalog.systemPrompt.supervisor);
  });

  test('returns catalog fallback for tool schema', () => {
    const schema = loader.getToolSchema('handoff');
    expect(schema).toEqual(PromptCatalog.toolSchemas.handoff);
  });

  test('returns catalog fallback for message', () => {
    const msg = loader.getMessage('error_default');
    expect(msg).toBe(PromptCatalog.messages.error_default);
  });

  test('returns DB value when loaded', async () => {
    // Simulate DB load
    loader.loadFromEntries([
      { key: 'system_prompt.supervisor', content: 'Custom supervisor template' },
      { key: 'message.error_default', content: 'Custom error message' },
    ]);

    expect(loader.getSystemPrompt('supervisor')).toBe('Custom supervisor template');
    expect(loader.getMessage('error_default')).toBe('Custom error message');
    // Unloaded keys still fall back
    expect(loader.getSystemPrompt('specialist')).toBe(PromptCatalog.systemPrompt.specialist);
  });

  test('getSharedDescription returns reason/thought descriptions', () => {
    expect(loader.getSharedDescription('reason')).toBe(PromptCatalog.sharedDescriptions.reason);
    expect(loader.getSharedDescription('thought')).toBe(PromptCatalog.sharedDescriptions.thought);
  });

  test('getLLMPrompt returns catalog fallback when DB not loaded', () => {
    const prompt = loader.getLLMPrompt('entity_extraction');
    expect(prompt).toBe(PromptCatalog.llmPrompts.entity_extraction);
  });

  test('getLLMPrompt returns all 4 prompts from catalog', () => {
    const keys = [
      'entity_extraction',
      'correction_detection',
      'field_validation',
      'field_inference',
    ] as const;
    for (const key of keys) {
      const prompt = loader.getLLMPrompt(key);
      expect(prompt).toBeTruthy();
      expect(prompt).toBe(PromptCatalog.llmPrompts[key]);
    }
  });

  test('DB-loaded entries override LLM prompts', () => {
    loader.loadFromEntries([
      { key: 'llm_prompt.entity_extraction', content: 'Custom extraction prompt' },
    ]);
    expect(loader.getLLMPrompt('entity_extraction')).toBe('Custom extraction prompt');
    // Non-overridden keys still fall back
    expect(loader.getLLMPrompt('correction_detection')).toBe(
      PromptCatalog.llmPrompts.correction_detection,
    );
  });

  test('returns catalog fallback for escalation templates', () => {
    expect(loader.getEscalation('digital')).toBe(PromptCatalog.escalation.digital);
    expect(loader.getEscalation('voice')).toBe(PromptCatalog.escalation.voice);
    expect(loader.getEscalation('plain')).toBe(PromptCatalog.escalation.plain);
  });

  test('getToolDescription returns tool descriptions from catalog', () => {
    const desc = loader.getToolDescription('handoff', 'supervisor');
    expect(desc).toBe(PromptCatalog.toolDescriptions.handoff.supervisor);
  });

  test('getToolDescription returns empty string for unknown tool', () => {
    const desc = loader.getToolDescription('nonexistent_tool');
    expect(desc).toBe('');
  });

  test('DB-loaded entries override catalog for escalation', () => {
    loader.loadFromEntries([{ key: 'escalation.digital', content: 'Custom digital escalation' }]);
    expect(loader.getEscalation('digital')).toBe('Custom digital escalation');
    // Non-overridden channels still fall back
    expect(loader.getEscalation('voice')).toBe(PromptCatalog.escalation.voice);
  });

  test('DB-loaded entries override tool descriptions', () => {
    loader.loadFromEntries([
      { key: 'tool_description.handoff.supervisor', content: 'Custom handoff description' },
    ]);
    expect(loader.getToolDescription('handoff', 'supervisor')).toBe('Custom handoff description');
  });

  test('DB-loaded entries override shared descriptions', () => {
    loader.loadFromEntries([
      { key: 'tool_description.shared.reason', content: 'Custom reason description' },
    ]);
    expect(loader.getSharedDescription('reason')).toBe('Custom reason description');
  });

  test('DB-loaded entries override tool schemas', () => {
    const customSchema = {
      properties: {
        reason: { type: 'string' as const, description: 'Custom reason' },
        target: { type: 'string' as const, description: 'Custom target' },
      },
      required: ['reason', 'target'],
    };
    loader.loadFromEntries([{ key: 'tool_schema.handoff', content: customSchema }]);
    expect(loader.getToolSchema('handoff')).toEqual(customSchema);
  });

  test('isLoaded returns false initially', () => {
    expect(loader.isLoaded).toBe(false);
  });

  test('isLoaded returns true after loadFromEntries', () => {
    loader.loadFromEntries([]);
    expect(loader.isLoaded).toBe(true);
  });

  test('loadFromDB sets loaded true on success', async () => {
    const mockModel = {
      find: vi.fn().mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([{ key: 'system_prompt.supervisor', content: 'DB supervisor' }]),
      }),
    };
    await loader.loadFromDB(mockModel);
    expect(loader.isLoaded).toBe(true);
    expect(loader.getSystemPrompt('supervisor')).toBe('DB supervisor');
  });

  test('loadFromDB gracefully handles errors', async () => {
    const mockModel = {
      find: vi.fn().mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      }),
    };
    await loader.loadFromDB(mockModel);
    expect(loader.isLoaded).toBe(false);
    // Falls back to catalog
    expect(loader.getSystemPrompt('supervisor')).toBe(PromptCatalog.systemPrompt.supervisor);
  });

  test('loadFromDB skips when no model provided', async () => {
    await loader.loadFromDB();
    expect(loader.isLoaded).toBe(false);
  });
});
