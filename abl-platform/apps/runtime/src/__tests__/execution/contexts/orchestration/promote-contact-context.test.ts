/**
 * PromoteContactContext Job Processor Tests
 *
 * Validates the BullMQ job processor factory that merges session dataValues
 * into a contact's cross-session ContactContext at session close.
 *
 * Scenarios:
 * - Completed session promotes dataValues (merges into existing context)
 * - Abandoned/non-promotable disposition skips promotion
 * - Missing session snapshot → no-op
 * - Merges additively: existing dataValues preserved, session values overwrite on conflict
 * - First session (no existing context) creates new ContactContext from scratch
 * - sessionCount increments correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPromoteContextProcessor,
  type PromoteContextDeps,
  type PromoteContextJobData,
} from '../../../../contexts/orchestration/jobs/promote-contact-context.js';
import type { ContactContext } from '../../../../contexts/contact/domain/contact.js';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-promote-001';
const CONTACT_ID = 'contact-promote-abc';
const SESSION_ID = 'sess-promote-001';

const EXISTING_CONTEXT: ContactContext = {
  preferences: { language: 'en', notifications: true },
  dataValues: { plan: 'basic', region: 'us-west', onboardingComplete: true },
  lastDisposition: 'completed',
  lastInteraction: new Date('2026-01-01T08:00:00Z'),
  sessionCount: 2,
  updatedAt: new Date('2026-01-01T08:00:00Z'),
};

const SESSION_SNAPSHOT = {
  dataValues: { plan: 'premium', lastProduct: 'widget-X' },
};

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockDeps(overrides: Partial<PromoteContextDeps> = {}): PromoteContextDeps {
  return {
    loadSessionSnapshot: vi.fn().mockResolvedValue(SESSION_SNAPSHOT),
    getContactContext: vi.fn().mockResolvedValue(EXISTING_CONTEXT),
    updateContactContext: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeJob(overrides: Partial<PromoteContextJobData> = {}): { data: PromoteContextJobData } {
  return {
    data: {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      sessionId: SESSION_ID,
      disposition: 'completed',
      ...overrides,
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createPromoteContextProcessor', () => {
  // ---------------------------------------------------------------------------
  // Completed session — happy path
  // ---------------------------------------------------------------------------

  describe('completed disposition — promotes dataValues', () => {
    it('calls loadSessionSnapshot with the correct tenantId and sessionId', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.loadSessionSnapshot).toHaveBeenCalledWith(TENANT_ID, SESSION_ID);
    });

    it('calls getContactContext with the correct tenantId and contactId', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.getContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID);
    });

    it('calls updateContactContext with merged dataValues', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.updateContactContext).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        expect.objectContaining({
          dataValues: expect.objectContaining({
            plan: 'premium', // session value overwrites existing
            lastProduct: 'widget-X', // new from session
            region: 'us-west', // preserved from existing
            onboardingComplete: true, // preserved from existing
          }),
        }),
      );
    });

    it('sets lastDisposition to the job disposition', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , savedContext] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(savedContext.lastDisposition).toBe('completed');
    });

    it('sets lastInteraction to a recent date', async () => {
      const before = new Date();
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const after = new Date();
      const [, , savedContext] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(savedContext.lastInteraction.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(savedContext.lastInteraction.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('also promotes on escalated disposition', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'escalated' }));

      expect(deps.updateContactContext).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Non-promotable disposition — skips promotion
  // ---------------------------------------------------------------------------

  describe('non-promotable dispositions — skips promotion', () => {
    it('skips promotion for abandoned disposition', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'abandoned' }));

      expect(deps.loadSessionSnapshot).not.toHaveBeenCalled();
      expect(deps.getContactContext).not.toHaveBeenCalled();
      expect(deps.updateContactContext).not.toHaveBeenCalled();
    });

    it('skips promotion for timeout disposition', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'timeout' }));

      expect(deps.updateContactContext).not.toHaveBeenCalled();
    });

    it('skips promotion for error disposition', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'error' }));

      expect(deps.updateContactContext).not.toHaveBeenCalled();
    });

    it('skips promotion for empty disposition string', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: '' }));

      expect(deps.updateContactContext).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Missing session snapshot — no-op
  // ---------------------------------------------------------------------------

  describe('missing session snapshot', () => {
    it('returns without calling updateContactContext when snapshot is null', async () => {
      const deps = createMockDeps({
        loadSessionSnapshot: vi.fn().mockResolvedValue(null),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.updateContactContext).not.toHaveBeenCalled();
    });

    it('still calls loadSessionSnapshot before deciding to abort', async () => {
      const deps = createMockDeps({
        loadSessionSnapshot: vi.fn().mockResolvedValue(null),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.loadSessionSnapshot).toHaveBeenCalledWith(TENANT_ID, SESSION_ID);
    });

    it('does not call getContactContext when snapshot is missing', async () => {
      const deps = createMockDeps({
        loadSessionSnapshot: vi.fn().mockResolvedValue(null),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.getContactContext).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Additive merge — existing values preserved, session values win on conflict
  // ---------------------------------------------------------------------------

  describe('additive merge', () => {
    it('preserves existing dataValues keys not present in session snapshot', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue({
          ...EXISTING_CONTEXT,
          dataValues: { plan: 'basic', region: 'us-west', onboardingComplete: true },
        }),
        loadSessionSnapshot: vi.fn().mockResolvedValue({
          dataValues: { plan: 'premium' }, // only overwrites 'plan'
        }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.dataValues).toMatchObject({
        plan: 'premium', // overwritten by session
        region: 'us-west', // preserved from existing
        onboardingComplete: true, // preserved from existing
      });
    });

    it('session values overwrite existing values on key conflict', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue({
          ...EXISTING_CONTEXT,
          dataValues: { plan: 'basic', score: 10 },
        }),
        loadSessionSnapshot: vi.fn().mockResolvedValue({
          dataValues: { plan: 'enterprise', score: 99 },
        }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.dataValues.plan).toBe('enterprise');
      expect(saved.dataValues.score).toBe(99);
    });

    it('preserves existing preferences (session snapshot does not carry preferences)', async () => {
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.preferences).toEqual(EXISTING_CONTEXT.preferences);
    });

    it('handles empty session dataValues without error', async () => {
      const deps = createMockDeps({
        loadSessionSnapshot: vi.fn().mockResolvedValue({ dataValues: {} }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      // Existing dataValues are fully preserved when session snapshot is empty
      expect(saved.dataValues).toMatchObject(EXISTING_CONTEXT.dataValues);
    });
  });

  // ---------------------------------------------------------------------------
  // First session — no existing context
  // ---------------------------------------------------------------------------

  describe('first session (no existing context)', () => {
    it('creates a new ContactContext when getContactContext returns null', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue(null),
        loadSessionSnapshot: vi.fn().mockResolvedValue({
          dataValues: { plan: 'starter', referralSource: 'ads' },
        }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      expect(deps.updateContactContext).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        expect.objectContaining({
          dataValues: { plan: 'starter', referralSource: 'ads' },
          preferences: {},
          lastDisposition: 'completed',
          sessionCount: 1,
        }),
      );
    });

    it('sets sessionCount to 1 for the very first session', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue(null),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.sessionCount).toBe(1);
    });

    it('sets empty preferences when no existing context', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue(null),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.preferences).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // sessionCount increments correctly
  // ---------------------------------------------------------------------------

  describe('sessionCount increments', () => {
    it('increments sessionCount by 1 from existing count', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue({
          ...EXISTING_CONTEXT,
          sessionCount: 5,
        }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.sessionCount).toBe(6);
    });

    it('increments from 0 to 1 when existing count is 0', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue({
          ...EXISTING_CONTEXT,
          sessionCount: 0,
        }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.sessionCount).toBe(1);
    });

    it('handles large existing sessionCount correctly', async () => {
      const deps = createMockDeps({
        getContactContext: vi.fn().mockResolvedValue({
          ...EXISTING_CONTEXT,
          sessionCount: 999,
        }),
      });
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.sessionCount).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // updatedAt is set on every promotion
  // ---------------------------------------------------------------------------

  describe('updatedAt', () => {
    it('sets updatedAt to a current timestamp on promotion', async () => {
      const before = new Date();
      const deps = createMockDeps();
      const processor = createPromoteContextProcessor(deps);

      await processor(makeJob({ disposition: 'completed' }));

      const after = new Date();
      const [, , saved] = (deps.updateContactContext as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(saved.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(saved.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});
