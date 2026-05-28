import { describe, expect, it } from 'vitest';

import { toolKind } from '../../tools/adapters/classification.js';
import { toolInputSchemas } from '../../tools/schemas/in-project-schemas.js';
import type { ToolName } from '../../types/tools.js';

const accuracyToolInputs: Array<{
  name: ToolName;
  input: unknown;
  expectedKind?: 'internal' | 'interactive';
}> = [
  { name: 'dry_run_compile', input: { agentName: 'FlowStep', code: 'AGENT: FlowStep' } },
  {
    name: 'run_feasibility_check',
    input: {
      code: 'AGENT: FlowStep',
      declaredToolNames: ['crm_lookup'],
      resolvedToolNames: ['crm_lookup'],
      checkName: 'tool-binding',
    },
  },
  {
    name: 'tools_ops',
    input: {
      action: 'create',
      toolName: 'lookup_customer',
      config: {
        type: 'http',
        endpoint: '{{env.CRM_BASE_URL}}/v1/customers/lookup',
        method: 'POST',
      },
    },
  },
  {
    name: 'auth_ops',
    input: {
      action: 'create',
      profileName: 'crm_bearer',
      authType: 'bearer',
      config: { audience: 'crm' },
    },
  },
  {
    name: 'collect_secret',
    expectedKind: 'interactive',
    input: {
      flowId: 'secret-flow-1',
      field: 'token',
      label: 'CRM bearer token',
    },
  },
  {
    name: 'integration_ops',
    input: {
      action: 'update',
      draftId: 'draft-1',
      addPendingSteps: ['collect CRM bearer token', 'test lookup_customer'],
      status: 'needs_input',
    },
  },
  { name: 'get_construct_spec', input: { construct: 'DELEGATE' } },
  { name: 'list_valid_combinations', input: { construct: 'HANDOFF' } },
  { name: 'get_cel_grammar', input: { context: 'delegate_when' } },
  { name: 'lookup_validation_code', input: { code: 'INVALID_ROUTING_TARGET' } },
  { name: 'read_blueprint', input: { section: 'topology' } },
  {
    name: 'propose_blueprint_edit',
    input: {
      sectionId: 'perAgent.SupportAgent',
      changes: { goal: 'Refine goal' },
      reason: 'User asked',
    },
  },
  { name: 'lock_blueprint_version', input: {} },
  { name: 'fork_blueprint', input: {} },
  {
    name: 'rebuild_agents_from_blueprint',
    input: { fromVersion: 1, confirmOverwriteLocalEdits: true },
  },
];

const validPlanInput = {
  title: 'Update flow delegate handling',
  goal: 'Route delegate work through the correct specialist agent.',
  summary: 'Read the relevant agents, inspect references, then update the delegate target.',
  architecturalPattern: 'Supervisor delegates to specialist worker through DELEGATE.',
  evidence: ['read_agent:FlowStep', 'find_agent_refs:SpecialistWorker'],
  affectedAgents: ['FlowStep', 'SpecialistWorker'],
  sectionsToChange: [
    {
      agentName: 'FlowStep',
      construct: 'DELEGATE',
      operation: 'modify',
      reason: 'Delegate target must match the project topology.',
    },
  ],
  dependentsAnalysis: {
    summary: 'One upstream supervisor depends on this flow step.',
    referencesFound: [
      {
        kind: 'agent',
        sourceAgent: 'Supervisor',
        targetAgent: 'FlowStep',
        detail: 'Supervisor handoff target.',
      },
    ],
  },
  alternativesConsidered: [
    {
      option: 'Edit only the currently open agent.',
      rejectedBecause: 'The request affects the dependent supervisor topology.',
    },
  ],
  citations: [
    {
      sourceType: 'construct_spec',
      reference: 'DELEGATE',
      relevance: 'Defines valid delegate target shape.',
    },
  ],
  plannedMutations: [
    {
      sourceTool: 'propose_modification',
      sourceAction: 'modify',
      targetKind: 'agent_dsl',
      operation: 'modify',
      agentName: 'FlowStep',
      rationale: 'Update delegate routing with project context.',
    },
  ],
  risks: [
    {
      severity: 'medium',
      description: 'Changing delegate topology may affect supervisor behavior.',
      mitigation: 'Inspect references and run dry-run compile before proposing the mutation.',
    },
  ],
  validationNotes: ['Knowledge Spine construct check completed.'],
};

describe('in-project tool schemas', () => {
  it('keeps compiler-backed accuracy tools classified and schema-backed', () => {
    for (const { name, input, expectedKind = 'internal' } of accuracyToolInputs) {
      expect(toolKind(name)).toBe(expectedKind);
      expect(toolInputSchemas[name], `${name} schema`).toBeDefined();
      expect(toolInputSchemas[name]?.safeParse(input).success, `${name} valid input`).toBe(true);
    }
  });

  it('requires concrete risk analysis in propose_plan input', () => {
    const schema = toolInputSchemas.propose_plan;

    expect(schema?.safeParse(validPlanInput).success).toBe(true);
    expect(schema?.safeParse({ ...validPlanInput, risks: [] }).success).toBe(false);
    expect(schema?.safeParse({ ...validPlanInput, risks: undefined }).success).toBe(false);
  });

  it('allows runtime and tool-readiness citations for tool-link plans', () => {
    const schema = toolInputSchemas.propose_plan;
    const toolPlan = {
      ...validPlanInput,
      citations: [
        {
          sourceType: 'runtime_context',
          reference: 'platform_context:list_tools',
          relevance: 'Shows whether a matching ProjectTool already exists.',
        },
        {
          sourceType: 'tool_readiness',
          reference: 'tools_ops:create',
          relevance: 'Provides agentToolBlock after ProjectTool creation.',
        },
      ],
    };

    expect(schema?.safeParse(toolPlan).success).toBe(true);
  });
});
