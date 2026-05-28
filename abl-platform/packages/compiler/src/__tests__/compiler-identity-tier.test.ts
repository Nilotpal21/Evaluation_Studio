/**
 * Compiler Identity Tier Tests
 *
 * Validates that `identityTierRequired` on AST tools compiles to
 * `identity_tier_required` on IR ToolDefinition.
 *
 * Since the DSL parser does not yet handle `identityTierRequired`,
 * these tests parse a minimal DSL, then set the field on the AST
 * before compiling to IR.
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { compileBehaviorProfile } from '../platform/ir/compile-behavior-profile.js';
import type { ToolDefinition } from '../platform/ir/schema.js';

/** Parse a minimal agent DSL with a single tool, returning the document */
function parseMinimalAgent(toolName: string) {
  const dsl = `AGENT: test_agent
GOAL: Test agent for identity tier compilation

TOOLS:
  ${toolName}(amount: number) -> Result
    description: "Test tool"
`;
  const parseResult = parseAgentBasedABL(dsl);
  if (parseResult.errors.length > 0) {
    throw new Error(`Parse errors: ${parseResult.errors.map((e) => e.message).join('; ')}`);
  }
  expect(parseResult.document).not.toBeNull();
  return parseResult.document!;
}

describe('compiler identityTierRequired → IR', () => {
  it('compiles identityTierRequired: 2 to identity_tier_required: 2', () => {
    const doc = parseMinimalAgent('transfer_funds');
    const tool = doc.tools.find((t) => t.name === 'transfer_funds');
    expect(tool).toBeDefined();
    tool!.identityTierRequired = 2;

    const output = compileABLtoIR([doc]);
    const agent = Object.values(output.agents)[0];
    expect(agent).toBeDefined();

    const irTool = agent.tools?.find((t) => t.name === 'transfer_funds');
    expect(irTool).toBeDefined();
    expect(irTool!.identity_tier_required).toBe(2);
  });

  it('compiles identityTierRequired: 1 to identity_tier_required: 1', () => {
    const doc = parseMinimalAgent('view_account');
    const tool = doc.tools.find((t) => t.name === 'view_account');
    expect(tool).toBeDefined();
    tool!.identityTierRequired = 1;

    const output = compileABLtoIR([doc]);
    const agent = Object.values(output.agents)[0];
    const irTool = agent.tools?.find((t) => t.name === 'view_account');
    expect(irTool).toBeDefined();
    expect(irTool!.identity_tier_required).toBe(1);
  });

  it('compiles identityTierRequired: 0 to identity_tier_required: 0', () => {
    const doc = parseMinimalAgent('check_status');
    const tool = doc.tools.find((t) => t.name === 'check_status');
    expect(tool).toBeDefined();
    tool!.identityTierRequired = 0;

    const output = compileABLtoIR([doc]);
    const agent = Object.values(output.agents)[0];
    const irTool = agent.tools?.find((t) => t.name === 'check_status');
    expect(irTool).toBeDefined();
    expect(irTool!.identity_tier_required).toBe(0);
  });

  it('leaves identity_tier_required undefined when not set on AST tool', () => {
    const doc = parseMinimalAgent('public_search');
    // Do NOT set identityTierRequired on the tool

    const output = compileABLtoIR([doc]);
    const agent = Object.values(output.agents)[0];
    const irTool = agent.tools?.find((t) => t.name === 'public_search');
    expect(irTool).toBeDefined();
    expect(irTool!.identity_tier_required).toBeUndefined();
  });

  it('compiles identityTierRequired alongside other tool properties', () => {
    const doc = parseMinimalAgent('sensitive_op');
    const tool = doc.tools.find((t) => t.name === 'sensitive_op');
    expect(tool).toBeDefined();
    tool!.identityTierRequired = 2;
    tool!.piiAccess = 'user';
    tool!.confirmation = { require: 'always', immutableParams: ['amount'] };

    const output = compileABLtoIR([doc]);
    const agent = Object.values(output.agents)[0];
    const irTool = agent.tools?.find((t) => t.name === 'sensitive_op');
    expect(irTool).toBeDefined();
    expect(irTool!.identity_tier_required).toBe(2);
    expect(irTool!.pii_access).toBe('user');
    expect(irTool!.confirmation?.require).toBe('always');
  });
});

describe('compileToolDefinitionAST → identity_tier_required (behavior profile path)', () => {
  function parseProfileWithTool() {
    const profileDsl = `
BEHAVIOR_PROFILE: secure_channel
PRIORITY: 10
WHEN: context.channel == "web"

TOOLS:
  ADD:
    secure_action:
      DESCRIPTION: "Requires tier 2"
      PARAMETERS:
        - amount: number
      RETURNS: object
`;
    const result = parseAgentBasedABL(profileDsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).toBeDefined();
    return result.document!;
  }

  it('compiles identityTierRequired on profile tools.add to identity_tier_required', () => {
    const doc = parseProfileWithTool();

    // Set identityTierRequired on the tools.add entry (DSL parser doesn't handle it yet)
    const addTools = doc.behaviorProfile?.tools?.add;
    expect(addTools).toBeDefined();
    expect(addTools!.length).toBeGreaterThan(0);
    addTools![0].identityTierRequired = 2;

    const { profile, errors } = compileBehaviorProfile(doc);
    expect(errors).toHaveLength(0);

    expect(profile.tools_add).toBeDefined();
    expect(profile.tools_add!.length).toBeGreaterThan(0);
    expect(profile.tools_add![0].identity_tier_required).toBe(2);
  });

  it('leaves identity_tier_required undefined on profile tool when not set', () => {
    const doc = parseProfileWithTool();
    // Do NOT set identityTierRequired

    const { profile, errors } = compileBehaviorProfile(doc);
    expect(errors).toHaveLength(0);

    expect(profile.tools_add).toBeDefined();
    expect(profile.tools_add![0].identity_tier_required).toBeUndefined();
  });
});

describe('mergeAgentToolBehavior → identity_tier_required', () => {
  it('merges DSL identity_tier_required onto a resolved project tool', () => {
    // Parse an agent DSL that declares a tool with identityTierRequired
    const doc = parseMinimalAgent('project_lookup');
    const tool = doc.tools.find((t) => t.name === 'project_lookup');
    expect(tool).toBeDefined();
    tool!.identityTierRequired = 2;

    // Create a resolved project tool implementation for the SAME tool name
    // (this is what project_tools compilation produces — a ToolDefinition with bindings)
    const resolvedTool: ToolDefinition = {
      name: 'project_lookup',
      description: 'Look up a project (resolved from project_tools)',
      parameters: [{ name: 'amount', type: 'number', required: true }],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
      // Resolved tool does NOT have identity_tier_required — DSL must provide it
    };

    // Pass resolvedToolImplementations keyed by agent name
    const resolvedToolImplementations = new Map<string, ToolDefinition[]>();
    resolvedToolImplementations.set('test_agent', [resolvedTool]);

    const output = compileABLtoIR([doc], { resolvedToolImplementations });
    const agent = Object.values(output.agents)[0];
    expect(agent).toBeDefined();

    // The merged tool should carry identity_tier_required from the DSL
    const mergedTool = agent.tools?.find((t) => t.name === 'project_lookup');
    expect(mergedTool).toBeDefined();
    expect(mergedTool!.identity_tier_required).toBe(2);
  });

  it('does not add identity_tier_required when DSL tool does not set it', () => {
    // Parse an agent DSL that declares a tool WITHOUT identityTierRequired
    const doc = parseMinimalAgent('project_lookup');
    // Do NOT set identityTierRequired

    const resolvedTool: ToolDefinition = {
      name: 'project_lookup',
      description: 'Look up a project (resolved from project_tools)',
      parameters: [{ name: 'amount', type: 'number', required: true }],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
    };

    const resolvedToolImplementations = new Map<string, ToolDefinition[]>();
    resolvedToolImplementations.set('test_agent', [resolvedTool]);

    const output = compileABLtoIR([doc], { resolvedToolImplementations });
    const agent = Object.values(output.agents)[0];
    const mergedTool = agent.tools?.find((t) => t.name === 'project_lookup');
    expect(mergedTool).toBeDefined();
    expect(mergedTool!.identity_tier_required).toBeUndefined();
  });
});
