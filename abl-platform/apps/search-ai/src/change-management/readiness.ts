import type { RequestHandler } from 'express';
import type { ServiceChangeCompatibilityResult } from '@agent-platform/database';

export interface SearchAiReadinessDependencies {
  isShuttingDown(): boolean;
  isDatabaseReady(): boolean;
  loadCompatibility(): Promise<ServiceChangeCompatibilityResult | null>;
  onHardFail?(result: ServiceChangeCompatibilityResult): void;
}

function buildCompatibilityPayload(result: ServiceChangeCompatibilityResult) {
  return {
    service: result.service,
    environment: result.environment,
    enforcementMode: result.enforcementMode,
    outcome: result.outcome,
    shouldExit: result.shouldExit,
    blockers: result.blockingIssues,
    warnings: result.warningIssues,
  };
}

export function createSearchAiReadinessHandler(
  dependencies: SearchAiReadinessDependencies,
): RequestHandler {
  return async (_req, res) => {
    if (dependencies.isShuttingDown()) {
      return res.status(503).json({ ok: false, reason: 'shutting_down' });
    }

    if (!dependencies.isDatabaseReady()) {
      return res.status(503).json({ ok: false, reason: 'database_not_ready' });
    }

    let compatibility: ServiceChangeCompatibilityResult | null = null;
    try {
      compatibility = await dependencies.loadCompatibility();
    } catch {
      return res.status(503).json({ ok: false, reason: 'change_gate_unavailable' });
    }

    if (compatibility && !compatibility.ready) {
      if (compatibility.shouldExit) {
        dependencies.onHardFail?.(compatibility);
      }

      return res.status(503).json({
        ok: false,
        reason: 'change_incompatible',
        changeManagement: buildCompatibilityPayload(compatibility),
      });
    }

    const responseBody: {
      ok: true;
      changeManagement?: ReturnType<typeof buildCompatibilityPayload>;
    } = { ok: true };

    if (
      compatibility &&
      (compatibility.warningIssues.length > 0 || compatibility.outcome !== 'ready')
    ) {
      responseBody.changeManagement = buildCompatibilityPayload(compatibility);
    }

    return res.json(responseBody);
  };
}
