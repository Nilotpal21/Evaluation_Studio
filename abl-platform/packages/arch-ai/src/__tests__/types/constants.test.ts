import { describe, expect, it } from 'vitest';
import {
  ARCH_PHASES,
  ARCH_MODES,
  SESSION_STATES,
  SPECIALIST_IDS,
  IN_PROJECT_SPECIALIST_IDS,
  ALL_SPECIALIST_IDS,
  MESSAGE_LIMITS,
  type InProjectSpecialistId,
  type AnySpecialistId,
} from '../../types/constants.js';

describe('constants', () => {
  describe('ARCH_PHASES', () => {
    it('contains all onboarding phases', () => {
      expect(ARCH_PHASES).toEqual(['INTERVIEW', 'BLUEPRINT', 'BUILD', 'CREATE']);
    });

    it('has length 4', () => {
      expect(ARCH_PHASES).toHaveLength(4);
    });
  });

  describe('ARCH_MODES', () => {
    it('contains both modes', () => {
      expect(ARCH_MODES).toEqual(['ONBOARDING', 'IN_PROJECT']);
    });

    it('has length 2', () => {
      expect(ARCH_MODES).toHaveLength(2);
    });
  });

  describe('SESSION_STATES', () => {
    it('contains all session states', () => {
      expect(SESSION_STATES).toEqual(['IDLE', 'ACTIVE', 'GATE_PENDING', 'COMPLETE', 'ARCHIVED']);
    });

    it('includes legacy GATE_PENDING', () => {
      expect(SESSION_STATES).toContain('GATE_PENDING');
    });

    it('has length 5', () => {
      expect(SESSION_STATES).toHaveLength(5);
    });
  });

  describe('SPECIALIST_IDS', () => {
    it('contains all onboarding specialist IDs', () => {
      expect(SPECIALIST_IDS).toEqual([
        'onboarding',
        'multi-agent-architect',
        'abl-construct-expert',
        'channel-voice',
        'entity-collection',
        'integration-methodologist',
        'testing-eval',
      ]);
    });

    it('has length 7', () => {
      expect(SPECIALIST_IDS).toHaveLength(7);
    });

    it('includes onboarding specialist', () => {
      expect(SPECIALIST_IDS).toContain('onboarding');
    });

    it('includes multi-agent-architect', () => {
      expect(SPECIALIST_IDS).toContain('multi-agent-architect');
    });
  });

  describe('IN_PROJECT_SPECIALIST_IDS', () => {
    it('contains all in-project specialist IDs', () => {
      expect(IN_PROJECT_SPECIALIST_IDS).toEqual([
        'in-project-architect',
        'diagnostician',
        'analyst',
        'observer',
      ]);
    });

    it('has length 4', () => {
      expect(IN_PROJECT_SPECIALIST_IDS).toHaveLength(4);
    });

    it('includes in-project-architect', () => {
      expect(IN_PROJECT_SPECIALIST_IDS).toContain('in-project-architect');
    });
  });

  describe('ALL_SPECIALIST_IDS', () => {
    it('combines onboarding and in-project specialists', () => {
      expect(ALL_SPECIALIST_IDS).toHaveLength(
        SPECIALIST_IDS.length + IN_PROJECT_SPECIALIST_IDS.length,
      );
    });

    it('includes all onboarding specialists', () => {
      for (const id of SPECIALIST_IDS) {
        expect(ALL_SPECIALIST_IDS).toContain(id);
      }
    });

    it('includes all in-project specialists', () => {
      for (const id of IN_PROJECT_SPECIALIST_IDS) {
        expect(ALL_SPECIALIST_IDS).toContain(id);
      }
    });

    it('has no duplicates', () => {
      const unique = Array.from(new Set(ALL_SPECIALIST_IDS));
      expect(unique).toHaveLength(ALL_SPECIALIST_IDS.length);
    });

    it('has length 11', () => {
      expect(ALL_SPECIALIST_IDS).toHaveLength(11);
    });
  });

  describe('MESSAGE_LIMITS', () => {
    it('defines MAX_MESSAGE_LENGTH', () => {
      expect(MESSAGE_LIMITS.MAX_MESSAGE_LENGTH).toBe(10_000);
    });

    it('defines MAX_FILES', () => {
      expect(MESSAGE_LIMITS.MAX_FILES).toBe(10);
    });

    it('defines MAX_FILE_REFS', () => {
      expect(MESSAGE_LIMITS.MAX_FILE_REFS).toBe(20);
    });

    it('defines MAX_STORED_MESSAGES', () => {
      expect(MESSAGE_LIMITS.MAX_STORED_MESSAGES).toBe(200);
    });

    it('MAX_FILE_REFS is double MAX_FILES', () => {
      expect(MESSAGE_LIMITS.MAX_FILE_REFS).toBe(MESSAGE_LIMITS.MAX_FILES * 2);
    });

    it('MAX_STORED_MESSAGES is larger than MAX_FILES', () => {
      expect(MESSAGE_LIMITS.MAX_STORED_MESSAGES).toBeGreaterThan(MESSAGE_LIMITS.MAX_FILES);
    });
  });

  describe('type exports', () => {
    it('InProjectSpecialistId type accepts valid IDs', () => {
      const id1: InProjectSpecialistId = 'in-project-architect';
      const id2: InProjectSpecialistId = 'diagnostician';
      const id3: InProjectSpecialistId = 'analyst';
      const id4: InProjectSpecialistId = 'observer';

      expect(id1).toBe('in-project-architect');
      expect(id2).toBe('diagnostician');
      expect(id3).toBe('analyst');
      expect(id4).toBe('observer');
    });

    it('AnySpecialistId type accepts all specialist IDs', () => {
      const onboarding: AnySpecialistId = 'onboarding';
      const inProject: AnySpecialistId = 'in-project-architect';

      expect(onboarding).toBe('onboarding');
      expect(inProject).toBe('in-project-architect');
    });
  });
});
