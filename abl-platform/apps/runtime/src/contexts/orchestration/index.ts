/**
 * Orchestration Context -- Public API
 *
 * Re-exports all use cases and job processors for the orchestration bounded
 * context. Provides a `createOrchestrationContext(deps)` factory that wires
 * everything together.
 *
 * The orchestration context composes use cases from the channel, identity,
 * and contact contexts to handle cross-cutting flows like session initialization,
 * identity promotion, channel switching, back-linking, and merge detection.
 */

// =============================================================================
// USE CASES
// =============================================================================

export { InitializeSession } from './use-cases/initialize-session.js';
export type {
  InitializeSessionDeps,
  InitializeSessionInput,
  InitializeSessionResult,
} from './use-cases/initialize-session.js';

export { PromoteAndLink } from './use-cases/promote-and-link.js';
export type {
  PromoteAndLinkDeps,
  PromoteAndLinkInput,
  PromoteAndLinkResult,
} from './use-cases/promote-and-link.js';

export { SwitchChannel } from './use-cases/switch-channel.js';
export type {
  SwitchChannelDeps,
  SwitchChannelInput,
  SwitchChannelResult,
} from './use-cases/switch-channel.js';

// =============================================================================
// JOB PROCESSORS
// =============================================================================

export {
  createBackLinkProcessor,
  BACK_LINK_QUEUE_NAME,
  BACK_LINK_QUEUE_CONFIG,
} from './jobs/back-link-sessions.js';
export type { BackLinkJobData, BackLinkDeps } from './jobs/back-link-sessions.js';

export {
  createMergeDetectionProcessor,
  MERGE_DETECTION_QUEUE_NAME,
  MERGE_DETECTION_QUEUE_CONFIG,
} from './jobs/detect-merge-candidates.js';
export type { MergeDetectionJobData, MergeDetectionDeps } from './jobs/detect-merge-candidates.js';

export {
  createPromoteContextProcessor,
  PROMOTE_CONTEXT_QUEUE_NAME,
  PROMOTE_CONTEXT_QUEUE_CONFIG,
} from './jobs/promote-contact-context.js';
export type { PromoteContextJobData, PromoteContextDeps } from './jobs/promote-contact-context.js';

// =============================================================================
// FACTORY
// =============================================================================

import type { InitializeSessionDeps } from './use-cases/initialize-session.js';
import type { PromoteAndLinkDeps } from './use-cases/promote-and-link.js';
import type { SwitchChannelDeps } from './use-cases/switch-channel.js';
import type { BackLinkDeps } from './jobs/back-link-sessions.js';
import type { MergeDetectionDeps } from './jobs/detect-merge-candidates.js';
import type { PromoteContextDeps } from './jobs/promote-contact-context.js';

import { InitializeSession } from './use-cases/initialize-session.js';
import { PromoteAndLink } from './use-cases/promote-and-link.js';
import { SwitchChannel } from './use-cases/switch-channel.js';
import { createBackLinkProcessor } from './jobs/back-link-sessions.js';
import { createMergeDetectionProcessor } from './jobs/detect-merge-candidates.js';
import { createPromoteContextProcessor } from './jobs/promote-contact-context.js';

/** Dependencies required to wire the orchestration context. */
export interface OrchestrationContextDeps {
  readonly initializeSession: InitializeSessionDeps;
  readonly promoteAndLink: PromoteAndLinkDeps;
  readonly switchChannel: SwitchChannelDeps;
  readonly backLink: BackLinkDeps;
  readonly mergeDetection: MergeDetectionDeps;
  readonly promoteContext?: PromoteContextDeps;
}

/** Wired orchestration context with all use cases and job processors. */
export interface OrchestrationContext {
  readonly initializeSession: InitializeSession;
  readonly promoteAndLink: PromoteAndLink;
  readonly switchChannel: SwitchChannel;
  readonly backLinkProcessor: (job: {
    data: { tenantId: string; contactId: string; channelArtifact: string };
  }) => Promise<void>;
  readonly mergeDetectionProcessor: (job: {
    data: { tenantId: string; contactId: string };
  }) => Promise<void>;
  readonly promoteContextProcessor?: (job: {
    data: {
      tenantId: string;
      contactId: string;
      sessionId: string;
      disposition: string;
      dataValues: Record<string, unknown>;
    };
  }) => Promise<void>;
}

/**
 * Wire all orchestration use cases and job processors from their dependencies.
 * Returns a typed object -- callers access use cases directly.
 */
export function createOrchestrationContext(deps: OrchestrationContextDeps): OrchestrationContext {
  return {
    initializeSession: new InitializeSession(deps.initializeSession),
    promoteAndLink: new PromoteAndLink(deps.promoteAndLink),
    switchChannel: new SwitchChannel(deps.switchChannel),
    backLinkProcessor: createBackLinkProcessor(deps.backLink),
    mergeDetectionProcessor: createMergeDetectionProcessor(deps.mergeDetection),
    promoteContextProcessor: deps.promoteContext
      ? createPromoteContextProcessor(deps.promoteContext)
      : undefined,
  };
}

/**
 * Create a backfillContactId implementation that updates messages
 * written before the contact was known with the resolved contactId.
 * Wire this into PromoteAndLinkDeps.backfillContactId.
 */
export function createBackfillContactId(): (
  tenantId: string,
  sessionId: string,
  contactId: string,
) => Promise<void> {
  return async (tenantId: string, sessionId: string, contactId: string): Promise<void> => {
    const { Message: MessageModel } = await import('@agent-platform/database/models');
    await MessageModel.updateMany(
      { tenantId, sessionId, $or: [{ contactId: null }, { contactId: { $exists: false } }] },
      { $set: { contactId } },
    );
  };
}
