/**
 * Diagnostic Engine — orchestrates Tier 1 (compiler), Tier 2 (semantic), Tier 3 (patterns).
 *
 * Entry point: `runDiagnostics(compiledOutput, options)`.
 * Returns a structured DiagnosticReport.
 *
 * Graceful degradation: if a validator throws, its findings are skipped
 * and an error finding is emitted instead.
 */

import type { CompilationOutput, AgentIR } from '@abl/compiler';
import { validateIR } from '@abl/compiler';
import { createLogger } from '@agent-platform/shared-observability';
import type {
  DiagnosticReport,
  DiagnosticSection,
  DiagnosticOptions,
  Finding,
  DiagnosticSeverity,
  DiagnosticCategory,
  ValidatorContext,
} from './types.js';
import { ALL_VALIDATORS } from './semantic-validators.js';
import { classifyArchitecture, detectAntiPatterns } from './pattern-analyzer.js';
import { getFixTemplate } from './fix-templates.js';

const log = createLogger('arch-ai:diagnostic-engine');

const MAX_TOP_ISSUES = 10;
const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  handoff: 'Handoff Contracts',
  delegation: 'Delegation',
  completion: 'Completion Logic',
  flow: 'Flow Semantics',
  constraint: 'Constraints',
  guardrail: 'Guardrails',
  tool: 'Tool Configuration',
  gather: 'Data Collection (GATHER)',
  memory: 'Memory',
  execution: 'Execution Config',
  routing: 'Routing',
  'behavior-profile': 'Behavior Profiles',
  template: 'Templates',
  pattern: 'Architecture Patterns',
  naming: 'Naming',
  other: 'Other',
};

/**
 * Run the full diagnostic engine on compiled output.
 *
 * @param compiled - Output from compileABLtoIR()
 * @param options - Depth, agent filter, focus category
 */
export function runDiagnostics(
  compiled: CompilationOutput,
  options: DiagnosticOptions = { depth: 'deep' },
): DiagnosticReport {
  const agents = compiled.agents ?? {};
  const agentNames = Object.keys(agents);
  const maxFindings = options.maxFindings ?? 100;
  const isSingleAgentScope = Boolean(options.agentName) || options.skipCrossAgentPatterns === true;

  // If filtering by agent, narrow the scope
  let scopedAgents = agents;
  if (options.agentName) {
    const agent = agents[options.agentName];
    if (agent) {
      scopedAgents = { [options.agentName]: agent };
    }
  }

  const ctx: ValidatorContext = {
    agents: scopedAgents,
    entryAgent: options.entryAgent ?? compiled.entry_agent,
    agentNames,
  };

  const allFindings: Finding[] = [];

  // ── Tier 1: Compiler structural validators ─────────────────────────
  for (const [name, agent] of Object.entries(scopedAgents)) {
    const allAgentsList = Object.values(agents);
    const diagnostics = safeValidateIR(agent, allAgentsList, name, isSingleAgentScope);
    allFindings.push(...diagnostics);
  }

  // ── Tier 2: Semantic validators (deep mode only) ───────────────────
  if (options.depth === 'deep') {
    for (const validator of ALL_VALIDATORS) {
      try {
        const findings = validator.fn(ctx);
        allFindings.push(...findings);
      } catch (err: unknown) {
        // Graceful degradation: report validator failure as a warning finding
        // (not 'info' — an exception is not informational) and log for ops visibility.
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn('Semantic validator threw', {
          validator: validator.name,
          error: errorMessage,
        });
        allFindings.push({
          code: 'VALIDATOR_ERROR',
          message: `Semantic validator "${validator.name}" threw: ${errorMessage} — skipped`,
          severity: 'warning',
          category: 'other',
          agentName: null,
        });
      }
    }
  }

  // ── Filter by focus category if specified ───────────────────────────
  let filtered = allFindings;
  if (options.focus) {
    filtered = allFindings.filter((f) => f.category === options.focus);
  }

  // Attach fix templates where available
  for (const finding of filtered) {
    if (!finding.fix) {
      const template = getFixTemplate(finding.code);
      if (template) {
        finding.fix = template;
      }
    }
  }

  // Sort by severity (errors first), then by category
  filtered.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return (a.category ?? '').localeCompare(b.category ?? '');
  });

  const filteredBeforeLimit = [...filtered];
  const errorCodes = collectFindingCodes(filteredBeforeLimit, 'error');
  const warningCodes = collectFindingCodes(filteredBeforeLimit, 'warning');

  // Limit total findings — track truncation for callers
  const isTruncated = filtered.length > maxFindings;
  const totalBeforeTruncation = filtered.length;
  if (isTruncated) {
    filtered = filtered.slice(0, maxFindings);
  }

  // ── Tier 3: Pattern analysis (deep mode, full project scope) ───────
  // Cross-agent patterns (orphaned agents, topology) are meaningless when
  // running on single-agent compile output — skip to avoid false positives.
  const architecturePattern =
    options.depth === 'deep' && !isSingleAgentScope
      ? classifyArchitecture({ agents, entryAgent: compiled.entry_agent, agentNames })
      : ('unknown' as const);

  const antiPatterns =
    options.depth === 'deep' && !isSingleAgentScope
      ? detectAntiPatterns({ agents, entryAgent: compiled.entry_agent, agentNames })
      : [];

  // ── Build report ───────────────────────────────────────────────────
  const sections = buildSections(filtered);
  const summary = countBySeverity(filtered);

  return {
    generatedAt: new Date().toISOString(),
    overallSeverity: summary.errors > 0 ? 'error' : summary.warnings > 0 ? 'warning' : 'info',
    summary,
    sections,
    topIssues: filtered.slice(0, MAX_TOP_ISSUES),
    errorCodes,
    warningCodes,
    architecturePattern,
    antiPatterns,
    agentSummary: buildAgentSummary(filtered, agentNames),
    isTruncated,
    totalFindings: totalBeforeTruncation,
  };
}

function collectFindingCodes(findings: Finding[], severity: DiagnosticSeverity): string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.severity === severity)
        .map((finding) => finding.code)
        .filter((code) => code.length > 0),
    ),
  ];
}

/** Wrap compiler validateIR with error handling and finding conversion. */
function safeValidateIR(
  agent: AgentIR,
  allAgents: AgentIR[],
  agentName: string,
  singleAgentScope: boolean,
): Finding[] {
  try {
    const diagnostics = validateIR(agent, allAgents, { singleAgentScope });
    return diagnostics.map((d) => ({
      code: d.code ?? 'STRUCTURAL',
      message: d.message,
      severity: (d.severity ?? 'warning') as DiagnosticSeverity,
      category: mapValidationCodeToCategory(d.code),
      agentName,
      path: d.path,
    }));
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn('Tier 1 compiler validation threw', { agentName, error: errorMessage });
    return [
      {
        code: 'TIER1_ERROR',
        message: `Compiler validation threw for agent "${agentName}" — structural checks skipped: ${errorMessage}`,
        severity: 'warning',
        category: 'other',
        agentName,
      },
    ];
  }
}

/** Map compiler validation codes to diagnostic categories. */
function mapValidationCodeToCategory(code?: string): DiagnosticCategory {
  if (!code) return 'other';
  if (code.includes('FLOW') || code.includes('STEP') || code.includes('ENTRY_POINT')) return 'flow';
  if (code.includes('HANDOFF') || code.includes('DELEGATE') || code.includes('ROUTING'))
    return 'handoff';
  if (code.includes('TOOL')) return 'tool';
  if (code.includes('GATHER') || code.includes('DEPENDS_ON') || code.includes('COLLECT_FIELD'))
    return 'gather';
  if (code.includes('MEMORY') || code.includes('PERSISTENT')) return 'memory';
  if (code.includes('GUARDRAIL')) return 'guardrail';
  if (code.includes('VARIABLE') || code.includes('CONDITION')) return 'constraint';
  if (code.includes('RECALL')) return 'memory';
  return 'other';
}

/** Group findings into sections by category. */
function buildSections(findings: Finding[]): DiagnosticSection[] {
  const byCategory = new Map<DiagnosticCategory, Finding[]>();
  for (const f of findings) {
    const existing = byCategory.get(f.category) ?? [];
    existing.push(f);
    byCategory.set(f.category, existing);
  }

  const sections: DiagnosticSection[] = [];
  for (const [category, categoryFindings] of byCategory) {
    const worstSeverity = categoryFindings.reduce<DiagnosticSeverity>(
      (worst, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst] ? f.severity : worst),
      'info',
    );
    sections.push({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      findings: categoryFindings,
      severity: worstSeverity,
    });
  }

  // Sort sections: errors first, then warnings, then info
  sections.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return sections;
}

/** Count findings by severity. */
function countBySeverity(findings: Finding[]): {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos, total: findings.length };
}

/** Build per-agent summary counts. */
function buildAgentSummary(
  findings: Finding[],
  agentNames: string[],
): Record<string, { errors: number; warnings: number; infos: number }> {
  const summary: Record<string, { errors: number; warnings: number; infos: number }> = {};
  for (const name of agentNames) {
    summary[name] = { errors: 0, warnings: 0, infos: 0 };
  }
  for (const f of findings) {
    if (f.agentName && summary[f.agentName]) {
      if (f.severity === 'error') summary[f.agentName].errors++;
      else if (f.severity === 'warning') summary[f.agentName].warnings++;
      else summary[f.agentName].infos++;
    }
  }
  return summary;
}
