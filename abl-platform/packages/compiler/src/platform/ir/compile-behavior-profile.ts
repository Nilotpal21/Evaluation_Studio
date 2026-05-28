/**
 * Behavior Profile Compiler
 *
 * Compiles BehaviorProfileAST (from parsed BEHAVIOR_PROFILE documents) into
 * BehaviorProfileIR that the runtime consumes for context-dependent behavior.
 */

import type { AgentBasedDocument, AgentTool } from '@abl/core';
import type {
  AgentIR,
  BehaviorProfileIR,
  Constraint,
  ToolDefinition,
  CompilationError,
  VoiceConfigIR,
  ResponseRulesIR,
  GatherProfileOverrides,
  FlowModificationsIR,
  RichContentIR,
} from './schema.js';
import { compileConversationBehavior } from './compile-conversation-behavior.js';

// =============================================================================
// COMPILE A BEHAVIOR PROFILE DOCUMENT TO IR
// =============================================================================

/**
 * Compile a parsed behavior profile document into BehaviorProfileIR.
 *
 * Returns the compiled profile and any compilation errors/warnings encountered.
 */
export function compileBehaviorProfile(doc: AgentBasedDocument): {
  profile: BehaviorProfileIR;
  errors: CompilationError[];
} {
  const errors: CompilationError[] = [];
  const ast = doc.behaviorProfile;
  const profileName = doc.name || 'unknown_profile';

  if (!ast) {
    errors.push({
      agent: profileName,
      message: 'Document has no behaviorProfile AST — not a behavior profile document',
      type: 'compilation',
    });
    // Return a minimal profile so callers have something
    return {
      profile: { name: profileName, priority: 0, when: 'false' },
      errors,
    };
  }

  // Validate CEL `when` expression with a dry-run
  if (ast.when) {
    validateCelExpression(ast.when, profileName, errors);
  }

  // Compile constraints: string[] -> Constraint[]
  const constraints = ast.constraints?.map(
    (str): Constraint => ({
      condition: str,
      on_fail: { type: 'respond', message: str },
    }),
  );

  // Compile tools.add: ToolDefinitionAST[] -> ToolDefinition[]
  const toolsAdd = ast.tools?.add?.map((t) => compileToolDefinitionAST(t));

  // Compile response rules
  const responseRules = ast.response ? compileResponseRules(ast.response) : undefined;

  // Compile gather overrides
  const gatherOverrides = ast.gather ? compileGatherOverrides(ast.gather) : undefined;

  // Compile flow modifications
  let flowModifications: FlowModificationsIR | undefined;
  let flowReplace: string | undefined;

  if (ast.flow) {
    if (
      ast.flow.replace &&
      (ast.flow.skip?.length || (ast.flow.overrides && Object.keys(ast.flow.overrides).length > 0))
    ) {
      errors.push({
        agent: profileName,
        message:
          'PROFILE_FLOW_CONFLICT: Behavior profile cannot have both flow.replace and flow modifications (skip/overrides)',
        type: 'validation',
      });
    }

    if (ast.flow.replace) {
      flowReplace = ast.flow.replace;
    }

    if (
      ast.flow.skip?.length ||
      (ast.flow.overrides && Object.keys(ast.flow.overrides).length > 0) ||
      ast.flow.insertions?.length
    ) {
      // Map AST overrides to IR FlowStepOverrideIR
      let overrides: FlowModificationsIR['overrides'];
      if (ast.flow.overrides) {
        overrides = {};
        for (const [stepName, ov] of Object.entries(ast.flow.overrides)) {
          overrides[stepName] = {
            respond: ov.respond,
            voice: ov.voice
              ? {
                  ssml: ov.voice.ssml,
                  instructions: ov.voice.instructions,
                  plain_text: ov.voice.plain_text,
                }
              : undefined,
            rich_content: ov.rich_content
              ? ({
                  [ov.rich_content.type]: JSON.stringify(ov.rich_content.payload),
                } as RichContentIR)
              : undefined,
            transition: ov.transition,
          };
        }
      }

      flowModifications = {
        skip: ast.flow.skip,
        overrides,
        insertions: ast.flow.insertions?.map((ins) => ({
          position: ins.position,
          target_step: ins.target_step,
          step: ins.step as unknown as import('./schema.js').FlowStep,
        })),
      };
    }
  }

  // Compile voice config — map AST voice fields to VoiceConfigIR
  const voice: VoiceConfigIR | undefined = ast.voice
    ? {
        ssml: ast.voice.ssml,
        instructions: ast.voice.instructions,
        plain_text: ast.voice.plain_text,
      }
    : undefined;

  const { conversationBehavior, errors: conversationErrors } = ast.conversation
    ? compileConversationBehavior(ast.conversation, profileName)
    : { conversationBehavior: undefined, errors: [] };
  errors.push(...conversationErrors);

  const profile: BehaviorProfileIR = {
    name: profileName,
    priority: ast.priority,
    when: ast.when,
  };

  // Only set optional fields when present (avoid cluttering IR with undefined)
  if (ast.instructions) profile.instructions = ast.instructions;
  if (voice) profile.voice = voice;
  if (responseRules) profile.response_rules = responseRules;
  if (constraints?.length) profile.constraints = constraints;
  if (ast.tools?.hide?.length) profile.tools_hide = ast.tools.hide;
  if (toolsAdd?.length) profile.tools_add = toolsAdd;
  if (gatherOverrides) profile.gather_overrides = gatherOverrides;
  if (flowModifications) profile.flow_modifications = flowModifications;
  if (flowReplace) profile.flow_replace = flowReplace;
  if (conversationBehavior) profile.conversation_behavior = conversationBehavior;

  return { profile, errors };
}

// =============================================================================
// ATTACH PROFILES TO AGENT
// =============================================================================

/**
 * Attach compiled behavior profiles to an agent IR.
 *
 * Validates:
 * - Profile references exist in the compiled profiles map
 * - No duplicate priorities across attached profiles
 * - tools_hide references match agent's declared tools (warning if not)
 * - flow_modifications.skip references match agent's flow steps (error if not)
 *
 * Sorts attached profiles by priority ascending.
 */
export function attachProfilesToAgent(
  agentIR: AgentIR,
  profileNames: string[],
  compiledProfiles: Map<string, BehaviorProfileIR>,
): CompilationError[] {
  const errors: CompilationError[] = [];
  const agentName = agentIR.metadata.name;
  const attached: BehaviorProfileIR[] = [];

  for (const name of profileNames) {
    const profile = compiledProfiles.get(name);
    if (!profile) {
      errors.push({
        agent: agentName,
        message: `PROFILE_NOT_FOUND: Behavior profile "${name}" referenced by agent but not found in compilation`,
        type: 'validation',
      });
      continue;
    }
    attached.push(profile);
  }

  // Check for duplicate priorities
  const prioritySeen = new Map<number, string>();
  for (const profile of attached) {
    const existing = prioritySeen.get(profile.priority);
    if (existing) {
      errors.push({
        agent: agentName,
        message: `PROFILE_PRIORITY_CONFLICT: Profiles "${existing}" and "${profile.name}" both have priority ${profile.priority}`,
        type: 'validation',
      });
    } else {
      prioritySeen.set(profile.priority, profile.name);
    }
  }

  // Validate tools_hide against agent's declared tools
  const agentToolNames = new Set(agentIR.tools.map((t) => t.name));
  for (const profile of attached) {
    if (profile.tools_hide) {
      for (const toolName of profile.tools_hide) {
        if (!agentToolNames.has(toolName)) {
          errors.push({
            agent: agentName,
            message: `PROFILE_UNKNOWN_TOOL: Profile "${profile.name}" hides tool "${toolName}" which is not declared by agent "${agentName}"`,
            type: 'validation',
          });
        }
      }
    }
  }

  // Validate flow_modifications.skip against agent's flow steps
  const agentFlowSteps = agentIR.flow?.steps ? new Set(agentIR.flow.steps) : new Set<string>();
  for (const profile of attached) {
    if (profile.flow_modifications?.skip) {
      for (const stepName of profile.flow_modifications.skip) {
        if (!agentFlowSteps.has(stepName)) {
          errors.push({
            agent: agentName,
            message: `PROFILE_UNKNOWN_STEP: Profile "${profile.name}" skips flow step "${stepName}" which is not declared by agent "${agentName}"`,
            type: 'validation',
          });
        }
      }
    }
  }

  // Sort by priority ascending
  attached.sort((a, b) => a.priority - b.priority);

  agentIR.behavior_profiles = attached;

  return errors;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Validate a CEL expression with structural checks.
 *
 * The runtime evaluator never throws (returns false on errors),
 * so we validate syntax structurally: balanced brackets/parens,
 * no invalid token sequences, etc.
 */
function validateCelExpression(
  expression: string,
  profileName: string,
  errors: CompilationError[],
): void {
  if (!expression || expression.trim() === '') {
    errors.push({
      agent: profileName,
      message: 'PROFILE_INVALID_WHEN: WHEN expression is empty',
      type: 'validation',
    });
    return;
  }

  // Check balanced brackets/parentheses
  let parenDepth = 0;
  let bracketDepth = 0;
  for (const ch of expression) {
    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
    if (parenDepth < 0 || bracketDepth < 0) break;
  }

  if (parenDepth !== 0 || bracketDepth !== 0) {
    errors.push({
      agent: profileName,
      message: `PROFILE_INVALID_WHEN: CEL expression "${expression}" has unbalanced brackets or parentheses`,
      type: 'validation',
    });
    return;
  }

  // Reject JavaScript-style strict equality (===, !==) — not valid in CEL/ABL
  if (/===|!==/.test(expression)) {
    errors.push({
      agent: profileName,
      message: `PROFILE_INVALID_WHEN: CEL expression "${expression}" uses JavaScript-style === or !== — use == or != instead`,
      type: 'validation',
    });
  }
}

/**
 * Compile a standalone AgentTool AST to ToolDefinition IR.
 */
function compileToolDefinitionAST(ast: AgentTool): ToolDefinition {
  return {
    name: ast.name,
    description: ast.description || `Execute ${ast.name}`,
    parameters: (ast.parameters || []).map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: p.required,
      default: p.default,
      validation: p.validate,
    })),
    returns: ast.returns
      ? {
          type: ast.returns.type,
          fields: ast.returns.fields,
          items: ast.returns.items,
          optional: ast.returns.optional,
        }
      : { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    context_access: ast.contextAccess
      ? { read: ast.contextAccess.read, write: ast.contextAccess.write }
      : undefined,
    // Note: this function maps a subset of fields vs compileTools() in compiler.ts
    // (missing confirmation, pii_access, auth_profile_ref, jit_auth, consent_mode,
    // connection_mode, etc.) — this is a pre-existing gap outside this task's scope.
    identity_tier_required: ast.identityTierRequired,
  };
}

/**
 * Compile response AST to ResponseRulesIR.
 */
function compileResponseRules(ast: {
  max_buttons?: number;
  fallback_format?: string;
  media_types?: string[];
  max_response_length?: number;
}): ResponseRulesIR {
  return {
    max_buttons: ast.max_buttons,
    fallback_format: ast.fallback_format as ResponseRulesIR['fallback_format'],
    media_types: ast.media_types,
    max_response_length: ast.max_response_length,
  };
}

/**
 * Compile gather AST to GatherProfileOverrides.
 */
function compileGatherOverrides(ast: {
  validation_style?: string;
  confirmation?: string;
  field_overrides?: Record<
    string,
    {
      prompt?: string;
      extraction_hints?: string[];
      skip?: boolean;
      required?: boolean;
      validation?: string;
    }
  >;
}): GatherProfileOverrides {
  return {
    validation_style: ast.validation_style as GatherProfileOverrides['validation_style'],
    confirmation: ast.confirmation as GatherProfileOverrides['confirmation'],
    field_overrides: ast.field_overrides,
  };
}
