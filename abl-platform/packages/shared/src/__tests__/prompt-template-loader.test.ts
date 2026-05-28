/**
 * PromptTemplateLoader Tests
 *
 * Tests loadFromDB, loadFromEntries, and all getter methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptTemplateLoader } from '../prompts/prompt-template-loader.js';
import { PromptCatalog } from '../prompts/prompt-catalog.js';

describe('PromptTemplateLoader', () => {
  let loader: PromptTemplateLoader;

  beforeEach(() => {
    loader = new PromptTemplateLoader();
  });

  // ===========================================================================
  // isLoaded
  // ===========================================================================

  describe('isLoaded', () => {
    it('should return false before loading', () => {
      expect(loader.isLoaded).toBe(false);
    });

    it('should return true after loadFromEntries', () => {
      loader.loadFromEntries([]);
      expect(loader.isLoaded).toBe(true);
    });
  });

  // ===========================================================================
  // loadFromDB
  // ===========================================================================

  describe('loadFromDB', () => {
    it('should return early when no model provided', async () => {
      await loader.loadFromDB(undefined);
      expect(loader.isLoaded).toBe(false);
    });

    it('should load documents from model', async () => {
      const mockModel = {
        find: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { key: 'system_prompt.supervisor', content: 'Custom supervisor prompt' },
            { key: 'message.error_default', content: 'Custom error message' },
          ]),
        }),
      };

      await loader.loadFromDB(mockModel);

      expect(loader.isLoaded).toBe(true);
      expect(loader.getSystemPrompt('supervisor')).toBe('Custom supervisor prompt');
      expect(loader.getMessage('error_default')).toBe('Custom error message');
    });

    it('should handle DB errors gracefully and use catalog fallback', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockModel = {
        find: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('Connection failed')),
        }),
      };

      await loader.loadFromDB(mockModel);

      expect(loader.isLoaded).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should handle non-Error thrown objects in DB errors', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockModel = {
        find: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue('string-error'),
        }),
      };

      await loader.loadFromDB(mockModel);

      expect(loader.isLoaded).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ===========================================================================
  // loadFromEntries
  // ===========================================================================

  describe('loadFromEntries', () => {
    it('should load entries into cache', () => {
      loader.loadFromEntries([
        { key: 'system_prompt.standalone', content: 'Custom standalone prompt' },
      ]);

      expect(loader.isLoaded).toBe(true);
      expect(loader.getSystemPrompt('standalone')).toBe('Custom standalone prompt');
    });
  });

  // ===========================================================================
  // getSystemPrompt
  // ===========================================================================

  describe('getSystemPrompt', () => {
    it('should return cached value when available', () => {
      loader.loadFromEntries([{ key: 'system_prompt.supervisor', content: 'Cached supervisor' }]);

      expect(loader.getSystemPrompt('supervisor')).toBe('Cached supervisor');
    });

    it('should fall back to catalog when not cached', () => {
      expect(loader.getSystemPrompt('supervisor')).toBe(PromptCatalog.systemPrompt.supervisor);
    });

    it('should fall back to catalog when cached value is not a string', () => {
      loader.loadFromEntries([{ key: 'system_prompt.supervisor', content: 42 }]);

      expect(loader.getSystemPrompt('supervisor')).toBe(PromptCatalog.systemPrompt.supervisor);
    });
  });

  // ===========================================================================
  // getToolSchema
  // ===========================================================================

  describe('getToolSchema', () => {
    it('should return cached value when available', () => {
      const schema = { properties: { test: { type: 'string' } } };
      loader.loadFromEntries([{ key: 'tool_schema.handoff', content: schema }]);

      expect(loader.getToolSchema('handoff')).toEqual(schema);
    });

    it('should fall back to catalog when not cached', () => {
      expect(loader.getToolSchema('handoff')).toEqual(PromptCatalog.toolSchemas.handoff);
    });

    it('should fall back to catalog when cached value is not an object', () => {
      loader.loadFromEntries([{ key: 'tool_schema.handoff', content: 'not-an-object' }]);

      expect(loader.getToolSchema('handoff')).toEqual(PromptCatalog.toolSchemas.handoff);
    });

    it('should fall back to catalog when cached value is null', () => {
      loader.loadFromEntries([{ key: 'tool_schema.handoff', content: null }]);

      expect(loader.getToolSchema('handoff')).toEqual(PromptCatalog.toolSchemas.handoff);
    });
  });

  // ===========================================================================
  // getSharedDescription
  // ===========================================================================

  describe('getSharedDescription', () => {
    it('should return cached value when available', () => {
      loader.loadFromEntries([
        { key: 'tool_description.shared.reason', content: 'Custom reason desc' },
      ]);

      expect(loader.getSharedDescription('reason')).toBe('Custom reason desc');
    });

    it('should fall back to catalog when not cached', () => {
      expect(loader.getSharedDescription('reason')).toBe(PromptCatalog.sharedDescriptions.reason);
    });
  });

  // ===========================================================================
  // getToolDescription
  // ===========================================================================

  describe('getToolDescription', () => {
    it('should return cached value with subKey', () => {
      loader.loadFromEntries([
        { key: 'tool_description.handoff.supervisor', content: 'Custom handoff desc' },
      ]);

      expect(loader.getToolDescription('handoff', 'supervisor')).toBe('Custom handoff desc');
    });

    it('should return cached value without subKey', () => {
      loader.loadFromEntries([
        { key: 'tool_description.escalate', content: 'Custom escalate desc' },
      ]);

      expect(loader.getToolDescription('escalate')).toBe('Custom escalate desc');
    });

    it('should fall back to catalog tool descriptions with subKey', () => {
      const result = loader.getToolDescription('handoff', 'supervisor');
      expect(result).toBe((PromptCatalog.toolDescriptions as any).handoff.supervisor);
    });

    it('should return empty string for unknown tool name', () => {
      expect(loader.getToolDescription('nonexistent_tool')).toBe('');
    });

    it('should return empty string for unknown subKey', () => {
      expect(loader.getToolDescription('handoff', 'nonexistent_subkey')).toBe('');
    });

    it('should return string directly if toolDescs is a string (no subKey)', () => {
      // This tests the case where toolDescriptions[toolName] is a string, not an object
      // The catalog has object-typed tool descriptions, so we use cache for this
      loader.loadFromEntries([
        { key: 'tool_description.custom_tool', content: 'A simple tool description' },
      ]);
      expect(loader.getToolDescription('custom_tool')).toBe('A simple tool description');
    });
  });

  // ===========================================================================
  // getMessage
  // ===========================================================================

  describe('getMessage', () => {
    it('should return cached value when available', () => {
      loader.loadFromEntries([{ key: 'message.error_default', content: 'Custom error' }]);

      expect(loader.getMessage('error_default')).toBe('Custom error');
    });

    it('should fall back to catalog when not cached', () => {
      expect(loader.getMessage('error_default')).toBe(PromptCatalog.messages.error_default);
    });
  });

  // ===========================================================================
  // getLLMPrompt
  // ===========================================================================

  describe('getLLMPrompt', () => {
    it('should return cached value when available', () => {
      loader.loadFromEntries([
        { key: 'llm_prompt.entity_extraction', content: 'Custom extraction prompt' },
      ]);

      expect(loader.getLLMPrompt('entity_extraction')).toBe('Custom extraction prompt');
    });

    it('should fall back to catalog when not cached', () => {
      expect(loader.getLLMPrompt('entity_extraction')).toBe(
        PromptCatalog.llmPrompts.entity_extraction,
      );
    });
  });

  // ===========================================================================
  // getEscalation
  // ===========================================================================

  describe('getEscalation', () => {
    it('should return cached value when available', () => {
      loader.loadFromEntries([{ key: 'escalation.digital', content: 'Custom escalation' }]);

      expect(loader.getEscalation('digital')).toBe('Custom escalation');
    });

    it('should fall back to catalog when not cached', () => {
      expect(loader.getEscalation('digital')).toBe(PromptCatalog.escalation.digital);
    });

    it('should fall back to catalog for voice', () => {
      expect(loader.getEscalation('voice')).toBe(PromptCatalog.escalation.voice);
    });

    it('should fall back to catalog for plain', () => {
      expect(loader.getEscalation('plain')).toBe(PromptCatalog.escalation.plain);
    });
  });
});
