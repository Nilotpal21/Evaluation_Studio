/**
 * CREATE phase — pure-function and structural tests.
 *
 * No vi.mock of internal packages per CLAUDE.md test architecture rules.
 *
 * finalizeProject is an orchestration shim around platform-level services
 * (Project, ProjectAgent, Tool collections) that require a live MongoDB
 * connection. Direct unit testing of those writes is deferred to M3.2 E2E
 * coverage. These tests validate the pure-function logic and coordinator-level
 * mechanics that govern CREATE:
 *
 *   Test 1 — phase-machine: BUILD.next is CREATE
 *   Test 2 — phase-machine: CREATE.next is null (terminal)
 *   Test 3 — phase-machine: BUILD exit criteria requires all agents compiled/warning
 *   Test 4 — phase-machine: CREATE exit criteria requires projectId set
 *   Test 5 — phase-machine: BUILD→CREATE is a valid transition
 *   Test 6 — state-machine: ACTIVE→COMPLETE is valid
 *   Test 7 — state-machine: COMPLETE→ARCHIVED is valid
 *   Test 8 — state-machine: ACTIVE→IDLE is valid (rollback on create failure)
 */

import { describe, it, expect } from 'vitest';

import {
  transitionPhase,
  getNextPhase,
  checkExitCriteria,
} from '../../coordinator/phase-machine.js';
import { PHASE_CONFIG } from '../../coordinator/phase-machine.js';
import { validateStateTransition } from '../../coordinator/session-state-machine.js';
import { ExitCriteriaNotMetError, InvalidTransitionError } from '../../types/errors.js';
import type { ArchSession } from '../../types/session.js';
import { createDefaultSpecification } from '../../types/specification.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ArchSession> = {}): ArchSession {
  return {
    id: 'sess-create-test',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'BUILD',
      mode: 'ONBOARDING',
      specification: createDefaultSpecification(),
      pendingInteraction: null,
      messages: [],
      topologyApproved: true,
      approvedAgents: [],
      files: {},
      toolDsls: {},
      ...overrides.metadata,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
    ...(overrides.state !== undefined ? { state: overrides.state } : {}),
  } as ArchSession;
}

function makeBuildReadySession(): ArchSession {
  return makeSession({
    metadata: {
      phase: 'BUILD',
      mode: 'ONBOARDING',
      specification: createDefaultSpecification(),
      pendingInteraction: null,
      messages: [],
      topologyApproved: true,
      approvedAgents: [],
      files: {},
      toolDsls: {},
      topology: {
        agents: [
          { name: 'supervisor', role: 'coordinator' },
          { name: 'specialist-a', role: 'worker' },
        ],
      },
      buildProgress: {
        stage: 'complete',
        agentStatuses: {
          supervisor: 'compiled',
          'specialist-a': 'compiled',
        },
      },
    },
  } as Partial<ArchSession>);
}

function makeCreateSession(): ArchSession {
  return makeSession({
    metadata: {
      phase: 'CREATE',
      mode: 'ONBOARDING',
      specification: createDefaultSpecification(),
      pendingInteraction: null,
      messages: [],
      topologyApproved: true,
      approvedAgents: [],
      files: {},
      toolDsls: {},
      projectId: 'proj-123',
    },
  } as Partial<ArchSession>);
}

// ─── Phase Machine Tests ────────────────────────────────────────────────

describe('CREATE phase — phase machine', () => {
  it('BUILD.next is CREATE', () => {
    expect(getNextPhase('BUILD')).toBe('CREATE');
  });

  it('CREATE.next is null (terminal phase)', () => {
    expect(getNextPhase('CREATE')).toBeNull();
  });

  it('BUILD exit criteria requires all agents compiled or warning', () => {
    const session = makeBuildReadySession();
    expect(checkExitCriteria(session)).toBe(true);

    // One agent still pending → exit criteria not met
    const pendingSession = makeSession({
      metadata: {
        phase: 'BUILD',
        mode: 'ONBOARDING',
        specification: createDefaultSpecification(),
        pendingInteraction: null,
        messages: [],
        topologyApproved: true,
        approvedAgents: [],
        files: {},
        toolDsls: {},
        topology: {
          agents: [{ name: 'supervisor', role: 'coordinator' }],
        },
        buildProgress: {
          stage: 'generating',
          agentStatuses: { supervisor: 'pending' },
        },
      },
    } as Partial<ArchSession>);
    expect(checkExitCriteria(pendingSession)).toBe(false);
  });

  it('CREATE exit criteria requires projectId set', () => {
    const sessionWithProject = makeCreateSession();
    expect(PHASE_CONFIG.CREATE.exitCriteria(sessionWithProject)).toBe(true);

    const sessionWithoutProject = makeSession({
      metadata: {
        phase: 'CREATE',
        mode: 'ONBOARDING',
        specification: createDefaultSpecification(),
        pendingInteraction: null,
        messages: [],
        topologyApproved: true,
        approvedAgents: [],
        files: {},
        toolDsls: {},
        projectId: undefined,
      },
    } as Partial<ArchSession>);
    expect(PHASE_CONFIG.CREATE.exitCriteria(sessionWithoutProject)).toBe(false);
  });

  it('BUILD→CREATE is a valid transition when exit criteria met', () => {
    const session = makeBuildReadySession();
    const result = transitionPhase(session, 'CREATE');
    expect(result).toBe('CREATE');
  });

  it('BUILD→CREATE throws ExitCriteriaNotMetError when agents not compiled', () => {
    const session = makeSession({
      metadata: {
        phase: 'BUILD',
        mode: 'ONBOARDING',
        specification: createDefaultSpecification(),
        pendingInteraction: null,
        messages: [],
        topologyApproved: true,
        approvedAgents: [],
        files: {},
        toolDsls: {},
        topology: {
          agents: [{ name: 'supervisor', role: 'coordinator' }],
        },
        buildProgress: {
          stage: 'generating',
          agentStatuses: { supervisor: 'error' },
        },
      },
    } as Partial<ArchSession>);
    expect(() => transitionPhase(session, 'CREATE')).toThrow(ExitCriteriaNotMetError);
  });

  it('CREATE→INTERVIEW is an invalid transition (no backward from terminal)', () => {
    const session = makeCreateSession();
    expect(() => transitionPhase(session, 'INTERVIEW')).toThrow(InvalidTransitionError);
  });
});

// ─── State Machine Tests (ACTIVE → COMPLETE → ARCHIVED) ────────────────

describe('CREATE phase — session state machine', () => {
  it('ACTIVE→COMPLETE is a valid transition', () => {
    expect(validateStateTransition('ACTIVE', 'COMPLETE')).toBe('COMPLETE');
  });

  it('COMPLETE→ARCHIVED is a valid transition', () => {
    expect(validateStateTransition('COMPLETE', 'ARCHIVED')).toBe('ARCHIVED');
  });

  it('ACTIVE→IDLE is valid (rollback on create failure)', () => {
    expect(validateStateTransition('ACTIVE', 'IDLE')).toBe('IDLE');
  });

  it('COMPLETE→ACTIVE is an invalid transition', () => {
    expect(() => validateStateTransition('COMPLETE', 'ACTIVE')).toThrow(InvalidTransitionError);
  });

  it('ARCHIVED→ACTIVE is an invalid transition', () => {
    expect(() => validateStateTransition('ARCHIVED', 'ACTIVE')).toThrow(InvalidTransitionError);
  });
});
