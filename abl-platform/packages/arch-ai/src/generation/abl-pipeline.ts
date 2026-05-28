/**
 * ABL Generation Pipeline
 *
 * Wraps LLM-generated ABL with deterministic pre/post processing:
 * 1. buildSkeleton() — creates mandatory structure based on agent type
 * 2. validatePreCompile() — checks required fields before compilation
 * 3. autoFixABL() — injects missing mandatory sections
 * 4. processGeneratedABL() — full pipeline: validate + autofix
 *
 * All functions are pure — no side effects, no DB, no LLM calls.
 */

import { renderDefaultContentSafetyGuardrail } from '../knowledge/guardrail-contract.js';
import {
  renderDefaultMemorySessionBlock,
  renderDefaultSupervisorCatchAllHandoff,
  renderDelegateMissingCompleteWarning,
  renderDelegateMissingGatherWarning,
  renderHandoffContextPassMissingMemoryWarning,
  renderMissingAgentDeclarationWarning,
  renderMissingConstructWarning,
  renderMissingMemoryWarning,
  renderPciMissingConstraintsWarning,
  renderSupervisorCatchAllHandoffWarning,
  renderSupervisorMissingHandoffWarning,
} from '../knowledge/construct-contract.js';
import {
  resolveArchExecutionModel,
  type ArchAgentModelType,
  type ArchModelClass,
  type ArchModelPolicyDefaults,
} from '../model-policy.js';
import { inferFallbackToolSignature } from '../planning/tool-signature-inference.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentContext {
  name: string;
  type: 'supervisor' | 'specialist' | 'scripted' | 'hybrid';
  role: string;
  domain?: string;
  model?: string;
  modelPolicy?: {
    agentType?: ArchAgentModelType;
    reasoningRequired?: boolean;
    defaultModelClass?: ArchModelClass;
  };
  tools?: Array<{
    name: string;
    description: string;
    signature?: string;
    sideEffects?: boolean;
    consentAction?: string;
    consentScope?: string[];
  }>;
  handoffTargets?: Array<{
    name: string;
    returnExpected: boolean;
    experienceMode?:
      | 'shared_voice_handoff'
      | 'visible_handoff'
      | 'silent_delegate'
      | 'human_escalation';
  }>;
  /** Agents that hand off TO this one */
  handoffSources?: string[];
  pciCompliant?: boolean;
}

export interface ABLValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  autoFixable: boolean;
  /** The YAML snippet to inject when auto-fixing */
  fix?: string;
}

export interface PipelineResult {
  yaml: string;
  issues: ABLValidationIssue[];
  autoFixed: string[];
  skipped: string[];
}

export interface BuildSkeletonOptions {
  modelDefaults?: ArchModelPolicyDefaults;
}

// ---------------------------------------------------------------------------
// Constants — default YAML blocks
// ---------------------------------------------------------------------------

const DEFAULT_GUARDRAILS = renderDefaultContentSafetyGuardrail();

const DEFAULT_MEMORY_SESSION = renderDefaultMemorySessionBlock();

const DEFAULT_DELEGATE_GATHER_FIELD = 'gathered_detail';
const DEFAULT_DELEGATE_GATHER_PROMPT_PLACEHOLDER = '{{customer_prompt}}';
const EMPTY_CUSTOMER_RESPONSE = '""';

const SIDE_EFFECT_TOOL_PATTERN =
  /\b(apply|approve|assign|book|cancel|charge|close|create|delete|execute|finalize|initiate|issue|provision|refund|replace|replacement|request|schedule|send|submit|transfer|update|write)\b/i;

const READ_ONLY_TOOL_PREFIX_PATTERN =
  /^(authenticate|calculate|check|classify|diagnose|fetch|find|get|list|load|lookup|parse|read|screen|score|search|validate|verify)(_|$)/i;

const CONSENT_SCOPE_PRIORITY = [
  'order_id',
  'invoice_id',
  'account_id',
  'customer_id',
  'case_id',
  'ticket_id',
  'transaction_id',
  'payment_id',
  'refund_amount',
  'credit_amount',
  'amount',
];

function buildDelegateGatherSection(fieldName: string = DEFAULT_DELEGATE_GATHER_FIELD): string {
  return `GATHER:
  ${fieldName}:
    type: string
    required: true
    prompt: "${DEFAULT_DELEGATE_GATHER_PROMPT_PLACEHOLDER}"`;
}

function buildDelegateComplete(fieldName: string = DEFAULT_DELEGATE_GATHER_FIELD): string {
  return `COMPLETE:
  - WHEN: ${fieldName} != null
    RESPOND: ${EMPTY_CUSTOMER_RESPONSE}`;
}

// ---------------------------------------------------------------------------
// Skeleton builders
// ---------------------------------------------------------------------------

function isSideEffectingTool(tool: NonNullable<AgentContext['tools']>[number]): boolean {
  if (tool.sideEffects !== undefined) return tool.sideEffects;
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  if (READ_ONLY_TOOL_PREFIX_PATTERN.test(tool.name)) {
    return SIDE_EFFECT_TOOL_PATTERN.test(text) && !/^get|lookup|search|fetch|list/i.test(tool.name);
  }
  return SIDE_EFFECT_TOOL_PATTERN.test(text);
}

function parseSignatureParamNames(signature: string | undefined): string[] {
  if (!signature) return [];
  const params = signature.match(/\(([^)]*)\)/)?.[1];
  if (!params) return [];
  return params
    .split(',')
    .map((param) => param.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function inferConsentAction(tool: NonNullable<AgentContext['tools']>[number]): string {
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  if (/\b(replacement|replace|resend)\b/.test(text)) return 'replacement';
  if (/\brefund\b/.test(text)) return 'refund';
  if (/\bcredit\b/.test(text)) return 'credit';
  if (/\b(charge|payment|pay)\b/.test(text)) return 'payment';
  if (/\b(book|booking|reservation|appointment|schedule)\b/.test(text)) return 'booking';
  if (/\bcancel\b/.test(text)) return 'cancellation';
  return tool.name.replace(/_/g, ' ');
}

function inferConsentScope(tool: NonNullable<AgentContext['tools']>[number]): string[] {
  if (tool.consentScope && tool.consentScope.length > 0) return tool.consentScope;
  const params = parseSignatureParamNames(tool.signature);
  if (params.length === 0) return [];
  return CONSENT_SCOPE_PRIORITY.filter((field) => params.includes(field));
}

function buildToolConfirmationLines(tool: NonNullable<AgentContext['tools']>[number]): string[] {
  if (!isSideEffectingTool(tool)) return [];
  const scope = inferConsentScope(tool);
  const lines = ['    side_effects: true', '    confirm: when_side_effects'];
  if (scope.length > 0) {
    lines.push(`    immutable: [${scope.join(', ')}]`);
  }
  lines.push('    consent_required_in: conversation');
  if (scope.length > 0) {
    lines.push(`    consent_scope: [${scope.join(', ')}]`);
  }
  lines.push(`    consent_action: "${tool.consentAction ?? inferConsentAction(tool)}"`);
  lines.push('    consent_fallback: explicit_prompt');
  return lines;
}

function buildToolEntries(tools: AgentContext['tools'] | undefined): string {
  if (!tools || tools.length === 0) return '';
  const lines = tools
    .map((t) => {
      const signature = t.signature ?? inferFallbackToolSignature(t.name);
      return [
        `  ${signature}`,
        `    description: "${t.description}"`,
        ...buildToolConfirmationLines(t),
      ].join('\n');
    })
    .join('\n');
  return `TOOLS:\n${lines}`;
}

function buildExecutionSection(ctx: AgentContext, options: BuildSkeletonOptions = {}): string {
  return `EXECUTION:
  model: ${resolveArchExecutionModel({
    explicitModel: ctx.model,
    modelPolicy: ctx.modelPolicy,
    modelDefaults: options.modelDefaults,
  })}`;
}

function buildHandoffEntries(
  targets:
    | Array<{
        name: string;
        returnExpected: boolean;
        experienceMode?:
          | 'shared_voice_handoff'
          | 'visible_handoff'
          | 'silent_delegate'
          | 'human_escalation';
      }>
    | undefined,
): string {
  if (!targets || targets.length === 0) return '';
  const entries = targets.map((t) => {
    const experienceMode = t.experienceMode ? `\n    EXPERIENCE_MODE: ${t.experienceMode}` : '';
    return `  - TO: ${t.name}\n    WHEN: intent.category == "${toIntentCategory(t.name)}"${experienceMode}\n    RETURN: ${t.returnExpected}`;
  });
  return entries.join('\n');
}

function toIntentCategory(agentName: string): string {
  return agentName
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function buildSupervisorSkeleton(ctx: AgentContext, options: BuildSkeletonOptions): string {
  const handoffBody = buildHandoffEntries(ctx.handoffTargets);
  const defaultTarget =
    ctx.handoffTargets && ctx.handoffTargets.length > 0
      ? ctx.handoffTargets[0].name
      : 'DefaultAgent';

  const handoffSection = handoffBody
    ? `HANDOFF:\n${handoffBody}\n  - TO: ${defaultTarget}\n    WHEN: true\n    RETURN: true`
    : `HANDOFF:\n  - TO: ${defaultTarget}\n    WHEN: true\n    RETURN: true`;

  return `SUPERVISOR: ${ctx.name}
GOAL: "{{goal_placeholder}}"
PERSONA: |
  {{persona_placeholder}}

${buildExecutionSection(ctx, options)}

MEMORY:
  session:
    - name: user_intent
      type: string

${DEFAULT_GUARDRAILS}

${handoffSection}`;
}

function buildSpecialistSkeleton(ctx: AgentContext, options: BuildSkeletonOptions): string {
  const toolSection = buildToolEntries(ctx.tools);
  const isDelegateTarget = ctx.handoffSources !== undefined && ctx.handoffSources.length > 0;

  const parts = [
    `AGENT: ${ctx.name}`,
    `GOAL: "{{goal_placeholder}}"`,
    `PERSONA: |`,
    `  {{persona_placeholder}}`,
    '',
    buildExecutionSection(ctx, options),
    '',
    `MEMORY:`,
    `  session:`,
    `    - name: conversation_topic`,
    `      type: string`,
  ];

  if (toolSection) {
    parts.push('', toolSection);
  }

  parts.push('', DEFAULT_GUARDRAILS);

  if (isDelegateTarget) {
    // Delegate targets need a compiler-safe state path toward COMPLETE even
    // before the LLM specializes the skeleton for the domain.
    parts.push('', buildDelegateGatherSection());
    parts.push('', buildDelegateComplete());
  }

  return parts.join('\n');
}

function buildScriptedSkeleton(ctx: AgentContext, options: BuildSkeletonOptions): string {
  const parts = [
    `AGENT: ${ctx.name}`,
    `GOAL: "{{goal_placeholder}}"`,
    `PERSONA: |`,
    `  {{persona_placeholder}}`,
    '',
    buildExecutionSection(ctx, options),
    '',
    `MEMORY:`,
    `  session:`,
    `    - name: step_status`,
    `      type: string`,
    '',
    `FLOW:`,
    `  steps:`,
    `    - start`,
    `    - process`,
    `    - finish`,
    `  start:`,
    `    REASONING: false`,
    `    RESPOND: ${EMPTY_CUSTOMER_RESPONSE}`,
    `    THEN: process`,
    `  process:`,
    `    REASONING: true`,
    `    RESPOND: ${EMPTY_CUSTOMER_RESPONSE}`,
    `    THEN: finish`,
    `  finish:`,
    `    REASONING: false`,
    `    RESPOND: ${EMPTY_CUSTOMER_RESPONSE}`,
    `    THEN: COMPLETE`,
    '',
    DEFAULT_GUARDRAILS,
  ];

  return parts.join('\n');
}

function buildHybridSkeleton(ctx: AgentContext, options: BuildSkeletonOptions): string {
  const toolSection = buildToolEntries(ctx.tools);
  const isDelegateTarget = ctx.handoffSources !== undefined && ctx.handoffSources.length > 0;

  const parts = [
    `AGENT: ${ctx.name}`,
    `GOAL: "{{goal_placeholder}}"`,
    `PERSONA: |`,
    `  {{persona_placeholder}}`,
    '',
    buildExecutionSection(ctx, options),
    '',
    `MEMORY:`,
    `  session:`,
    `    - name: step_status`,
    `      type: string`,
  ];

  if (toolSection) {
    parts.push('', toolSection);
  }

  parts.push(
    '',
    `FLOW:`,
    `  steps:`,
    `    - start`,
    `    - process`,
    `  start:`,
    `    REASONING: true`,
    `    RESPOND: ${EMPTY_CUSTOMER_RESPONSE}`,
    `    THEN: process`,
    `  process:`,
    `    REASONING: true`,
    `    RESPOND: ${EMPTY_CUSTOMER_RESPONSE}`,
    `    THEN: COMPLETE`,
  );

  parts.push('', DEFAULT_GUARDRAILS);

  if (isDelegateTarget) {
    // Hybrid delegate targets already have FLOW, but still need a compiler-safe
    // gathered state path so return completion has something concrete to test.
    parts.push('', buildDelegateGatherSection());
    parts.push('', buildDelegateComplete());
  }

  return parts.join('\n');
}

/**
 * Build a skeleton YAML string with all mandatory sections pre-filled.
 * The LLM should MERGE its output with this skeleton, not replace it.
 */
export function buildSkeleton(ctx: AgentContext, options: BuildSkeletonOptions = {}): string {
  switch (ctx.type) {
    case 'supervisor':
      return buildSupervisorSkeleton(ctx, options);
    case 'specialist':
      return buildSpecialistSkeleton(ctx, options);
    case 'scripted':
      return buildScriptedSkeleton(ctx, options);
    case 'hybrid':
      return buildHybridSkeleton(ctx, options);
    default:
      return buildSpecialistSkeleton(ctx, options);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate LLM-generated ABL BEFORE sending to compiler.
 * Returns a list of issues, some of which are auto-fixable.
 */
export function validatePreCompile(yaml: string, ctx: AgentContext): ABLValidationIssue[] {
  const issues: ABLValidationIssue[] = [];

  // 1. Has agent/supervisor declaration
  const hasSupervisorDecl = /^\s*SUPERVISOR\s*:/m.test(yaml);
  const hasAgentDecl = /^\s*AGENT\s*:/m.test(yaml);
  if (!hasSupervisorDecl && !hasAgentDecl) {
    issues.push({
      field: 'declaration',
      message: renderMissingAgentDeclarationWarning(),
      severity: 'error',
      autoFixable: false,
    });
  }

  // 2. Has GOAL field
  const hasGoal = /^\s*GOAL\s*:/m.test(yaml);
  if (!hasGoal) {
    issues.push({
      field: 'GOAL',
      message: renderMissingConstructWarning('GOAL'),
      severity: 'error',
      autoFixable: false,
    });
  }

  // 3. Has MEMORY.session
  const hasMemory = /^\s*MEMORY\s*:/m.test(yaml);
  const hasSessionVar = /session\s*:\s*\n\s*-\s*name\s*:/m.test(yaml);
  if (!hasMemory || !hasSessionVar) {
    issues.push({
      field: 'MEMORY',
      message: renderMissingMemoryWarning(),
      severity: 'error',
      autoFixable: true,
      fix: DEFAULT_MEMORY_SESSION,
    });
  }

  // 4. Has GUARDRAILS.content_safety
  const hasGuardrails = /^\s*GUARDRAILS\s*:/m.test(yaml);
  const hasContentSafety = /content_safety\s*:/m.test(yaml);
  if (!hasGuardrails || !hasContentSafety) {
    issues.push({
      field: 'GUARDRAILS',
      message: 'Missing GUARDRAILS: with content_safety block. Required on every agent.',
      severity: 'error',
      autoFixable: true,
      fix: DEFAULT_GUARDRAILS,
    });
  }

  // 5. Supervisor must have HANDOFF with catch-all
  if (ctx.type === 'supervisor' || hasSupervisorDecl) {
    const hasHandoff = /^\s*HANDOFF\s*:/m.test(yaml);
    if (!hasHandoff) {
      issues.push({
        field: 'HANDOFF',
        message: renderSupervisorMissingHandoffWarning(),
        severity: 'error',
        autoFixable: false,
      });
    } else {
      const hasCatchAll = /WHEN\s*:\s*(?:"true"|'true'|true)\s*$/m.test(yaml);
      if (!hasCatchAll) {
        const defaultTarget =
          ctx.handoffTargets && ctx.handoffTargets.length > 0
            ? ctx.handoffTargets[0].name
            : 'DefaultAgent';
        issues.push({
          field: 'HANDOFF.catchAll',
          message: renderSupervisorCatchAllHandoffWarning(),
          severity: 'error',
          autoFixable: true,
          fix: renderDefaultSupervisorCatchAllHandoff(defaultTarget),
        });
      }
    }
  }

  // 6. Delegate target must have COMPLETE block (LLM must generate domain-specific conditions)
  const isDelegateTarget = ctx.handoffSources !== undefined && ctx.handoffSources.length > 0;
  if (isDelegateTarget) {
    const hasComplete = /^\s*COMPLETE\s*:/m.test(yaml);
    if (!hasComplete) {
      issues.push({
        field: 'COMPLETE',
        message: renderDelegateMissingCompleteWarning(),
        severity: 'error',
        autoFixable: false,
      });
    }

    // 6b. Delegate target should also have GATHER fields to drive completion
    const hasGather = /^\s*GATHER\s*:/m.test(yaml);
    const hasFlow = /^\s*FLOW\s*:/m.test(yaml);
    if (!hasGather && !hasFlow) {
      issues.push({
        field: 'GATHER',
        message: renderDelegateMissingGatherWarning(),
        severity: 'warning',
        autoFixable: false,
      });
    }
  }

  // 7. HANDOFF context pass fields must exist in MEMORY.session
  const contextPassMatch = yaml.match(/CONTEXT\s*:\s*\n\s*pass\s*:\s*\n((?:\s*-\s*\w+\n?)+)/gm);
  if (contextPassMatch) {
    const passFields: string[] = [];
    for (const block of contextPassMatch) {
      const fieldMatches = block.matchAll(/^\s*-\s*(\w+)/gm);
      for (const m of fieldMatches) {
        passFields.push(m[1]);
      }
    }

    // Extract session variable names
    const sessionVarNames: string[] = [];
    const sessionMatches = yaml.matchAll(
      /session\s*:\s*\n((?:\s*-\s*name\s*:\s*\w+\s*\n(?:\s*type\s*:\s*\w+\s*\n?)?)+)/gm,
    );
    for (const sm of sessionMatches) {
      const nameMatches = sm[1].matchAll(/name\s*:\s*(\w+)/g);
      for (const nm of nameMatches) {
        sessionVarNames.push(nm[1]);
      }
    }

    for (const field of passFields) {
      if (!sessionVarNames.includes(field)) {
        issues.push({
          field: `HANDOFF.context.pass.${field}`,
          message: renderHandoffContextPassMissingMemoryWarning(field),
          severity: 'warning',
          autoFixable: false,
        });
      }
    }
  }

  // 8. FLOW steps must have matching definitions
  const flowStepsMatch = yaml.match(/FLOW\s*:\s*\n\s*steps\s*:\s*\n((?:\s*-\s*\w+\s*\n?)+)/m);
  if (flowStepsMatch) {
    const stepNames: string[] = [];
    const stepMatches = flowStepsMatch[1].matchAll(/^\s*-\s*(\w+)/gm);
    for (const m of stepMatches) {
      stepNames.push(m[1]);
    }

    for (const stepName of stepNames) {
      const stepDefPattern = new RegExp(`^\\s{2}${stepName}\\s*:`, 'm');
      if (!stepDefPattern.test(yaml)) {
        issues.push({
          field: `FLOW.steps.${stepName}`,
          message: `FLOW step "${stepName}" listed in steps: but no matching definition found.`,
          severity: 'error',
          autoFixable: false,
        });
      }
    }
  }

  // 8b. Legacy object-shaped CALL blocks are silently ignored by the parser.
  // Canonical ABL uses `CALL: tool_name` with nested `WITH:` and `AS:`.
  const legacyCallLine = findLegacyObjectCallLine(yaml);
  if (legacyCallLine !== null) {
    issues.push({
      field: 'FLOW.CALL',
      message: `Unsupported FLOW CALL object shape near line ${legacyCallLine}. Use CALL: tool_name with nested WITH: args and AS: result_name; do not emit CALL: { tool, args, save }.`,
      severity: 'error',
      autoFixable: false,
    });
  }

  // 9. PCI compliance constraints
  if (ctx.pciCompliant) {
    const hasConstraints = /^\s*CONSTRAINTS\s*:/m.test(yaml);
    if (!hasConstraints) {
      issues.push({
        field: 'CONSTRAINTS',
        message: renderPciMissingConstraintsWarning(),
        severity: 'warning',
        autoFixable: false,
      });
    }
  }

  return issues;
}

function findLegacyObjectCallLine(yaml: string): number | null {
  const lines = yaml.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/^(\s*)CALL:\s*$/);
    if (!match) continue;

    const baseIndent = match[1].length;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
      const nextLine = lines[nextIndex];
      if (nextLine.trim().length === 0) continue;
      const indent = nextLine.length - nextLine.trimStart().length;
      if (indent <= baseIndent) break;
      if (/^\s*tool\s*:/.test(nextLine)) {
        return index + 1;
      }
    }
  }

  return null;
}

function normalizeQuotedConditionLines(yaml: string): string {
  return yaml.replace(
    /^(\s*(?:-\s*)?WHEN:\s*)(["'])(.*?)\2\s*$/gm,
    (_match, prefix, quoteChar, raw) => {
      const unescaped =
        quoteChar === '"'
          ? raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          : raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      return `${prefix}${unescaped.trim() || 'true'}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Auto-fix
// ---------------------------------------------------------------------------

/**
 * Auto-fix known issues in LLM-generated ABL.
 * Applies deterministic fixes for missing mandatory sections.
 * Only touches auto-fixable issues; preserves all LLM creative content.
 */
export function autoFixABL(yaml: string, issues: ABLValidationIssue[], _ctx: AgentContext): string {
  let fixed = yaml;

  for (const issue of issues) {
    if (!issue.autoFixable || !issue.fix) continue;

    switch (issue.field) {
      case 'GUARDRAILS': {
        if (!/^\s*GUARDRAILS\s*:/m.test(fixed)) {
          fixed = fixed.trimEnd() + '\n\n' + issue.fix + '\n';
        }
        break;
      }

      case 'MEMORY': {
        if (!/^\s*MEMORY\s*:/m.test(fixed)) {
          const insertAfter = /^\s*PERSONA\s*:.*$/m;
          const personaMatch = fixed.match(insertAfter);
          if (personaMatch && personaMatch.index !== undefined) {
            const afterPersona = fixed.substring(personaMatch.index + personaMatch[0].length);
            const nextKeyword = afterPersona.search(
              /^\s*(?:TOOLS|GUARDRAILS|HANDOFF|FLOW|CONSTRAINTS|COMPLETE|LIMITATIONS|GATHER)\s*:/m,
            );
            const insertPos =
              nextKeyword !== -1
                ? personaMatch.index + personaMatch[0].length + nextKeyword
                : fixed.length;
            fixed =
              fixed.substring(0, insertPos).trimEnd() +
              '\n\n' +
              issue.fix +
              '\n\n' +
              fixed.substring(insertPos).trimStart();
          } else {
            const goalMatch = fixed.match(/^\s*GOAL\s*:.*$/m);
            if (goalMatch && goalMatch.index !== undefined) {
              const insertPos = goalMatch.index + goalMatch[0].length;
              fixed =
                fixed.substring(0, insertPos) +
                '\n\n' +
                issue.fix +
                '\n\n' +
                fixed.substring(insertPos);
            } else {
              fixed = fixed.trimEnd() + '\n\n' + issue.fix + '\n';
            }
          }
        }
        break;
      }

      case 'HANDOFF.catchAll': {
        const handoffEnd = findSectionEnd(fixed, 'HANDOFF');
        if (handoffEnd !== -1) {
          fixed =
            fixed.substring(0, handoffEnd).trimEnd() +
            '\n' +
            issue.fix +
            '\n' +
            fixed.substring(handoffEnd);
        } else {
          fixed = fixed.trimEnd() + '\n' + issue.fix + '\n';
        }
        break;
      }

      case 'COMPLETE': {
        if (!/^\s*COMPLETE\s*:/m.test(fixed)) {
          fixed = fixed.trimEnd() + '\n\n' + issue.fix + '\n';
        }
        break;
      }

      default:
        break;
    }
  }

  return fixed;
}

/**
 * Find the end position of a top-level YAML/DSL section.
 * Returns the index of the next top-level keyword, or -1 if this is the last section.
 */
function findSectionEnd(yaml: string, sectionName: string): number {
  const sectionPattern = new RegExp(`^\\s*${sectionName}\\s*:`, 'm');
  const sectionMatch = yaml.match(sectionPattern);
  if (!sectionMatch || sectionMatch.index === undefined) return -1;

  const afterSection = yaml.substring(sectionMatch.index + sectionMatch[0].length);
  const nextKeyword = afterSection.search(
    /^\s*(?:AGENT|SUPERVISOR|GOAL|PERSONA|TOOLS|GUARDRAILS|HANDOFF|FLOW|CONSTRAINTS|COMPLETE|LIMITATIONS|GATHER|MEMORY|REMEMBER)\s*:/m,
  );

  if (nextKeyword !== -1) {
    return sectionMatch.index + sectionMatch[0].length + nextKeyword;
  }

  return -1;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

/**
 * Full pipeline: validate -> autofix.
 * Call this AFTER the LLM generates its YAML, BEFORE compilation.
 */
export function processGeneratedABL(rawYaml: string, ctx: AgentContext): PipelineResult {
  const normalizedYaml = normalizeQuotedConditionLines(rawYaml);
  const issues = validatePreCompile(normalizedYaml, ctx);
  const autoFixable = issues.filter((i) => i.autoFixable);
  const notFixable = issues.filter((i) => !i.autoFixable);

  const fixedYaml =
    autoFixable.length > 0 ? autoFixABL(normalizedYaml, autoFixable, ctx) : normalizedYaml;

  return {
    yaml: fixedYaml,
    issues,
    autoFixed: autoFixable.map((i) => i.message),
    skipped: notFixable.map((i) => i.message),
  };
}
