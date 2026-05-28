/**
 * Tests for the system/arch agent definition and registry helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  ARCH_SYSTEM_AGENT_ID,
  SYSTEM_AGENT_PREFIX,
  ARCH_SYSTEM_AGENT_DEFINITION,
  isSystemAgent,
  getSystemAgentDefinitions,
  getSystemAgentDefinition,
} from '../system-agent.js';

describe('system-agent', () => {
  describe('ARCH_SYSTEM_AGENT_ID', () => {
    it('should be system/arch', () => {
      expect(ARCH_SYSTEM_AGENT_ID).toBe('system/arch');
    });

    it('should start with the system agent prefix', () => {
      expect(ARCH_SYSTEM_AGENT_ID.startsWith(SYSTEM_AGENT_PREFIX)).toBe(true);
    });
  });

  describe('isSystemAgent', () => {
    it('should return true for system/arch', () => {
      expect(isSystemAgent('system/arch')).toBe(true);
    });

    it('should return true for other system/ prefixed IDs', () => {
      expect(isSystemAgent('system/cost-estimator')).toBe(true);
      expect(isSystemAgent('system/test-runner')).toBe(true);
    });

    it('should return false for user-defined agents', () => {
      expect(isSystemAgent('my-agent')).toBe(false);
      expect(isSystemAgent('triage')).toBe(false);
      expect(isSystemAgent('billing-specialist')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isSystemAgent('')).toBe(false);
    });

    it('should return false for IDs that contain but do not start with system/', () => {
      expect(isSystemAgent('my-system/arch')).toBe(false);
    });
  });

  describe('ARCH_SYSTEM_AGENT_DEFINITION', () => {
    it('should have the correct ID', () => {
      expect(ARCH_SYSTEM_AGENT_DEFINITION.id).toBe(ARCH_SYSTEM_AGENT_ID);
    });

    it('should be marked as a system agent', () => {
      expect(ARCH_SYSTEM_AGENT_DEFINITION.system).toBe(true);
    });

    it('should expose generate_topology intent', () => {
      expect(ARCH_SYSTEM_AGENT_DEFINITION.intents).toContain('generate_topology');
    });

    it('should require project:write permission', () => {
      expect(ARCH_SYSTEM_AGENT_DEFINITION.requiredPermissions).toContain('project:write');
    });

    it('should have a name and description', () => {
      expect(ARCH_SYSTEM_AGENT_DEFINITION.name).toBe('Arch AI');
      expect(ARCH_SYSTEM_AGENT_DEFINITION.description).toBeTruthy();
    });
  });

  describe('getSystemAgentDefinitions', () => {
    it('should return an array containing the arch definition', () => {
      const defs = getSystemAgentDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].id).toBe(ARCH_SYSTEM_AGENT_ID);
    });
  });

  describe('getSystemAgentDefinition', () => {
    it('should return the arch definition for system/arch', () => {
      const def = getSystemAgentDefinition(ARCH_SYSTEM_AGENT_ID);
      expect(def).toBeDefined();
      expect(def?.id).toBe(ARCH_SYSTEM_AGENT_ID);
    });

    it('should return undefined for unknown system agent', () => {
      const def = getSystemAgentDefinition('system/unknown');
      expect(def).toBeUndefined();
    });

    it('should return undefined for non-system agent', () => {
      const def = getSystemAgentDefinition('triage');
      expect(def).toBeUndefined();
    });
  });
});
