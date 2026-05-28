import { createLogger } from '@abl/compiler/platform';
import type {
  Analyzer,
  DiagnosticContext,
  DiagnosticDepth,
  DiagnosticFinding,
  DiagnosticReport,
} from './types.js';
import { classifyCanonicalConfigurationFinding } from './configuration-taxonomy.js';

const log = createLogger('diagnostic-engine');

/**
 * Unified Diagnostic Engine
 *
 * Runs pluggable analyzers against a target (agent or session)
 * and produces a single DiagnosticReport.
 */
export class DiagnosticEngine {
  private analyzers: Analyzer[] = [];

  register(analyzer: Analyzer): void {
    this.analyzers.push(analyzer);
  }

  async diagnose(context: DiagnosticContext): Promise<DiagnosticReport> {
    const applicableAnalyzers = this.getAnalyzersForDepth(context.depth);
    const analyzersRun: string[] = [];
    const allFindings: DiagnosticFinding[] = [];

    for (const analyzer of applicableAnalyzers) {
      try {
        analyzersRun.push(analyzer.name);
        const findings = await analyzer.analyze(context);
        allFindings.push(...findings.map(annotateCanonicalConfigurationFinding));
      } catch (err) {
        log.warn('Analyzer failed', {
          analyzer: analyzer.name,
          error: err instanceof Error ? err.message : String(err),
        });
        allFindings.push(
          annotateCanonicalConfigurationFinding({
            analyzer: analyzer.name,
            severity: 'warning',
            code: 'ANALYZER_FAILED',
            title: `Analyzer '${analyzer.name}' failed`,
            detail: err instanceof Error ? err.message : String(err),
            suggestion: 'This analyzer encountered an error. Other results are still valid.',
            evidence: [],
          }),
        );
      }
    }

    const errors = allFindings.filter((f) => f.severity === 'error').length;
    const warnings = allFindings.filter((f) => f.severity === 'warning').length;
    const infos = allFindings.filter((f) => f.severity === 'info').length;

    const status = errors > 0 ? 'broken' : warnings > 0 ? 'degraded' : 'healthy';

    return {
      status,
      target: {
        type: context.sessionId ? 'session' : 'agent',
        id: context.sessionId ?? context.agentName ?? 'unknown',
        agentName: context.agentName ?? 'unknown',
      },
      findings: allFindings.sort((a, b) => {
        const order = { error: 0, warning: 1, info: 2 };
        return order[a.severity] - order[b.severity];
      }),
      summary: { errors, warnings, infos, analyzersRun },
      config: {},
      timestamp: new Date().toISOString(),
    };
  }

  private getAnalyzersForDepth(depth: DiagnosticDepth): Analyzer[] {
    switch (depth) {
      case 'quick':
        return this.analyzers.filter((a) => a.category === 'infra');
      case 'standard':
        return this.analyzers.filter((a) => a.category !== 'behavioral');
      case 'deep':
      default:
        return this.analyzers;
    }
  }
}

function annotateCanonicalConfigurationFinding(finding: DiagnosticFinding): DiagnosticFinding {
  const canonical = classifyCanonicalConfigurationFinding(finding);
  return canonical ? { ...finding, canonical } : finding;
}

let instance: DiagnosticEngine | null = null;
let registrationPromise: Promise<void> | null = null;

export function getDiagnosticEngine(): DiagnosticEngine {
  if (!instance) {
    instance = new DiagnosticEngine();
    // Register analyzers lazily to avoid circular imports at module load
    registrationPromise = registerAnalyzers(instance);
  }
  return instance;
}

/**
 * Ensure analyzers are registered before running diagnostics.
 * Call this before `engine.diagnose()` to avoid race conditions
 * where the singleton is created but analyzers haven't loaded yet.
 */
export async function ensureAnalyzersReady(): Promise<void> {
  if (registrationPromise) {
    await registrationPromise;
    registrationPromise = null;
  }
}

async function registerAnalyzers(engine: DiagnosticEngine): Promise<void> {
  try {
    const { ModelResolutionAnalyzer } = await import('./analyzers/model-resolution.js');
    engine.register(new ModelResolutionAnalyzer());
  } catch (err) {
    log.warn('Failed to register ModelResolutionAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { CredentialChainAnalyzer } = await import('./analyzers/credential-chain.js');
    engine.register(new CredentialChainAnalyzer());
  } catch (err) {
    log.warn('Failed to register CredentialChainAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { ToolBindingAnalyzer } = await import('./analyzers/tool-binding.js');
    engine.register(new ToolBindingAnalyzer());
  } catch (err) {
    log.warn('Failed to register ToolBindingAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { EncryptionAvailabilityAnalyzer } =
      await import('./analyzers/encryption-availability.js');
    engine.register(new EncryptionAvailabilityAnalyzer());
  } catch (err) {
    log.warn('Failed to register EncryptionAvailabilityAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { ExecutionStatusAnalyzer } = await import('./analyzers/execution-status.js');
    engine.register(new ExecutionStatusAnalyzer());
  } catch (err) {
    log.warn('Failed to register ExecutionStatusAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { EmptyResponseAnalyzer } = await import('./analyzers/empty-response.js');
    engine.register(new EmptyResponseAnalyzer());
  } catch (err) {
    log.warn('Failed to register EmptyResponseAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { FlowStateAnalyzer } = await import('./analyzers/flow-state.js');
    engine.register(new FlowStateAnalyzer());
  } catch (err) {
    log.warn('Failed to register FlowStateAnalyzer', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
