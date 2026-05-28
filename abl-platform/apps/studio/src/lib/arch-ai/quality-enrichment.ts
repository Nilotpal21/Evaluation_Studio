import { createLogger } from '@abl/compiler/platform/logger.js';
import { renderDefaultContentSafetyGuardrail } from '@agent-platform/arch-ai/guardrails';

const log = createLogger('arch-ai:enrichment');

// =============================================================================
// TYPES
// =============================================================================

export interface AgentSpec {
  name: string;
  role: string;
  executionMode: string;
  isEntry: boolean;
  tools?: string[];
  gatherFields?: string[];
}

export interface SensitivityResult {
  categories: string[];
  evidence: string[];
}

export interface EnrichmentResult {
  enrichedAbl: string;
  /** Section keywords that were injected, e.g. ['GUARDRAILS', 'MEMORY'] */
  injectedSections: string[];
  warnings: string[];
}

// =============================================================================
// SECTION PRESENCE CHECK
// =============================================================================

/**
 * Returns true when the entire section (header keyword) is absent from the ABL
 * content. Partial or weak existing sections are left untouched — only inject
 * when the keyword does not appear at all.
 */
function isSectionMissing(abl: string, sectionName: string): boolean {
  return !new RegExp(`^${sectionName}:`, 'm').test(abl);
}

// =============================================================================
// SECTION BUILDERS
// =============================================================================

function buildGuardrailsSection(): string {
  return renderDefaultContentSafetyGuardrail();
}

function buildMemorySection(spec: AgentSpec): string {
  const lines: string[] = [
    'MEMORY:',
    '  session:',
    '    - name: interaction_count',
    '      type: number',
    '      initial_value: 0',
  ];

  if (spec.role === 'supervisor') {
    lines.push(
      '    - name: routing_count',
      '      type: number',
      '      initial_value: 0',
      '    - name: last_routed_agent',
      '      type: string',
      '      initial_value: ""',
    );
  }

  return lines.join('\n');
}

function buildErrorHandlersSection(): string {
  return [
    'ON_ERROR:',
    '  - TOOL: DEFAULT',
    '    RETRY: 2',
    '    BACKOFF: exponential',
    '    RESPOND: "I hit a temporary issue while handling that action. Please try again."',
  ].join('\n');
}

// =============================================================================
// ABL SECTION NAME SANITIZER
// =============================================================================

/**
 * Converts LLM-generated section names that the handbook teaches but the
 * parser doesn't recognize into their parser-supported equivalents.
 *
 * The ABL handbook documents ERROR_HANDLERS: and INTENT_HANDLING: but the
 * parser only recognizes ON_ERROR: and FLOW: (with global_digressions).
 * LLMs follow the handbook, so we fix up the output before parsing.
 */
const SECTION_ALIASES: Array<[RegExp, string]> = [
  [/^ERROR_HANDLERS:/gm, 'ON_ERROR:'],
  [/^INTENT_HANDLING:/gm, 'NLU:'],
];

export function sanitizeAblSections(abl: string): string {
  let result = abl;
  for (const [pattern, replacement] of SECTION_ALIASES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// =============================================================================
// DATA SENSITIVITY CHECK
// =============================================================================

function isDataSensitive(sensitivityResult: SensitivityResult): boolean {
  return !sensitivityResult.categories.every((c) => c === 'general');
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * enrichAgent — "quality presence floor" enrichment.
 *
 * Deterministically injects missing critical ABL sections into LLM-generated
 * agent code. Only injects when the ENTIRE section keyword is absent — partial
 * or weak existing sections are left untouched.
 *
 * Sections are appended in order: GUARDRAILS → MEMORY → ON_ERROR.
 * We intentionally avoid auto-injecting CONSTRAINTS or COMPLETE because those
 * constructs must reference the agent's real runtime state to be safe.
 */
export function enrichAgent(
  ablContent: string,
  agentSpec: AgentSpec,
  sensitivityResult: SensitivityResult,
  complianceRegulations: string[],
): EnrichmentResult {
  const injectedSections: string[] = [];
  const warnings: string[] = [];
  const appendedBlocks: string[] = [];

  // 1. GUARDRAILS — always inject if missing
  if (isSectionMissing(ablContent, 'GUARDRAILS')) {
    appendedBlocks.push(buildGuardrailsSection());
    injectedSections.push('GUARDRAILS');
    log.info('Injecting GUARDRAILS section', { agentName: agentSpec.name });
  }

  // 2. MEMORY — always inject if missing
  if (isSectionMissing(ablContent, 'MEMORY')) {
    appendedBlocks.push(buildMemorySection(agentSpec));
    injectedSections.push('MEMORY');
    log.info('Injecting MEMORY section', { agentName: agentSpec.name });
  }

  // 3. ON_ERROR — inject if agent has tools AND section is missing
  // The parser recognizes ON_ERROR: (not ERROR_HANDLERS:)
  if (
    agentSpec.tools &&
    agentSpec.tools.length > 0 &&
    isSectionMissing(ablContent, 'ON_ERROR') &&
    isSectionMissing(ablContent, 'ERROR_HANDLERS')
  ) {
    appendedBlocks.push(buildErrorHandlersSection());
    injectedSections.push('ON_ERROR');
    log.info('Injecting ON_ERROR section', { agentName: agentSpec.name });
  }

  // 4. CONSTRAINTS — do not inject generically. Deterministic constraints must
  // reference declared runtime state, which this helper cannot infer safely.
  if (isDataSensitive(sensitivityResult) && isSectionMissing(ablContent, 'CONSTRAINTS')) {
    warnings.push(
      `Skipped automatic CONSTRAINTS injection for "${agentSpec.name}" because deterministic constraints must reference declared GATHER or MEMORY.session fields. Author constraints explicitly for ${complianceRegulations.slice(0, 3).join(', ') || 'the required compliance rules'}.`,
    );
    log.info('Skipping unsafe CONSTRAINTS auto-injection', {
      agentName: agentSpec.name,
      categories: sensitivityResult.categories,
      regulations: complianceRegulations,
    });
  }

  // 5. COMPLETE — do not inject generically. Completion conditions must be
  // authored against the agent's real state path to avoid invalid or unreachable
  // runtime behavior.
  if (agentSpec.role !== 'supervisor' && isSectionMissing(ablContent, 'COMPLETE')) {
    warnings.push(
      `Skipped automatic COMPLETE injection for "${agentSpec.name}" because generic completion conditions are unsafe. Add COMPLETE explicitly when the agent needs a return or terminal condition.`,
    );
    log.info('Skipping unsafe COMPLETE auto-injection', {
      agentName: agentSpec.name,
      gatherFieldCount: agentSpec.gatherFields?.length ?? 0,
      executionMode: agentSpec.executionMode,
    });
  }

  if (injectedSections.length === 0) {
    return { enrichedAbl: ablContent, injectedSections: [], warnings };
  }

  // ABL is flat (no nesting across sections) — appending is safe
  const enrichedAbl = [ablContent.trimEnd(), ...appendedBlocks].join('\n\n') + '\n';

  return { enrichedAbl, injectedSections, warnings };
}
