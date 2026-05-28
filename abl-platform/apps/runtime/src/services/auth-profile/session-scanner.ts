/**
 * Auth Profile Session Scanner
 *
 * Walks an AgentIR to discover all auth profile references across tools,
 * then classifies each by usageMode:
 *   - preconfigured: validate stored token; if expired, attempt refresh
 *   - jit / user_token: deferred until first use
 *   - preflight: requires upfront consent
 *
 * Called during session bootstrap (gated by AUTH_PROFILE_SESSION_SCAN_ENABLED).
 * Satisfies FR-11: usageMode applies everywhere it is referenced.
 */

import type { AgentIR, ToolDefinition } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import {
  emitAuthProfileTraceEvent,
  refreshOAuth2Token,
  needsProactiveRefresh,
} from '@agent-platform/shared/services/auth-profile';
import {
  resolveAuthProfileUsageMode,
  type AuthProfileUsageMode,
} from '@agent-platform/shared/validation';

// ─── Types ────────────────────────────────────────────────────────────

export interface SessionScanResult {
  preconfigured: Array<{
    profileId: string;
    status: 'valid' | 'refreshed' | 'failed';
    error?: string;
  }>;
  jit: Array<{ profileId: string; deferredUntilFirstUse: true }>;
  preflight: Array<{ profileId: string; requiresUpfrontConsent: true }>;
  issues: Array<{ profileId: string; code: string; message: string }>;
  /** Profile IDs that were originally preflight but degraded to JIT (e.g. user declined prompt). */
  degradedFromPreflight: string[];
}

export interface ScanContext {
  tenantId: string;
  projectId: string;
  userId: string;
}

/** Minimal profile document shape needed for scanning. */
export interface ScannableProfile {
  _id: string;
  authType: string;
  usageMode?: AuthProfileUsageMode;
  encryptedSecrets: string;
  config: Record<string, unknown>;
  expiresAt?: Date | null;
}

/** Dependency injection ports for testability. */
export interface SessionScannerDeps {
  findProfile: (profileId: string, tenantId: string) => Promise<ScannableProfile | null>;
  getRedis: () => RedisClient | null;
}

const log = createLogger('auth-profile-session-scanner');

// ─── IR Walker ────────────────────────────────────────────────────────

/**
 * Walk all tools in the AgentIR (including behavior profile tool additions)
 * and collect unique auth profile references.
 */
export function collectAuthProfileRefs(ir: AgentIR): string[] {
  const seen = new Set<string>();

  function addTool(tool: ToolDefinition): void {
    if (tool.auth_profile_ref && !tool.auth_profile_ref.includes('{{')) {
      seen.add(tool.auth_profile_ref);
    }
  }

  // Base tools
  for (const tool of ir.tools) {
    addTool(tool);
  }

  // Behavior profile tool additions
  if (ir.behavior_profiles) {
    for (const profile of ir.behavior_profiles) {
      if (profile.tools_add) {
        for (const tool of profile.tools_add) {
          addTool(tool);
        }
      }
    }
  }

  return [...seen];
}

// ─── Scanner ──────────────────────────────────────────────────────────

export class AuthProfileSessionScanner {
  private readonly deps: SessionScannerDeps;

  constructor(deps: SessionScannerDeps) {
    this.deps = deps;
  }

  async scan(ir: AgentIR, ctx: ScanContext): Promise<SessionScanResult> {
    const profileRefs = collectAuthProfileRefs(ir);

    const result: SessionScanResult = {
      preconfigured: [],
      jit: [],
      preflight: [],
      issues: [],
      degradedFromPreflight: [],
    };

    if (profileRefs.length === 0) {
      emitAuthProfileTraceEvent({
        eventType: 'auth_profile.session_init.scan_completed',
        profileId: '',
        tenantId: ctx.tenantId,
        timestamp: new Date().toISOString(),
        metadata: { profileCount: 0, projectId: ctx.projectId },
      });
      return result;
    }

    for (const ref of profileRefs) {
      await this.classifyProfile(ref, ctx, result);
    }

    emitAuthProfileTraceEvent({
      eventType: 'auth_profile.session_init.scan_completed',
      profileId: '',
      tenantId: ctx.tenantId,
      timestamp: new Date().toISOString(),
      metadata: {
        profileCount: profileRefs.length,
        projectId: ctx.projectId,
        preconfiguredCount: result.preconfigured.length,
        jitCount: result.jit.length,
        preflightCount: result.preflight.length,
        issueCount: result.issues.length,
      },
    });

    return result;
  }

  private async classifyProfile(
    profileRef: string,
    ctx: ScanContext,
    result: SessionScanResult,
  ): Promise<void> {
    // profileRef is a name — need to resolve to the actual profile
    // For session scanner, we look up by name to get the profile doc
    const profile = await this.deps.findProfile(profileRef, ctx.tenantId);

    if (!profile) {
      result.issues.push({
        profileId: profileRef,
        code: 'PROFILE_NOT_FOUND',
        message: 'Auth profile not found or inactive',
      });
      return;
    }

    const usageMode = resolveAuthProfileUsageMode(profile.authType, profile.usageMode);

    switch (usageMode) {
      case 'preconfigured':
        await this.handlePreconfigured(profile, ctx, result);
        break;
      case 'jit':
      case 'user_token':
        result.jit.push({
          profileId: String(profile._id),
          deferredUntilFirstUse: true,
        });
        break;
      case 'preflight':
        // FR-12 meeting delta: preflight degrades to JIT instead of blocking.
        // The profile is still recorded in preflight[] for observability,
        // but also degraded to JIT so the session does NOT abort.
        result.preflight.push({
          profileId: String(profile._id),
          requiresUpfrontConsent: true,
        });
        // Degrade to JIT — tool call will trigger JIT prompt later
        result.jit.push({
          profileId: String(profile._id),
          deferredUntilFirstUse: true,
        });
        result.degradedFromPreflight.push(String(profile._id));

        log.info('Preflight profile degraded to JIT', {
          profileId: String(profile._id),
          tenantId: ctx.tenantId,
        });

        emitAuthProfileTraceEvent({
          eventType: 'auth_profile.session_init.preflight_degraded',
          profileId: String(profile._id),
          tenantId: ctx.tenantId,
          authType: profile.authType,
          timestamp: new Date().toISOString(),
          metadata: { projectId: ctx.projectId },
        });
        break;
      default:
        // Unknown usageMode — treat as deferred
        result.jit.push({
          profileId: String(profile._id),
          deferredUntilFirstUse: true,
        });
    }
  }

  private async handlePreconfigured(
    profile: ScannableProfile,
    ctx: ScanContext,
    result: SessionScanResult,
  ): Promise<void> {
    const profileId = String(profile._id);

    // Check if the profile needs token refresh (OAuth types)
    const isOAuth =
      profile.authType === 'oauth2_app' || profile.authType === 'oauth2_client_credentials';

    if (isOAuth && profile.expiresAt) {
      const expiresAtStr =
        profile.expiresAt instanceof Date
          ? profile.expiresAt.toISOString()
          : String(profile.expiresAt);
      const shouldRefresh = needsProactiveRefresh(expiresAtStr);

      if (shouldRefresh) {
        try {
          const redis = this.deps.getRedis();
          await refreshOAuth2Token({
            profileId,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            userId: ctx.userId,
            ...(redis ? { redis } : {}),
          });

          emitAuthProfileTraceEvent({
            eventType: 'auth_profile.session_init.preconfigured_resolved',
            profileId,
            tenantId: ctx.tenantId,
            authType: profile.authType,
            timestamp: new Date().toISOString(),
            metadata: { status: 'refreshed' },
          });

          result.preconfigured.push({
            profileId,
            status: 'refreshed',
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('Session scan: preconfigured profile refresh failed', {
            profileId,
            tenantId: ctx.tenantId,
            error: message,
          });

          emitAuthProfileTraceEvent({
            eventType: 'auth_profile.session_init.refresh_failed',
            profileId,
            tenantId: ctx.tenantId,
            authType: profile.authType,
            timestamp: new Date().toISOString(),
            metadata: { error: message },
          });

          result.preconfigured.push({
            profileId,
            status: 'failed',
            error: message,
          });

          result.issues.push({
            profileId,
            code: 'REFRESH_FAILED',
            message: 'Auth profile token refresh failed',
          });
        }
        return;
      }
    }

    // No refresh needed — profile is valid
    emitAuthProfileTraceEvent({
      eventType: 'auth_profile.session_init.preconfigured_resolved',
      profileId,
      tenantId: ctx.tenantId,
      authType: profile.authType,
      timestamp: new Date().toISOString(),
      metadata: { status: 'valid' },
    });

    result.preconfigured.push({
      profileId,
      status: 'valid',
    });
  }
}
