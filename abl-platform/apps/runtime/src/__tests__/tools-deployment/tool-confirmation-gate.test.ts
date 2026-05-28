/**
 * Tool Confirmation Gate Tests
 *
 * Tests shouldRequireConfirmation logic for different tool configurations.
 */
import { describe, test, expect } from 'vitest';
import { shouldRequireConfirmation } from '../../services/execution/tool-confirmation.js';
import type { ToolDefinition } from '@abl/compiler';

describe('Tool Confirmation Gate', () => {
  describe('shouldRequireConfirmation', () => {
    test('returns true for confirmation: always', () => {
      const toolDef = {
        confirmation: { require: 'always' as const },
        hints: {
          side_effects: false,
          cacheable: true,
          latency: 'fast' as const,
          parallelizable: true,
          requires_auth: false,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(true);
    });

    test('returns true for when_side_effects with side_effects: true', () => {
      const toolDef = {
        confirmation: { require: 'when_side_effects' as const },
        hints: {
          side_effects: true,
          cacheable: false,
          latency: 'medium' as const,
          parallelizable: false,
          requires_auth: true,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(true);
    });

    test('returns false for when_side_effects with side_effects: false', () => {
      const toolDef = {
        confirmation: { require: 'when_side_effects' as const },
        hints: {
          side_effects: false,
          cacheable: true,
          latency: 'fast' as const,
          parallelizable: true,
          requires_auth: false,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(false);
    });

    test('returns false for confirmation: never', () => {
      const toolDef = {
        confirmation: { require: 'never' as const },
        hints: {
          side_effects: true,
          cacheable: false,
          latency: 'medium' as const,
          parallelizable: false,
          requires_auth: true,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(false);
    });

    test('returns false when no confirmation config', () => {
      const toolDef = {
        hints: {
          side_effects: true,
          cacheable: false,
          latency: 'medium' as const,
          parallelizable: false,
          requires_auth: true,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(false);
    });
  });
});
