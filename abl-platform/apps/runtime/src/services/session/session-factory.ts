/**
 * Session Factory
 *
 * Transport-agnostic session creation. Extracts session creation logic
 * from sdk-handler.ts and handler.ts into a reusable service.
 *
 * Used by:
 * - SDK WebSocket handler (embedded widget connections)
 * - Internal WebSocket handler (debug/test UI)
 * - HTTP chat endpoint (REST API)
 */

import { createLogger } from '@abl/compiler/platform';
import {
  getRuntimeExecutor,
  compileToResolvedAgent,
  resolveProjectTools,
  type RuntimeSession,
} from '../runtime-executor.js';
import type { SessionLocator } from './execution-scope.js';
import type { HydratedSession } from './types.js';
import { getSessionService } from './session-service.js';
import { loadConfigVariablesMap } from '../../repos/project-repo.js';
import {
  buildSessionLocalizationCatalog,
  storeRuntimeSessionLocalizationCatalog,
} from '../execution/localized-messages.js';

const log = createLogger('session-factory');

// =============================================================================
// SESSION FACTORY
// =============================================================================

export interface CreateSessionOptions {
  channel?: string;
  sessionIdPrefix?: string;
  tenantId?: string;
  projectId?: string;
}

export class SessionFactory {
  /**
   * Create a session from one or more DSL strings.
   * Compiles from working copy — use DeploymentResolver for production.
   */
  async createFromDSLs(
    dsls: string[],
    entryAgentName: string,
    options?: CreateSessionOptions,
  ): Promise<RuntimeSession> {
    const executor = getRuntimeExecutor();
    let configVariables: Record<string, string> | undefined;

    // Resolve tool implementations from DB before compilation (baked into IR)
    const resolvedTools =
      options?.tenantId && options?.projectId
        ? await resolveProjectTools(options.tenantId, options.projectId, dsls)
        : undefined;

    if (options?.tenantId && options?.projectId) {
      try {
        const loaded = await loadConfigVariablesMap(options.projectId, options.tenantId);
        if (Object.keys(loaded).length > 0) {
          configVariables = loaded;
        }
      } catch (err) {
        log.warn('Failed to load config variables for session-factory compile path', {
          projectId: options.projectId,
          tenantId: options.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        configVariables = undefined;
      }
    }

    const runtimeSession = executor.createSessionFromResolved(
      compileToResolvedAgent(dsls, entryAgentName, configVariables, resolvedTools),
      {
        channelType: options?.channel,
        tenantId: options?.tenantId,
        projectId: options?.projectId,
      },
    );
    storeRuntimeSessionLocalizationCatalog(
      runtimeSession,
      buildSessionLocalizationCatalog(configVariables),
    );

    return runtimeSession;
  }

  /**
   * Register additional agents for handoff/delegate support.
   *
   * Callers in request handlers should pass `scope` so the registration lands
   * in the composite-key store. Omitting scope falls back to the legacy flat
   * registry — only appropriate for test harnesses.
   */
  registerAgent(
    agentName: string,
    dsl: string,
    scope?: { tenantId?: string; projectId: string; version: string },
  ): void {
    const executor = getRuntimeExecutor();
    executor.registerAgent(agentName, dsl, scope);
  }

  /**
   * Check if a session exists and can be resumed (e.g., on WebSocket reconnect).
   * Returns the session if it exists, null if not.
   */
  async resumeSession(
    sessionIdOrLocator: string | SessionLocator,
  ): Promise<HydratedSession | null> {
    const svc = getSessionService();
    if (typeof sessionIdOrLocator === 'string') {
      return svc.loadSession(sessionIdOrLocator);
    }
    return svc.loadSessionScoped(sessionIdOrLocator);
  }

  /**
   * Get a runtime session by ID (from in-memory executor).
   * For immediate access during the same pod's execution.
   */
  getSession(sessionId: string): RuntimeSession | undefined {
    const executor = getRuntimeExecutor();
    return executor.getSession(sessionId);
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let factoryInstance: SessionFactory | null = null;

export function getSessionFactory(): SessionFactory {
  if (!factoryInstance) {
    factoryInstance = new SessionFactory();
  }
  return factoryInstance;
}

export function resetSessionFactory(): void {
  factoryInstance = null;
}
