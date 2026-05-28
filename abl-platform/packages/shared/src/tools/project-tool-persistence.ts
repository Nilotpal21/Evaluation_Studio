import { computeSourceHash } from '../utils/hash.js';
import { parseDslProperties } from './dsl-property-parser.js';
import { validateToolDsl } from './project-tool-validator.js';

export const PROJECT_TOOL_TYPES = ['http', 'sandbox', 'mcp', 'searchai', 'workflow'] as const;

export type ProjectToolType = (typeof PROJECT_TOOL_TYPES)[number];

const PROJECT_TOOL_TYPE_SET = new Set<string>(PROJECT_TOOL_TYPES);
// Strict storage rule: tool names must be snake_case (lowercase letters, digits,
// underscores), 2–64 chars, must start with a letter and end with a letter or
// digit. Keep this regex in sync with the friendly explanation produced below.
const SIGNATURE_NAME_REGEX = /^([a-z][a-z0-9_]{0,62}[a-z0-9])\s*\(/;
// Lenient match used solely to produce a more helpful error: if the user wrote
// what *looks* like a function signature (camelCase, PascalCase, hyphens, …),
// surface the actual offending name plus the snake_case rule instead of the
// generic "must start with a valid signature" message.
const LOOSE_SIGNATURE_NAME_REGEX = /^([A-Za-z][A-Za-z0-9_-]{0,98})\s*\(/;

export interface ProjectToolDslPersistenceInput {
  tenantId: string;
  projectId: string;
  name: string;
  toolType: ProjectToolType;
  dslContent: string;
}

export type ProjectToolDslValidationResult = { valid: true } | { valid: false; message: string };

export type PreparedProjectToolDslPersistence =
  | { valid: true; dslContent: string; sourceHash: string }
  | { valid: false; message: string };

export function isProjectToolType(value: string): value is ProjectToolType {
  return PROJECT_TOOL_TYPE_SET.has(value);
}

export function validateToolDslConsistency({
  name,
  toolType,
  dslContent,
}: {
  name: string;
  toolType: ProjectToolType;
  dslContent: string;
}): ProjectToolDslValidationResult {
  const firstLine = dslContent.split('\n')[0]?.trim() ?? '';
  const signatureMatch = firstLine.match(SIGNATURE_NAME_REGEX);

  if (!signatureMatch) {
    // Distinguish "this isn't a signature at all" (no parentheses, blank line,
    // a TOML / YAML block, …) from "the signature shape is fine but the name
    // is camelCase / has hyphens / starts with a digit". The latter is by far
    // the more common case from LLM-generated tool DSL and a vague error makes
    // the agent retry with the same bad name.
    const looseMatch = firstLine.match(LOOSE_SIGNATURE_NAME_REGEX);
    if (looseMatch) {
      const badName = looseMatch[1];
      return {
        valid: false,
        message: `Tool name "${badName}" is not a valid signature name. Tool names must be snake_case (lowercase letters, digits, and underscores), 2–64 characters, starting with a letter and ending with a letter or digit. For example: my_http_tool, fetch_user_data, list_users.`,
      };
    }
    return {
      valid: false,
      message:
        'Tool DSL must start with a valid tool signature, for example: tool_name() -> object.',
    };
  }

  const signatureName = signatureMatch[1];
  if (signatureName !== name) {
    return {
      valid: false,
      message: `Tool DSL signature name "${signatureName}" must match tool name "${name}".`,
    };
  }

  const dslType = parseDslProperties(dslContent).type;
  if (!dslType) {
    return {
      valid: false,
      message: 'Tool DSL must include a type property.',
    };
  }

  if (dslType !== toolType) {
    return {
      valid: false,
      message: `Tool DSL type "${dslType}" must match toolType "${toolType}".`,
    };
  }

  return { valid: true };
}

export function rewriteToolDslSignatureName(dslContent: string, name: string): string {
  const lines = dslContent.split('\n');
  const signatureLine = lines[0] ?? '';
  const parenIndex = signatureLine.indexOf('(');
  lines[0] = parenIndex >= 0 ? `${name}${signatureLine.slice(parenIndex)}` : `${name}() -> object`;
  return lines.join('\n');
}

export function validateProjectToolDslForPersistence({
  tenantId,
  projectId,
  name,
  toolType,
  dslContent,
}: ProjectToolDslPersistenceInput): ProjectToolDslValidationResult {
  const consistency = validateToolDslConsistency({ name, toolType, dslContent });
  if (!consistency.valid) return consistency;

  const validation = validateToolDsl(dslContent, { tenantId, projectId });
  if (!validation.valid) {
    return {
      valid: false,
      message: validation.errors[0]?.message ?? 'Invalid tool DSL.',
    };
  }

  return { valid: true };
}

export function prepareProjectToolDslForPersistence(
  input: ProjectToolDslPersistenceInput,
): PreparedProjectToolDslPersistence {
  const validation = validateProjectToolDslForPersistence(input);
  if (!validation.valid) return validation;

  return {
    valid: true,
    dslContent: input.dslContent,
    sourceHash: computeSourceHash(input.dslContent),
  };
}
