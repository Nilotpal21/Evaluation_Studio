/**
 * Session Operations
 *
 * Higher-order operations on sessions: fork, bulk ops, etc.
 * These operations work with the SessionService and SessionStateRepo
 * to create derived sessions.
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import type { SessionData, AgentThreadData } from './types.js';
import type { SessionService } from './session-service.js';

const log = createLogger('session-operations');

export interface ForkOptions {
  /** Thread index to fork at (default: all threads up to active) */
  forkAtThreadIndex?: number;
  /** Whether to share factStore references (default: false for user forks) */
  shareFactStore?: boolean;
  /** Optional ID for the forked session (default: generated) */
  forkSessionId?: string;
}

export interface ForkResult {
  sessionId: string;
  parentSessionId: string;
  forkPoint: number;
}

/**
 * Fork a session at a thread boundary.
 *
 * Creates a new session with a copy of the parent's state up to the
 * specified thread. The fork gets its own independent conversation
 * going forward, while the parent session is unaffected.
 *
 * @param sessionService - The session service to use for creation
 * @param parentSession - The parent session data to fork from
 * @param options - Fork configuration
 * @returns ForkResult with the new session ID
 */
export async function forkSession(
  sessionService: SessionService,
  parentSession: SessionData,
  options?: ForkOptions,
): Promise<ForkResult> {
  const forkAtThread = options?.forkAtThreadIndex ?? parentSession.activeThreadIndex;
  const forkSessionId = options?.forkSessionId ?? generateSessionId();

  // Validate thread index
  if (forkAtThread < 0 || forkAtThread >= parentSession.threads.length) {
    throw new Error(
      `Invalid fork thread index ${forkAtThread} (session has ${parentSession.threads.length} threads)`,
    );
  }

  // Deep-clone threads up to and including the fork point
  // structuredClone ensures nested objects (gatherProgress, context) are independent copies
  const forkedThreads: AgentThreadData[] = structuredClone(
    parentSession.threads.slice(0, forkAtThread + 1),
  );

  // Build the forked session — reuse parent's auth/identity context
  const forkedSession: SessionData = {
    id: forkSessionId,
    agentName: forkedThreads[forkAtThread].agentName,
    irSourceHash: forkedThreads[forkAtThread].irSourceHash,
    compilationHash: parentSession.compilationHash,
    conversationHistory: forkedThreads[forkAtThread].conversationHistory,
    state: forkedThreads[forkAtThread].state,
    version: 0,
    isComplete: false,
    isEscalated: false,
    transferInitiated: false,
    handoffStack: [...parentSession.handoffStack],
    delegateStack: [],
    handoffReturnInfo: parentSession.handoffReturnInfo
      ? structuredClone(parentSession.handoffReturnInfo)
      : undefined,
    dataValues: structuredClone(parentSession.dataValues),
    dataGatheredKeys: [...parentSession.dataGatheredKeys],
    currentFlowStep: forkedThreads[forkAtThread].currentFlowStep,
    waitingForInput: forkedThreads[forkAtThread].waitingForInput
      ? [...forkedThreads[forkAtThread].waitingForInput!]
      : undefined,
    pendingResponse: forkedThreads[forkAtThread].pendingResponse,
    pendingRichContent: forkedThreads[forkAtThread].pendingRichContent,
    tenantId: parentSession.tenantId,
    projectId: parentSession.projectId,
    deploymentId: parentSession.deploymentId,
    authToken: parentSession.authToken,
    userId: parentSession.userId,
    permissions: parentSession.permissions ? [...parentSession.permissions] : undefined,
    callerContext: parentSession.callerContext,
    environment: parentSession.environment,
    agentVersions: parentSession.agentVersions ? { ...parentSession.agentVersions } : undefined,
    piiVaultData: parentSession.piiVaultData,
    piiRedactionConfig: parentSession.piiRedactionConfig
      ? { ...parentSession.piiRedactionConfig }
      : undefined,
    initialized: parentSession.initialized,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    maxAgeSeconds: parentSession.maxAgeSeconds,
    idleSeconds: parentSession.idleSeconds,
    threads: forkedThreads,
    activeThreadIndex: forkAtThread,
    threadStack: parentSession.threadStack.filter((idx) => idx <= forkAtThread),
    customDimensions: parentSession.customDimensions
      ? { ...parentSession.customDimensions }
      : undefined,
    moduleProvenance: parentSession.moduleProvenance
      ? structuredClone(parentSession.moduleProvenance)
      : undefined,
  };

  // Create the forked session in the store.
  // If the store is a TieredSessionStore, this also persists to cold storage
  // via fire-and-forget — no separate cold write needed.
  await sessionService.store.create(forkedSession);

  log.info('session forked', {
    parentSessionId: parentSession.id,
    forkSessionId,
    forkAtThread,
    threadCount: forkedThreads.length,
  });

  return {
    sessionId: forkSessionId,
    parentSessionId: parentSession.id,
    forkPoint: forkAtThread,
  };
}

function generateSessionId(): string {
  return `fork-${crypto.randomUUID()}`;
}
