/**
 * Import Mapping Utilities
 *
 * Shared utilities for name sanitization, tool inference,
 * and common mapping operations.
 */

// =============================================================================
// NAME SANITIZATION
// =============================================================================

/**
 * Convert a name to valid ABL identifier (snake_case, alphanumeric + underscore)
 */
export function sanitizeName(name: string): string {
  if (!name) return 'unnamed';
  return name
    .replace(/[^a-zA-Z0-9\s_-]/g, '') // Remove special chars
    .replace(/[-\s]+/g, '_') // Replace spaces/hyphens with underscore
    .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase to snake_case
    .replace(/__+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
    .replace(/^\d/, '_$&'); // Prefix with _ if starts with digit
}

/**
 * Convert to PascalCase for agent names
 */
export function toAgentName(name: string): string {
  return sanitizeName(name)
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('_');
}

/**
 * Convert to snake_case for tool names
 */
export function toToolName(name: string): string {
  return sanitizeName(name).toLowerCase();
}

/**
 * Convert to snake_case for field names
 */
export function toFieldName(name: string): string {
  return sanitizeName(name).toLowerCase();
}

// =============================================================================
// TYPE INFERENCE
// =============================================================================

/**
 * Infer ABL type from various type descriptions
 */
export function inferType(typeStr: string | undefined): string {
  if (!typeStr) return 'string';

  const lower = typeStr.toLowerCase().trim();

  if (lower === 'string' || lower === 'str' || lower === 'text') return 'string';
  if (
    lower === 'number' ||
    lower === 'int' ||
    lower === 'integer' ||
    lower === 'float' ||
    lower === 'double' ||
    lower === 'decimal'
  )
    return 'number';
  if (lower === 'boolean' || lower === 'bool') return 'boolean';
  if (lower === 'date' || lower === 'datetime' || lower === 'timestamp') return 'date';
  if (lower === 'email') return 'email';
  if (lower === 'phone' || lower === 'telephone') return 'phone';
  if (lower === 'array' || lower.endsWith('[]') || lower === 'list') return 'string';
  if (lower === 'object' || lower === 'json' || lower === 'map') return 'object';

  return 'string';
}

/**
 * Infer ABL return type string from a description or type
 */
export function inferReturnType(returnInfo: string | undefined): string {
  if (!returnInfo) return 'object';

  const lower = returnInfo.toLowerCase();
  if (lower.includes('boolean') || lower.includes('success')) return '{success: boolean}';
  if (lower.includes('list') || lower.includes('array')) return '{items: object[], count: number}';
  if (lower.includes('string') || lower.includes('text')) return 'string';
  if (lower.includes('number')) return 'number';

  return 'object';
}

// =============================================================================
// TOOL PARAMETER MAPPING
// =============================================================================

/**
 * Map generic parameter definitions to ABL tool parameter syntax
 */
export function formatToolParams(
  params: Array<{ name: string; type?: string; required?: boolean; default?: string }>,
): string {
  if (!params || params.length === 0) return '';

  return params
    .map((p) => {
      const type = inferType(p.type);
      let param = `${toFieldName(p.name)}: ${type}`;
      if (p.default !== undefined) {
        param += ` = ${JSON.stringify(p.default)}`;
      }
      return param;
    })
    .join(', ');
}

// =============================================================================
// TEXT EXTRACTION
// =============================================================================

/**
 * Extract a brief description from a longer text (first sentence or first N chars)
 */
export function extractBrief(text: string, maxLength: number = 120): string {
  if (!text) return '';

  // Try first sentence
  const sentenceMatch = text.match(/^[^.!?]+[.!?]/);
  if (sentenceMatch && sentenceMatch[0].length <= maxLength) {
    return sentenceMatch[0].trim();
  }

  // Truncate
  if (text.length <= maxLength) return text.trim();
  return text.substring(0, maxLength - 3).trim() + '...';
}

/**
 * Extract numbered steps from a prompt text
 */
export function extractSteps(text: string): Array<{ number: number; text: string }> {
  const steps: Array<{ number: number; text: string }> = [];
  const lines = text.split('\n');

  let currentStep: { number: number; text: string } | null = null;

  for (const line of lines) {
    const stepMatch = line.trim().match(/^(\d+)[\.\)]\s*(.+)/);
    if (stepMatch) {
      if (currentStep) steps.push(currentStep);
      currentStep = {
        number: parseInt(stepMatch[1]),
        text: stepMatch[2].trim(),
      };
    } else if (currentStep && line.trim()) {
      currentStep.text += ' ' + line.trim();
    }
  }

  if (currentStep) steps.push(currentStep);
  return steps;
}

// =============================================================================
// STRUCTURED PROMPT EXTRACTION
// =============================================================================

import type {
  FlowStepSpec,
  ConstraintSpec,
  GuardrailSpec,
  MemorySpec,
  HandoffSpec,
} from '../architect/types.js';

/**
 * Parsed STEP structure from prompts.
 * Matches patterns like:
 *   **STEP 1 - Title:**
 *   **STEP 2.1 - Sub-step Title:**
 *   STEP 0: Title
 */
export interface ParsedPromptStep {
  stepNumber: string; // e.g., "1", "2.1", "0"
  title: string;
  toolCalls: string[];
  transitions: Array<{ condition?: string; targetStep: string }>;
  body: string;
}

/**
 * Parse STEP sequences from a prompt into FlowStepSpec[].
 * Extracts step names, tool calls, and transitions.
 */
export function parseStepsFromPrompt(promptText: string): {
  steps: FlowStepSpec[];
  stepOrder: string[];
} | null {
  const rawSteps = extractPromptSteps(promptText);
  if (rawSteps.length < 2) return null; // Need at least 2 steps to form a flow

  const stepOrder: string[] = [];
  const steps: FlowStepSpec[] = [];

  for (const raw of rawSteps) {
    const stepName = toStepName(raw.title, raw.stepNumber);
    stepOrder.push(stepName);

    const spec: FlowStepSpec = { name: stepName };

    // Extract tool calls
    if (raw.toolCalls.length > 0) {
      spec.call = raw.toolCalls[0]; // Primary tool call
    }

    // Extract transitions
    if (raw.transitions.length > 0) {
      // Find the default/success transition
      const defaultTransition = raw.transitions.find((t) => !t.condition) || raw.transitions[0];
      if (defaultTransition) {
        const targetName = resolveStepReference(defaultTransition.targetStep, rawSteps);
        if (targetName) spec.then = targetName;
      }

      // If there's a conditional transition, add it as onFail
      const failTransition = raw.transitions.find(
        (t) => t.condition && /fail|error|invalid|not|false/i.test(t.condition),
      );
      if (failTransition) {
        const failTarget = resolveStepReference(failTransition.targetStep, rawSteps);
        if (failTarget) spec.onFail = failTarget;
      }
    }

    // Extract prompt/respond from the body text
    const respondMatch = raw.body.match(
      /(?:respond|tell|inform|say|message)[:\s]+["']?([^"'\n]+)["']?/i,
    );
    if (respondMatch) {
      spec.respond = extractBrief(respondMatch[1], 200);
    }

    // Check for attempt limits
    const attemptMatch =
      raw.body.match(/(\d+)\s*(?:attempt|tries|retries|max)/i) ||
      raw.body.match(/(?:attempt|tries|retries|max)\s*(?:of\s+)?(\d+)/i);
    if (attemptMatch) {
      spec.maxAttempts = parseInt(attemptMatch[1], 10);
    }

    // Check for WHEN guard from body
    const whenMatch = raw.body.match(
      /(?:only\s+)?if\s+(?:current\s+)?(?:role|channel|platform)\s+(?:is\s+)?(.+?)(?:→|->|then|proceed|,|$)/i,
    );
    if (whenMatch) {
      spec.when = whenMatch[1].trim();
    }

    steps.push(spec);
  }

  return { steps, stepOrder };
}

/**
 * Extract raw STEP structures from prompt text
 */
function extractPromptSteps(text: string): ParsedPromptStep[] {
  const steps: ParsedPromptStep[] = [];
  const lines = text.split('\n');

  // Match STEP patterns: **STEP 1 - Title**, STEP 1: Title, **STEP 1.2 - Title:**
  const stepHeaderRegex = /\*?\*?STEP\s+(\d+(?:\.\d+)?)\s*[-–:]\s*([^(*\n]+)/i;

  let currentStep: ParsedPromptStep | null = null;
  let bodyLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const headerMatch = trimmed.match(stepHeaderRegex);

    if (headerMatch) {
      // Save previous step
      if (currentStep) {
        currentStep.body = bodyLines.join('\n');
        parseStepBody(currentStep);
        steps.push(currentStep);
      }

      currentStep = {
        stepNumber: headerMatch[1],
        title: headerMatch[2].replace(/\*+:?$/g, '').trim(),
        toolCalls: [],
        transitions: [],
        body: '',
      };
      bodyLines = [];
    } else if (currentStep) {
      bodyLines.push(trimmed);
    }
  }

  // Save last step
  if (currentStep) {
    currentStep.body = bodyLines.join('\n');
    parseStepBody(currentStep);
    steps.push(currentStep);
  }

  return steps;
}

/**
 * Parse tool calls and transitions from a step's body text
 */
function parseStepBody(step: ParsedPromptStep): void {
  const lines = step.body.split('\n');

  for (const line of lines) {
    // Tool call: MUST call **toolName** or MUST call **"toolName"**
    const toolMatch = line.match(/(?:MUST\s+)?call\s+\*?\*?"?([^"*]+)"?\*?\*?/i);
    if (toolMatch) {
      const toolName = toToolName(toolMatch[1].trim());
      if (toolName && !step.toolCalls.includes(toolName)) {
        step.toolCalls.push(toolName);
      }
    }

    // Transition: proceed to STEP N, route to STEP N, go to STEP N
    const transitionMatch = line.match(
      /(?:proceed|route|go|move|transition)\s+to\s+\*?\*?STEP\s+(\d+(?:\.\d+)?)/i,
    );
    if (transitionMatch) {
      // Check for preceding IF condition
      const conditionMatch = line.match(
        /(?:if|when)\s+(.+?)(?:→|->|proceed|route|go|move|transition)/i,
      );
      step.transitions.push({
        condition: conditionMatch ? conditionMatch[1].trim() : undefined,
        targetStep: transitionMatch[1],
      });
    }
  }
}

/**
 * Convert a step title + number to a valid ABL step name
 */
function toStepName(title: string, stepNumber: string): string {
  const sanitized = sanitizeName(title);
  return sanitized || `step_${stepNumber.replace('.', '_')}`;
}

/**
 * Resolve a step number reference (e.g., "2") to a step name
 */
function resolveStepReference(stepRef: string, allSteps: ParsedPromptStep[]): string | undefined {
  const target = allSteps.find((s) => s.stepNumber === stepRef);
  if (target) {
    return toStepName(target.title, target.stepNumber);
  }
  return undefined;
}

/**
 * Parse NEVER/MUST NOT/MUST/ALWAYS lines from prompt into ConstraintSpec[].
 * Lines like "NEVER skip steps" → constraint requirement.
 */
export function parseConstraintsFromPrompt(promptText: string): ConstraintSpec[] {
  const lines = promptText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);
  const requirements: Array<{ condition: string; onFail: string }> = [];

  for (const line of lines) {
    // Clean markdown formatting
    const cleaned = line
      .replace(/\*+/g, '')
      .replace(/^[●•\-]\s*/, '')
      .trim();

    // Negative constraints: NEVER, MUST NOT, Do not, FORBIDDEN
    if (cleaned.match(/^(never|must not|do not|don't|forbidden to|cannot|should not)/i)) {
      requirements.push({
        condition: cleaned,
        onFail: `Constraint violated: ${extractBrief(cleaned, 80)}`,
      });
    }
    // Positive constraints: MUST, ALWAYS, ENSURE, STRICTLY
    else if (cleaned.match(/^(must\b|always|ensure|strictly|required to)/i)) {
      requirements.push({
        condition: cleaned,
        onFail: `Constraint violated: ${extractBrief(cleaned, 80)}`,
      });
    }
  }

  if (requirements.length === 0) return [];

  return requirements.slice(0, 15).map((r) => ({
    condition: r.condition,
    onFail: r.onFail,
  }));
}

/**
 * Parse channel/role/mask checks from prompt into GuardrailSpec[].
 */
export function parseGuardrailsFromPrompt(promptText: string): GuardrailSpec[] {
  const guardrails: GuardrailSpec[] = [];
  const lines = promptText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);

  for (const line of lines) {
    const cleaned = line
      .replace(/\*+/g, '')
      .replace(/^[●•\-]\s*/, '')
      .trim();

    // Channel/platform guards: "ONLY if channel/plataforma is..."
    const channelMatch = cleaned.match(
      /(?:only|execute|run)\s+(?:if|when)\s+.*(?:channel|plataforma|platform)\s+(?:is\s+)?["']?([^"'\n]+?)["']?$/i,
    );
    if (channelMatch) {
      guardrails.push({
        name: 'channel_guard',
        kind: 'input',
        check: `channel in [${channelMatch[1]
          .split(/[,\s]+(?:or|and)\s+|,\s*/)
          .map((s) => `"${s.trim().replace(/"/g, '')}"`)
          .join(', ')}]`,
        action: 'block',
        message: extractBrief(cleaned, 100),
      });
    }

    // Masking/PII guards: "mask email/phone", "STRICTLY make sure ... masked"
    const maskMatch =
      cleaned.match(/(?:mask|redact|hide|anonymize|PII)\s.*(?:email|phone|ssn|account|card)/i) ||
      cleaned.match(/(?:email|phone|ssn|account|card).*(?:masked|redacted|hidden|anonymized)/i);
    if (maskMatch) {
      guardrails.push({
        name: 'pii_masking',
        kind: 'output',
        check: 'contains_pii(response)',
        action: 'redact',
        message: extractBrief(cleaned, 100),
      });
    }

    // Role validation guards
    const roleMatch = cleaned.match(
      /(?:only|validate|verify|check)\s+(?:if|that)\s+.*(?:role|user_?type)\s+(?:is\s+)?["']?([^"'\n]+?)["']?$/i,
    );
    if (roleMatch) {
      guardrails.push({
        name: 'role_validation',
        kind: 'input',
        check: `user.role in [${roleMatch[1]
          .split(/[,\s]+(?:or|and)\s+|,\s*/)
          .map((s) => `"${s.trim().replace(/"/g, '')}"`)
          .join(', ')}]`,
        action: 'block',
        message: extractBrief(cleaned, 100),
      });
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return guardrails.filter((g) => {
    if (seen.has(g.name)) return false;
    seen.add(g.name);
    return true;
  });
}

/**
 * Extract {{memory.X}} references from prompt text into MemorySpec.
 */
export function extractMemoryReferences(promptText: string): MemorySpec {
  const session = new Set<string>();
  const persistent = new Set<string>();

  // Match {{memory.X.Y.Z}} patterns
  const memoryPattern = /\{\{memory\.([^}]+)\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = memoryPattern.exec(promptText)) !== null) {
    const fullPath = match[1];
    const topLevel = fullPath.split('.')[0];

    // Classify: sessionMeta, sessionInfo → session; others → persistent
    if (topLevel.match(/^(session|conversation|context|current)/i)) {
      session.add(topLevel);
    } else {
      persistent.add(topLevel);
    }
  }

  // Also look for store references like "memory store: X"
  const storePattern = /memory\s*store[:\s]+["']?(\w+)/gi;
  while ((match = storePattern.exec(promptText)) !== null) {
    persistent.add(match[1]);
  }

  return {
    session: [...session],
    persistent: [...persistent],
  };
}

/**
 * Extract tool calls with parameters from prompt text.
 * Pattern: "MUST call **toolName** with: sessionId=..., channel=..."
 * Returns: array of { toolName, params: string[] }
 */
export function extractToolCalls(
  promptText: string,
): Array<{ toolName: string; params: string[] }> {
  const results: Array<{ toolName: string; params: string[] }> = [];
  const lines = promptText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match tool call pattern
    const toolMatch = line.match(
      /(?:MUST\s+)?call\s+\*?\*?"?([^"*\s]+)"?\*?\*?\s*(?:with|using)?/i,
    );
    if (!toolMatch) continue;

    const toolName = toToolName(toolMatch[1].trim());
    const params: string[] = [];

    // Check same line for inline params
    const inlineParams = line.match(/(?:with|using)[:\s]+(.+)$/i);
    if (inlineParams) {
      extractParamNames(inlineParams[1], params);
    }

    // Check following lines for param definitions
    for (let j = i + 1; j < lines.length && j < i + 10; j++) {
      const nextLine = lines[j].trim();
      if (!nextLine || nextLine.match(/^(\*?\*?STEP|MUST\s+call)/i)) break;

      // param_name={{memory.path}} or param_name=value
      const paramMatch = nextLine.match(/(\w+)\s*[=:]\s*(?:\{\{memory\.([^}]+)\}\}|(.+))$/);
      if (paramMatch) {
        const paramName = toFieldName(paramMatch[1]);
        if (!params.includes(paramName)) params.push(paramName);
      }
    }

    if (toolName) {
      results.push({ toolName, params });
    }
  }

  return results;
}

/**
 * Helper to extract parameter names from an inline param string
 */
function extractParamNames(text: string, params: string[]): void {
  // Match param=value or param:value patterns
  const pattern = /(\w+)\s*[=:]\s*(?:\{\{[^}]+\}\}|[^,\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const paramName = toFieldName(match[1]);
    if (!params.includes(paramName)) params.push(paramName);
  }
}

/**
 * Parse LEVEL-based routing from orchestration text into HandoffSpec[] with priority.
 * Pattern: ## LEVEL 0: PRIORITY TRANSFER → level 0 handoffs
 */
export function parseLevelBasedRouting(
  orchestrationText: string,
  agentNames: string[],
): HandoffSpec[] {
  const handoffs: HandoffSpec[] = [];
  const lines = orchestrationText.split('\n');

  // Extract LEVEL sections
  const levels: Array<{ level: number; title: string; body: string }> = [];
  let currentLevel: { level: number; title: string; body: string } | null = null;
  const bodyLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const levelMatch = trimmed.match(/^#{0,4}\s*LEVEL\s+(\d+)\s*[:\-–]\s*(.+)/i);

    if (levelMatch) {
      if (currentLevel) {
        currentLevel.body = bodyLines.join('\n');
        levels.push(currentLevel);
        bodyLines.length = 0;
      }
      currentLevel = {
        level: parseInt(levelMatch[1]),
        title: levelMatch[2].replace(/\*+/g, '').trim(),
        body: '',
      };
    } else if (currentLevel) {
      bodyLines.push(trimmed);
    }
  }
  if (currentLevel) {
    currentLevel.body = bodyLines.join('\n');
    levels.push(currentLevel);
  }

  if (levels.length === 0) return [];

  // For each level, extract routing rules
  for (const level of levels) {
    const levelBody = level.body;
    const agentNameSet = new Set(agentNames.map((n) => n.toLowerCase()));

    // Look for "route to AgentName" or "→ AgentName" patterns
    const routePattern =
      /(?:route|transfer|hand\s*off|delegate|→|->)\s+(?:to\s+)?["']?(\w+)["']?/gi;
    let routeMatch: RegExpExecArray | null;

    while ((routeMatch = routePattern.exec(levelBody)) !== null) {
      const targetRaw = routeMatch[1];
      // Try to match to known agent names
      const matchedAgent = findMatchingAgent(targetRaw, agentNames);
      if (!matchedAgent) continue;

      // Extract the condition for this route
      // Look at the text before this route mention
      const beforeRoute = levelBody.substring(0, routeMatch.index);
      const conditionLines = beforeRoute.split('\n');
      const lastConditionLine = conditionLines[conditionLines.length - 1]?.trim() || '';

      let condition = `intent.category == "${matchedAgent.toLowerCase()}"`;
      const ifMatch = lastConditionLine.match(/(?:if|when)\s+(.+?)(?:→|->|route|transfer|$)/i);
      if (ifMatch) {
        condition = ifMatch[1].trim().replace(/\*+/g, '');
      }

      // Don't add duplicate agent handoffs
      if (handoffs.some((h) => h.to === matchedAgent)) continue;

      handoffs.push({
        to: matchedAgent,
        when: condition,
        priority: level.level,
        pass: ['conversation_context'],
        summary: `Level ${level.level}: ${extractBrief(level.title, 80)}`,
        return: false,
      });
    }
  }

  return handoffs;
}

/**
 * Find the best matching agent name from a list
 */
function findMatchingAgent(target: string, agentNames: string[]): string | undefined {
  const targetLower = target.toLowerCase().replace(/[_\s-]/g, '');

  // Exact match first
  for (const name of agentNames) {
    if (name.toLowerCase().replace(/[_\s-]/g, '') === targetLower) {
      return name;
    }
  }

  // Partial match (target contains agent name or vice versa)
  for (const name of agentNames) {
    const nameLower = name.toLowerCase().replace(/[_\s-]/g, '');
    if (nameLower.includes(targetLower) || targetLower.includes(nameLower)) {
      return name;
    }
  }

  return undefined;
}

/**
 * Detect language directive from prompt text.
 * Looks for patterns like "all communication MUST be in Spanish" or "respond in Spanish (Ecuadorian)"
 */
export function detectLanguageFromPrompt(promptText: string): string | undefined {
  // Common language detection patterns
  const patterns = [
    /(?:all\s+)?(?:communication|responses?|messages?)\s+(?:MUST\s+)?be\s+in\s+(\w+(?:\s*\([^)]+\))?)/i,
    /(?:respond|communicate|speak|reply)\s+(?:only\s+)?in\s+(\w+(?:\s*\([^)]+\))?)/i,
    /language[:\s]+(\w+(?:\s*\([^)]+\))?)/i,
  ];

  for (const pattern of patterns) {
    const match = promptText.match(pattern);
    if (match) {
      return mapLanguageToCode(match[1].trim());
    }
  }

  return undefined;
}

/**
 * Map a language name to a BCP 47 code
 */
function mapLanguageToCode(language: string): string {
  const lower = language.toLowerCase();

  // Handle "Spanish (Ecuadorian)" style
  const regionMatch = lower.match(/^(\w+)\s*\((\w+)\)$/);
  if (regionMatch) {
    const lang = regionMatch[1];
    const region = regionMatch[2];
    const langCode = LANGUAGE_CODES[lang];
    const regionCode = REGION_CODES[region];
    if (langCode && regionCode) return `${langCode}-${regionCode}`;
    if (langCode) return langCode;
  }

  return LANGUAGE_CODES[lower] || language;
}

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  portuguese: 'pt',
  italian: 'it',
  dutch: 'nl',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  arabic: 'ar',
  hindi: 'hi',
  turkish: 'tr',
  thai: 'th',
  vietnamese: 'vi',
};

const REGION_CODES: Record<string, string> = {
  ecuadorian: 'EC',
  mexican: 'MX',
  colombian: 'CO',
  argentinian: 'AR',
  chilean: 'CL',
  peruvian: 'PE',
  brazilian: 'BR',
  european: 'EU',
  american: 'US',
  british: 'GB',
  australian: 'AU',
  canadian: 'CA',
};
