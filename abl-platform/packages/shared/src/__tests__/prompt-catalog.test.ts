import { describe, it, expect } from 'vitest';
import { PromptCatalog } from '../prompts/prompt-catalog';
import { renderTemplate } from '../prompts/template-engine';
import { PromptTemplateLoader } from '../prompts/prompt-template-loader';

describe('PromptCatalog', () => {
  describe('runtime sections', () => {
    it('has all system prompt keys as non-empty strings', () => {
      for (const [key, value] of Object.entries(PromptCatalog.systemPrompt)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('has all message keys as non-empty strings', () => {
      for (const [key, value] of Object.entries(PromptCatalog.messages)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('has all LLM prompt keys as non-empty strings', () => {
      for (const [key, value] of Object.entries(PromptCatalog.llmPrompts)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('has escalation templates for all channels', () => {
      expect(PromptCatalog.escalation.digital).toBeTruthy();
      expect(PromptCatalog.escalation.voice).toBeTruthy();
      expect(PromptCatalog.escalation.plain).toBeTruthy();
    });

    it('has tool schemas with required arrays', () => {
      for (const [key, schema] of Object.entries(PromptCatalog.toolSchemas)) {
        expect(schema.properties).toBeDefined();
        expect(Array.isArray(schema.required)).toBe(true);
      }
    });
  });

  describe('arch section', () => {
    it('has shared fragments as non-empty strings', () => {
      expect(PromptCatalog.arch.shared.base_persona.length).toBeGreaterThan(0);
      expect(PromptCatalog.arch.shared.abl_syntax_reference.length).toBeGreaterThan(0);
      expect(PromptCatalog.arch.shared.abl_syntax_compact.length).toBeGreaterThan(0);
      expect(PromptCatalog.arch.shared.tool_use_instructions.length).toBeGreaterThan(0);
    });

    it('has all chat stage prompts as non-empty strings', () => {
      const expectedStages = [
        'ideate',
        'design',
        'build',
        'test',
        'deploy',
        'evolve',
        'edit',
        'edit_planning',
        'edit_executing',
      ];
      for (const stage of expectedStages) {
        const value = (PromptCatalog.arch.chat as Record<string, string>)[stage];
        expect(value, `arch.chat.${stage} should exist`).toBeDefined();
        expect(value.length, `arch.chat.${stage} should be non-empty`).toBeGreaterThan(0);
      }
    });

    it('has all workflow prompts as non-empty strings', () => {
      const expectedKeys = [
        'responding',
        'compile_errors_present',
        'compile_errors_none',
        'executing',
      ];
      for (const key of expectedKeys) {
        const value = (PromptCatalog.arch.workflow as Record<string, string>)[key];
        expect(value, `arch.workflow.${key} should exist`).toBeDefined();
        expect(value.length, `arch.workflow.${key} should be non-empty`).toBeGreaterThan(0);
      }
    });

    it('has all generate prompts as non-empty strings', () => {
      const expectedKeys = [
        'topology_system',
        'topology_user',
        'completeness_system',
        'completeness_user',
        'agent_specs_system',
        'agent_specs_user',
        'openapi_system',
        'openapi_user',
      ];
      for (const key of expectedKeys) {
        const value = (PromptCatalog.arch.generate as Record<string, string>)[key];
        expect(value, `arch.generate.${key} should exist`).toBeDefined();
        expect(value.length, `arch.generate.${key} should be non-empty`).toBeGreaterThan(0);
      }
    });

    it('ABL syntax reference contains critical keywords', () => {
      const ref = PromptCatalog.arch.shared.abl_syntax_reference;
      expect(ref).toContain('AGENT:');
      expect(ref).toContain('SUPERVISOR:');
      expect(ref).toContain('GATHER:');
      expect(ref).toContain('HANDOFF:');
      expect(ref).toContain('CONSTRAINTS:');
      expect(ref).toContain('INVALID');
    });

    it('shared ABL syntax appears in build stage (via reference key)', () => {
      // The build stage itself is short — the full syntax is composed at the call site
      // by concatenating arch.chat.build + arch.shared.abl_syntax_reference.
      // Verify the build prompt mentions ABL code generation.
      expect(PromptCatalog.arch.chat.build).toContain('ABL');
    });
  });
});

describe('renderTemplate', () => {
  it('substitutes simple variables', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('preserves undefined variables', () => {
    const result = renderTemplate('Hello {{name}}!', {});
    expect(result).toBe('Hello {{name}}!');
  });

  it('handles conditional blocks', () => {
    const template = '{{#if show}}visible{{/if}}';
    expect(renderTemplate(template, { show: true })).toBe('visible');
    expect(renderTemplate(template, { show: false })).toBe('');
    expect(renderTemplate(template, {})).toBe('');
  });

  it('handles each blocks', () => {
    const template = '{{#each items}}[{{name}}]{{/each}}';
    const result = renderTemplate(template, {
      items: [{ name: 'a' }, { name: 'b' }],
    });
    expect(result).toBe('[a][b]');
  });

  it('renders generate prompts with template variables', () => {
    const result = renderTemplate(PromptCatalog.arch.generate.topology_user, {
      domain: 'Hotel Booking',
      problemStatement: 'Automate bookings',
      useCases: 'booking, cancellation',
      targetUsers: 'guests',
      channels: 'web chat',
      tone: 'professional',
      complexity: 'medium',
      constraints: 'none',
    });
    expect(result).toContain('Hotel Booking');
    expect(result).toContain('Automate bookings');
    expect(result).not.toContain('{{domain}}');
  });
});

describe('PromptTemplateLoader', () => {
  it('falls back to catalog when no DB override', () => {
    const loader = new PromptTemplateLoader();
    const prompt = loader.getSystemPrompt('supervisor');
    expect(prompt).toBe(PromptCatalog.systemPrompt.supervisor);
  });

  it('returns DB-loaded value when available', () => {
    const loader = new PromptTemplateLoader();
    loader.loadFromEntries([{ key: 'system_prompt.supervisor', content: 'custom prompt' }]);
    expect(loader.getSystemPrompt('supervisor')).toBe('custom prompt');
    expect(loader.isLoaded).toBe(true);
  });

  it('falls back when loadFromDB has no model', async () => {
    const loader = new PromptTemplateLoader();
    await loader.loadFromDB(); // No model — should not throw
    expect(loader.isLoaded).toBe(false);
    expect(loader.getMessage('greeting')).toBe(PromptCatalog.messages.greeting);
  });
});
