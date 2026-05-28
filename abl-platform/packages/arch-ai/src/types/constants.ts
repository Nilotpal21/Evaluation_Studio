/**
 * Canonical constants — derived from contracts.
 * Contract: session-state-machine.md, tool-registry.md, execution-model.md
 */

export const ARCH_PHASES = ['INTERVIEW', 'BLUEPRINT', 'BUILD', 'CREATE'] as const;

export const ARCH_MODES = ['ONBOARDING', 'IN_PROJECT'] as const;

// GATE_PENDING: DEPRECATED — retained for legacy DB records only. Not used in new sessions.
// Gates were removed in the gate-free redesign; new sessions only use IDLE/ACTIVE/COMPLETE/ARCHIVED.
export const SESSION_STATES = ['IDLE', 'ACTIVE', 'GATE_PENDING', 'COMPLETE', 'ARCHIVED'] as const;

export const SPECIALIST_IDS = [
  'onboarding',
  'multi-agent-architect',
  'abl-construct-expert',
  'channel-voice',
  'entity-collection',
  'integration-methodologist',
  'testing-eval',
] as const;

export const IN_PROJECT_SPECIALIST_IDS = [
  'in-project-architect',
  // Legacy in-project specialist ids remain accepted for old session records,
  // but new IN_PROJECT turns resolve to in-project-architect.
  'diagnostician',
  'analyst',
  'observer',
] as const;

export type InProjectSpecialistId = (typeof IN_PROJECT_SPECIALIST_IDS)[number];

export const ALL_SPECIALIST_IDS = [...SPECIALIST_IDS, ...IN_PROJECT_SPECIALIST_IDS] as const;
export type AnySpecialistId = (typeof ALL_SPECIALIST_IDS)[number];

/** Message & file validation limits — shared between schema and Studio */
export const MESSAGE_LIMITS = {
  MAX_MESSAGE_LENGTH: 10_000,
  MAX_FILES: 10,
  MAX_FILE_REFS: 20,
  /** Sliding window cap applied via $slice on appendMessage */
  MAX_STORED_MESSAGES: 200,
} as const;
