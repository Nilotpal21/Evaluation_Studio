/**
 * Parser exports for Agent ABL
 */

// Export lexer utilities (not individual tokens to avoid conflicts with type names)
export { AgentDSLLexer, tokenize, allTokens } from './lexer.js';

export { SupervisorParser, parseSupervisor } from './supervisor-parser.js';
export { AgentParser, parseAgent } from './agent-parser.js';
export { parseAgentBasedABL, parseBehaviorProfile } from './agent-based-parser.js';
export { parseYamlABL, isYamlFormat } from './yaml-parser.js';
export { parseToolFile } from './tool-file-parser.js';
export { resolveToolImports } from './tool-import-resolver.js';
export { parseToolParams, parseToolReturn, splitParams } from './tool-parser-utils.js';
export { parseCondition, parseExpression, expressionToPython } from './expression-parser.js';

import type { SupervisorDocument } from '../types/supervisor.js';
import type { AgentDocument } from '../types/agent.js';
import type { AgentBasedDocument } from '../types/agent-based.js';
import type { ToolFileDocument } from '../types/tool-file.js';
import { parseSupervisor } from './supervisor-parser.js';
import { parseAgent } from './agent-parser.js';
import { parseAgentBasedABL } from './agent-based-parser.js';
import { parseYamlABL, isYamlFormat } from './yaml-parser.js';
import { parseToolFile } from './tool-file-parser.js';

/**
 * Parse result type
 */
export interface ParseResult<T> {
  document: T | null;
  errors: ParseError[];
}

/**
 * Parse error type
 */
export interface ParseError {
  message: string;
  line?: number;
  column?: number;
  offset?: number;
}

/**
 * Unified parse function that detects document type
 */
export function parse(
  text: string,
  type?: 'supervisor' | 'agent' | 'agent-based' | 'yaml' | 'tools',
): ParseResult<SupervisorDocument | AgentDocument | AgentBasedDocument | ToolFileDocument> {
  const trimmed = text.trim();

  // Auto-detect type if not specified
  if (!type) {
    // Check for YAML format first (lowercase keys like `agent:`, `mode:`)
    if (isYamlFormat(trimmed)) {
      type = 'yaml';
    } else if (
      trimmed.startsWith('TOOLS:') &&
      !trimmed.includes('\nAGENT:') &&
      !trimmed.includes('\nSUPERVISOR:')
    ) {
      type = 'tools';
    } else if (trimmed.startsWith('SUPERVISOR:')) {
      // Check if it has MODE: which indicates new agent-based format
      if (trimmed.includes('\nMODE:')) {
        type = 'agent-based';
      } else {
        type = 'supervisor';
      }
    } else if (trimmed.startsWith('AGENT:')) {
      // Check if it has MODE: which indicates new agent-based format
      if (trimmed.includes('\nMODE:')) {
        type = 'agent-based';
      } else {
        type = 'agent';
      }
    } else if (trimmed.startsWith('BEHAVIOR_PROFILE:')) {
      type = 'agent-based';
    } else {
      return {
        document: null,
        errors: [
          {
            message:
              'Unable to detect document type. Document must start with SUPERVISOR:, AGENT:, BEHAVIOR_PROFILE:, or TOOLS:, or use YAML format with lowercase keys.',
            line: 1,
            column: 1,
          },
        ],
      };
    }
  }

  if (type === 'yaml') {
    const result = parseYamlABL(text);
    return {
      document: result.document,
      errors: result.errors.map((e) => ({
        message: e.message,
        line: e.line,
        column: e.column,
      })),
    };
  } else if (type === 'tools') {
    const result = parseToolFile(text);
    return {
      document: result.document,
      errors: result.errors.map((e) => ({
        message: e.message,
        line: e.line,
        column: e.column,
      })),
    };
  } else if (type === 'supervisor') {
    return parseSupervisor(text);
  } else if (type === 'agent-based') {
    const result = parseAgentBasedABL(text);
    return {
      document: result.document,
      errors: result.errors.map((e) => ({
        message: e.message,
        line: e.line,
        column: e.column,
      })),
    };
  } else {
    return parseAgent(text);
  }
}

/**
 * Validate ABL text without building full AST
 */
export function validate(text: string): ParseError[] {
  const result = parse(text);
  return result.errors;
}

/**
 * Check if ABL text is valid
 */
export function isValid(text: string): boolean {
  return validate(text).length === 0;
}
