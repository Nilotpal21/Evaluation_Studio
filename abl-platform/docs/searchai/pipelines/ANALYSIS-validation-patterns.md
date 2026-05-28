# Validation Patterns Analysis

**Task:** Pre-Check #62 - Explore existing validation patterns and middleware
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

The ABL Platform uses a **multi-layered validation architecture** with Zod schemas for REST APIs, orchestrated validators for IR/AST, and middleware for runtime type checking. Pipeline configuration validation should follow the **5-phase validation pipeline** pattern used for project tools, with machine-readable error codes and severity levels.

---

## 1. Validation Architecture Overview

### Three Validation Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Request Validation (REST API)                     │
│ - Zod schemas (safeParse)                                   │
│ - Custom validation functions                               │
│ - Manual type checking                                      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Domain Validation (Business Logic)                │
│ - IR validation (orchestrator pattern)                      │
│ - Pipeline validation (expression safety)                   │
│ - Tool validation (5-phase pipeline)                        │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Runtime Validation (Execution)                    │
│ - Result validation middleware                              │
│ - Type checking at boundaries                               │
│ - Constraint validation                                     │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight:** Pipeline configuration spans all three layers → Use Zod at Layer 1, orchestrated validators at Layer 2.

---

## 2. Zod Schema Patterns (Layer 1)

### Standard Structure

**Location:** `apps/search-ai/src/validation/index-schemas.ts`

```typescript
import { z } from 'zod';

// ─── Nested Schema ───────────────────────────────────────────────────

const VectorStoreSchema = z.object({
  provider: z.enum(['qdrant', 'pinecone', 'milvus']),
  collectionName: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'collectionName must only contain letters, numbers, hyphens, and underscores',
    ),
  connectionConfig: z.record(z.unknown()).optional(),
});

// ─── Base Schema with Extensions ─────────────────────────────────────

const BaseUseCaseConfigSchema = z.object({
  enabled: z.boolean().optional(),
  modelTier: z.enum(['fast', 'balanced', 'powerful']).optional(),
});

export const ProgressiveSummarizationConfigSchema = BaseUseCaseConfigSchema.extend({
  maxTokens: z.number().int().min(50).max(1000).optional(),
  enableDocumentSummary: z.boolean().optional(),
  documentSummaryMaxTokens: z.number().int().min(100).max(2000).optional(),
});

// ─── Main Schema ─────────────────────────────────────────────────────

export const CreateIndexSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  slug: z
    .string()
    .min(1, 'slug is required')
    .max(50, 'slug cannot exceed 50 characters')
    .regex(/^[a-z0-9-]+$/, 'slug must only contain lowercase letters, numbers, and hyphens'),
  name: z.string().min(1, 'name is required').max(100, 'name cannot exceed 100 characters'),
  description: z
    .string()
    .max(500, 'description cannot exceed 500 characters')
    .optional()
    .nullable(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().optional(),
  vectorStore: VectorStoreSchema.optional(),
  searchDefaults: SearchDefaultsSchema.optional(),
});

export const UpdateIndexSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  searchDefaults: SearchDefaultsSchema.optional(),
  status: z.enum(['creating', 'active', 'indexing', 'error']).optional(),
});
```

### Usage Pattern in Routes

**Location:** `apps/search-ai/src/routes/indexes.ts`

```typescript
router.post('/', async (req: Request, res: Response) => {
  // 1. Check tenantContext exists (401 if missing)
  const tenantId = req.tenantContext!.tenantId;

  // 2. Validate with Zod
  const validation = CreateIndexSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: validation.error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message,
      })),
    });
    return;
  }

  const { projectId, slug, name, embeddingModel, embeddingDimensions, ... } = validation.data;

  // 3. Check duplicates (409 if exists)
  const existing = await SearchIndex.findOne({ tenantId, projectId, slug }).lean();
  if (existing) {
    res.status(409).json({ error: 'Index with this slug already exists' });
    return;
  }

  // 4. Apply defaults
  const finalEmbeddingModel = embeddingModel || 'text-embedding-3-small';

  // 5. Custom validation
  const dimensionValidation = validateEmbeddingDimensions(finalEmbeddingModel, finalEmbeddingDimensions);
  if (!dimensionValidation.valid) {
    res.status(400).json({ error: dimensionValidation.error });
    return;
  }

  // 6. Create resource
  const index = await SearchIndex.create({ tenantId, projectId, slug, name, ... });

  res.status(201).json({ index });
});
```

### Validation Error Format

**Zod errors include:**

```typescript
{
  error: 'Invalid request body',
  details: [
    {
      path: 'slug',
      message: 'slug must only contain lowercase letters, numbers, and hyphens'
    },
    {
      path: 'embeddingDimensions',
      message: 'Expected number, received string'
    }
  ]
}
```

---

## 3. Custom Validation Functions

### Domain-Specific Validation

**Location:** `apps/search-ai/src/validation/index-schemas.ts`

```typescript
/**
 * Validate embedding dimensions against known model constraints.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateEmbeddingDimensions(
  model: string,
  dimensions: number | undefined,
): { valid: boolean; error?: string } {
  // Default dimensions if not specified
  if (dimensions === undefined) {
    return { valid: true };
  }

  const knownModels: Record<string, number[]> = {
    'text-embedding-3-small': [512, 1536],
    'text-embedding-3-large': [256, 1024, 3072],
    'embed-english-v3.0': [1024], // Cohere
    'bge-m3': [1024],
  };

  const supportedDimensions = knownModels[model];

  // Unknown models allow any dimension
  if (!supportedDimensions) {
    return { valid: true };
  }

  if (!supportedDimensions.includes(dimensions)) {
    return {
      valid: false,
      error: `Model "${model}" supports dimensions: ${supportedDimensions.join(', ')}. Received: ${dimensions}`,
    };
  }

  return { valid: true };
}
```

**Pattern:** Return `{ valid, error? }` object (not thrown exceptions).

---

## 4. Manual Validation Pattern

### Type Checking Without Zod

**Location:** `apps/runtime/src/validation/workflow-validation.ts`

```typescript
export interface ValidationError {
  field: string;
  message: string;
}

const VALID_TYPES = ['cx_automation', 'ex_automation', 'internal'];
const VALID_STATUSES = ['active', 'paused', 'archived'];

export function validateCreateWorkflow(params: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required fields
  if (!params.tenantId || typeof params.tenantId !== 'string' || !params.tenantId.trim()) {
    errors.push({ field: 'tenantId', message: 'Required non-empty string' });
  }

  if (!params.name || typeof params.name !== 'string' || !params.name.trim()) {
    errors.push({ field: 'name', message: 'Required non-empty string' });
  } else if ((params.name as string).length > 200) {
    errors.push({ field: 'name', message: 'Max 200 characters' });
  }

  // Optional typed fields
  if (params.type !== undefined) {
    if (typeof params.type !== 'string' || !VALID_TYPES.includes(params.type)) {
      errors.push({ field: 'type', message: `Must be one of: ${VALID_TYPES.join(', ')}` });
    }
  }

  if (params.slaMinutes !== undefined) {
    if (
      typeof params.slaMinutes !== 'number' ||
      !Number.isInteger(params.slaMinutes) ||
      params.slaMinutes <= 0
    ) {
      errors.push({ field: 'slaMinutes', message: 'Must be a positive integer' });
    }
  }

  return errors;
}
```

**When to use manual validation:**

- Runtime validation where Zod isn't available
- Dynamic field validation (not known at schema definition time)
- Migration code (validating legacy data)

---

## 5. IR Validation (Orchestrator Pattern)

### Multi-Validator Orchestrator

**Location:** `packages/compiler/src/platform/ir/validate-ir.ts`

```typescript
import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { validateCrossAgentRefs } from './validate-cross-agent.js';
import { validateFieldReferences } from './validate-field-refs.js';
import { validateGuardrailsForIR } from './guardrail-validator.js';

/**
 * Run all validators against a single agent IR.
 * Returns combined diagnostics from all validators.
 */
export function validateIR(agent: AgentIR, allAgents: AgentIR[]): ValidationDiagnostic[] {
  return [
    ...validateFlowGraph(agent),
    ...validateToolReferences(agent),
    ...validateToolDescriptions(agent),
    ...validateCrossAgentRefs(agent, allAgents),
    ...validateFieldReferences(agent),
    ...validateReservedVariableNames(agent),
    ...validateGuardrailsForIR(agent),
  ];
}
```

### Validation Diagnostic Type

**Location:** `packages/compiler/src/platform/ir/validation-types.ts`

```typescript
/**
 * Extended diagnostic with severity and machine-readable code.
 * Extends CompilationError so it's compatible with the existing error pipeline.
 */
export interface ValidationDiagnostic extends CompilationError {
  type: 'validation';
  severity: 'error' | 'warning';
  /** Machine-readable error code (e.g., 'DANGLING_STEP_REF') */
  code: string;
  /** Location within the IR (e.g., 'flow.steps.greeting.then') */
  path?: string;
}

/**
 * All validation error/warning codes.
 */
export const VALIDATION_CODES = {
  // Flow graph
  MISSING_ENTRY_POINT: 'MISSING_ENTRY_POINT',
  DANGLING_STEP_REF: 'DANGLING_STEP_REF',
  ORPHANED_STEP: 'ORPHANED_STEP',
  DUPLICATE_STEP_NAME: 'DUPLICATE_STEP_NAME',
  EMPTY_FLOW: 'EMPTY_FLOW',

  // Tool references
  UNDEFINED_TOOL_CALL: 'UNDEFINED_TOOL_CALL',

  // Cross-agent references
  INVALID_HANDOFF_TARGET: 'INVALID_HANDOFF_TARGET',
  INVALID_DELEGATE_TARGET: 'INVALID_DELEGATE_TARGET',
  INVALID_ROUTING_TARGET: 'INVALID_ROUTING_TARGET',

  // Field references
  UNDEFINED_CONDITION_VAR: 'UNDEFINED_CONDITION_VAR',

  // Tool quality
  MISSING_TOOL_DESCRIPTION: 'MISSING_TOOL_DESCRIPTION',
  MISSING_PARAM_DESCRIPTION: 'MISSING_PARAM_DESCRIPTION',

  // Variable safety
  RESERVED_VARIABLE_NAME: 'RESERVED_VARIABLE_NAME',

  // Gather depends_on
  INVALID_DEPENDS_ON_REF: 'INVALID_DEPENDS_ON_REF',
  CIRCULAR_DEPENDS_ON: 'CIRCULAR_DEPENDS_ON',

  // Input mapping
  CEL_IN_INPUT_MAPPING: 'CEL_IN_INPUT_MAPPING',

  // RECALL event validation
  UNKNOWN_RECALL_TOOL: 'UNKNOWN_RECALL_TOOL',
  UNKNOWN_RECALL_AGENT: 'UNKNOWN_RECALL_AGENT',
  UNKNOWN_RECALL_EVENT: 'UNKNOWN_RECALL_EVENT',

  // Guardrail validation
  INVALID_GUARDRAIL_ACTION: 'INVALID_GUARDRAIL_ACTION',
  GUARDRAIL_ACTION_WARNING: 'GUARDRAIL_ACTION_WARNING',
} as const;
```

### Flow Graph Validator Example

```typescript
/**
 * Validate flow step connectivity and reachability.
 */
export function validateFlowGraph(agent: AgentIR): ValidationDiagnostic[] {
  if (!agent.flow) {
    return [];
  }

  const agentName = agent.metadata.name;
  const flow = agent.flow;
  const definitions = flow.definitions;
  const stepNames = new Set(Object.keys(definitions));
  const diagnostics: ValidationDiagnostic[] = [];

  // Check for empty flow
  if (stepNames.size === 0) {
    diagnostics.push({
      agent: agentName,
      message: 'Agent has FLOW but no steps defined',
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.EMPTY_FLOW,
      path: 'flow',
    });
    return diagnostics;
  }

  // Check entry_point
  if (!flow.entry_point || !stepNames.has(flow.entry_point)) {
    diagnostics.push({
      agent: agentName,
      message: `Entry point "${flow.entry_point ?? '(undefined)'}" does not match any defined step. Available steps: ${[...stepNames].join(', ')}`,
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.MISSING_ENTRY_POINT,
      path: 'flow.entry_point',
    });
  }

  // Check all step transitions
  for (const [stepName, step] of Object.entries(definitions)) {
    const checkRef = (target: string | undefined, location: string) => {
      if (target && !stepNames.has(target)) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" references nonexistent step "${target}" in ${location}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.DANGLING_STEP_REF,
          path: `flow.steps.${stepName}.${location}`,
        });
      }
    };

    checkRef(step.then, 'then');
    checkRef(step.on_fail, 'on_fail');

    if (step.on_input) {
      for (let i = 0; i < step.on_input.length; i++) {
        checkRef(step.on_input[i].then, `on_input[${i}].then`);
      }
    }

    // ... more transition checks
  }

  // Orphan detection via BFS from entry_point
  const reachable = new Set<string>();
  const queue: string[] = [flow.entry_point];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const step = definitions[current];
    if (!step) continue;

    const targets = collectStepTargets(step);
    for (const target of targets) {
      if (stepNames.has(target) && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const stepName of stepNames) {
    if (!reachable.has(stepName)) {
      diagnostics.push({
        agent: agentName,
        message: `Step "${stepName}" is unreachable from entry point "${flow.entry_point}"`,
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.ORPHANED_STEP,
        path: `flow.steps.${stepName}`,
      });
    }
  }

  return diagnostics;
}
```

**Pattern:** Each validator is a pure function that returns `ValidationDiagnostic[]`.

---

## 6. Cross-Agent Reference Validator

### Validator with Context

**Location:** `packages/compiler/src/platform/ir/validate-cross-agent.ts`

```typescript
/**
 * Validate cross-agent references against the set of all compiled agents.
 */
export function validateCrossAgentRefs(
  agent: AgentIR,
  allAgents: AgentIR[],
): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  // Build set of known agent names
  const knownAgents = new Set(allAgents.map((a) => a.metadata.name));

  const checkAgent = (target: string, code: string, path: string, label: string) => {
    if (!knownAgents.has(target)) {
      diagnostics.push({
        agent: agentName,
        message: `${label} "${target}" does not exist in this compilation. Known agents: ${[...knownAgents].join(', ')}`,
        type: 'validation',
        severity: 'error',
        code,
        path,
      });
    }
  };

  // Handoffs
  if (agent.coordination?.handoffs) {
    for (let i = 0; i < agent.coordination.handoffs.length; i++) {
      const h = agent.coordination.handoffs[i];
      // Skip remote handoffs — they reference external agents
      if ((h as any).remote?.location === 'remote') continue;
      checkAgent(
        h.to,
        VALIDATION_CODES.INVALID_HANDOFF_TARGET,
        `coordination.handoffs[${i}].to`,
        'Handoff target',
      );
    }
  }

  // Delegates
  if (agent.coordination?.delegates) {
    for (let i = 0; i < agent.coordination.delegates.length; i++) {
      const d = agent.coordination.delegates[i];
      // Skip remote delegates
      if ((d as any).remote?.location === 'remote') continue;
      checkAgent(
        d.agent,
        VALIDATION_CODES.INVALID_DELEGATE_TARGET,
        `coordination.delegates[${i}].agent`,
        'Delegate target',
      );
    }
  }

  // Routing rules
  if (agent.routing?.rules) {
    for (let i = 0; i < agent.routing.rules.length; i++) {
      const rule = agent.routing.rules[i];
      checkAgent(
        rule.to,
        VALIDATION_CODES.INVALID_ROUTING_TARGET,
        `routing.rules[${i}].to`,
        'Routing target',
      );
    }
  }

  return diagnostics;
}
```

**Key Features:**

- Context-aware (knows about all agents in compilation)
- Skip remote references (external agents)
- Structured error path (e.g., `coordination.handoffs[0].to`)

---

## 7. Pipeline Validation

### Expression Safety & Step References

**Location:** `packages/pipeline-engine/src/pipeline/validation.ts`

```typescript
export interface ValidationError {
  stepId?: string;
  field: string;
  message: string;
}

/**
 * Validate a list of steps.
 */
function validateSteps(steps: PipelineStep[], errors: ValidationError[], prefix = ''): Set<string> {
  const stepIds = new Set<string>();

  // Check for duplicate step IDs
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      errors.push({
        stepId: step.id,
        field: `${prefix}id`,
        message: `Duplicate step ID: '${step.id}'`,
      });
    }
    stepIds.add(step.id);
  }

  // Validate each step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const activityType = step.activity ?? step.type;

    // Check activity type is known
    if (activityType && !ACTIVITY_TYPES[activityType]) {
      errors.push({
        stepId: step.id,
        field: `${prefix}type`,
        message: `Unknown activity type: '${activityType}'`,
      });
    }

    // Validate condition expression
    if (step.condition) {
      const expression = getConditionExpression(step.condition);

      if (!isSafeExpression(expression)) {
        errors.push({
          stepId: step.id,
          field: `${prefix}condition`,
          message: `Condition expression contains unsupported operations`,
        });
      }

      const refs = extractStepReferences(expression);
      const precedingStepIds = new Set(steps.slice(0, i).map((s) => s.id));

      for (const ref of refs) {
        if (!stepIds.has(ref)) {
          errors.push({
            stepId: step.id,
            field: `${prefix}condition`,
            message: `Condition references unknown step: '${ref}'`,
          });
        } else if (!precedingStepIds.has(ref)) {
          errors.push({
            stepId: step.id,
            field: `${prefix}condition`,
            message: `Condition references step '${ref}' which is not before this step`,
          });
        }
      }
    }
  }

  // Validate parallel groups are contiguous
  const parallelGroups = new Map<string, number[]>();
  for (let i = 0; i < steps.length; i++) {
    const parallel = steps[i].parallel;
    if (parallel) {
      if (!parallelGroups.has(parallel)) {
        parallelGroups.set(parallel, []);
      }
      parallelGroups.get(parallel)!.push(i);
    }
  }

  for (const [group, indices] of parallelGroups) {
    for (let j = 1; j < indices.length; j++) {
      if (indices[j] !== indices[j - 1] + 1) {
        errors.push({
          field: `${prefix}parallel`,
          message: `Parallel group '${group}' is not contiguous — steps must be adjacent`,
        });
        break;
      }
    }
  }

  return stepIds;
}

export function validatePipeline(pipeline: PipelineDefinition): ValidationError[] {
  const errors: ValidationError[] = [];

  // Validate triggers
  if (pipeline.supportedTriggers && pipeline.supportedTriggers.length > 0) {
    for (let i = 0; i < pipeline.supportedTriggers.length; i++) {
      errors.push(...validateTriggerEntry(pipeline.supportedTriggers[i], i));
    }

    // Validate trigger → strategy references
    if (pipeline.strategies) {
      const strategyKeys = new Set(Object.keys(pipeline.strategies));
      for (let i = 0; i < pipeline.supportedTriggers.length; i++) {
        const trigger = pipeline.supportedTriggers[i];
        if (!strategyKeys.has(trigger.strategy)) {
          errors.push({
            field: `supportedTriggers[${i}].strategy`,
            message: `Strategy '${trigger.strategy}' not found in pipeline strategies`,
          });
        }
      }
    }

    // Validate each strategy's steps
    if (pipeline.strategies) {
      for (const [strategyName, strategy] of Object.entries(pipeline.strategies)) {
        validateSteps(strategy.steps, errors, `strategies.${strategyName}.steps.`);
      }
    }
  }

  return errors;
}
```

**Key Validations:**

1. **Duplicate step IDs** (must be unique)
2. **Unknown activity types** (must match ACTIVITY_TYPES registry)
3. **Expression safety** (no dangerous operations)
4. **Forward references** (condition can only reference preceding steps)
5. **Parallel group contiguity** (steps must be adjacent)
6. **Trigger → strategy references** (must exist)

---

## 8. Tool Validation (5-Phase Pipeline)

### Comprehensive Validation Pipeline

**Location:** `packages/shared/src/tools/project-tool-validator.ts`

```typescript
/**
 * 5-phase validation pipeline for project_tools dslContent.
 *
 * Phases:
 *   1. Parse — Parse DSL string to tool AST via @abl/core parser
 *   2. Structural — Name format, required `type` field
 *   3. Type-Specific — Per-type field validation (endpoint, method, auth, code, server, etc.)
 *   4. Security — Plaintext secret detection in auth-related fields
 *   5. Trial Compile — Compile to IR binding (catch malformed configs)
 */

export type DiagnosticSeverity = 'error' | 'warning';

export interface ValidationDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
}

export interface ValidateToolDslContext {
  tenantId: string;
  projectId: string;
  existingNames?: string[];
}

/**
 * Validate a tool DSL content string through the 5-phase pipeline.
 */
export function validateToolDsl(
  dslContent: string,
  context: ValidateToolDslContext,
  traceEmitter?: (event: { type: string; data: Record<string, unknown> }) => void,
): ValidationResult {
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];

  // Phase 1: Parse
  let tool: any;
  try {
    tool = parseAgentBasedABL(dslContent);
  } catch (parseError) {
    errors.push({
      code: 'PARSE_ERROR',
      severity: 'error',
      message: `Failed to parse DSL: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    });
    return { valid: false, errors, warnings };
  }

  // Phase 2: Structural Validation
  errors.push(...validateStructure(tool, context));
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Phase 3: Type-Specific Validation
  const typeErrors = validateByType(tool);
  errors.push(...typeErrors.filter((d) => d.severity === 'error'));
  warnings.push(...typeErrors.filter((d) => d.severity === 'warning'));

  // Phase 4: Security Validation
  warnings.push(...validateSecurity(tool));

  // Phase 5: Trial Compile (catch malformed configs)
  try {
    if (tool.type === 'http') {
      buildHttpBindingFromProps(tool, context.tenantId, context.projectId);
    } else if (tool.type === 'sandbox') {
      buildSandboxBindingFromProps(tool, context.tenantId, context.projectId);
    }
  } catch (compileError) {
    errors.push({
      code: 'COMPILE_ERROR',
      severity: 'error',
      message: `Failed to compile tool binding: ${compileError instanceof Error ? compileError.message : String(compileError)}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Phase 2: Structural Validation
 */
function validateStructure(tool: any, context: ValidateToolDslContext): ValidationDiagnostic[] {
  const errors: ValidationDiagnostic[] = [];

  // Name format
  if (!tool.name || typeof tool.name !== 'string') {
    errors.push({
      code: 'MISSING_NAME',
      severity: 'error',
      message: 'Tool name is required',
      field: 'name',
    });
  } else if (!TOOL_NAME_REGEX.test(tool.name)) {
    errors.push({
      code: 'INVALID_NAME_FORMAT',
      severity: 'error',
      message: 'Tool name must start with lowercase letter, contain only a-z, 0-9, underscore',
      field: 'name',
    });
  }

  // Duplicate check
  if (context.existingNames?.includes(tool.name)) {
    errors.push({
      code: 'DUPLICATE_NAME',
      severity: 'error',
      message: `Tool name '${tool.name}' already exists in this project`,
      field: 'name',
    });
  }

  // Type field
  if (!tool.type || !VALID_TOOL_TYPES.has(tool.type)) {
    errors.push({
      code: 'INVALID_TYPE',
      severity: 'error',
      message: `Tool type must be one of: ${[...VALID_TOOL_TYPES].join(', ')}`,
      field: 'type',
    });
  }

  return errors;
}

/**
 * Phase 3: Type-Specific Validation
 */
function validateByType(tool: any): ValidationDiagnostic[] {
  switch (tool.type) {
    case 'http':
      return validateHttpTool(tool);
    case 'sandbox':
      return validateSandboxTool(tool);
    case 'mcp':
      return validateMcpTool(tool);
    default:
      return [];
  }
}

function validateHttpTool(tool: any): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Endpoint
  if (!tool.endpoint || typeof tool.endpoint !== 'string') {
    diagnostics.push({
      code: 'MISSING_ENDPOINT',
      severity: 'error',
      message: 'HTTP tool requires endpoint',
      field: 'endpoint',
    });
  } else {
    try {
      new URL(tool.endpoint);
    } catch {
      diagnostics.push({
        code: 'INVALID_ENDPOINT',
        severity: 'error',
        message: 'Endpoint must be a valid URL',
        field: 'endpoint',
      });
    }

    // SSRF check
    const ssrfResult = validateUrlForSSRF(tool.endpoint, getDevSSRFOptions());
    if (!ssrfResult.allowed) {
      diagnostics.push({
        code: 'SSRF_VIOLATION',
        severity: 'error',
        message: ssrfResult.reason || 'URL blocked by SSRF protection',
        field: 'endpoint',
      });
    }
  }

  // Method
  if (!tool.method || !VALID_HTTP_METHODS.has(tool.method)) {
    diagnostics.push({
      code: 'INVALID_METHOD',
      severity: 'error',
      message: `HTTP method must be one of: ${[...VALID_HTTP_METHODS].join(', ')}`,
      field: 'method',
    });
  }

  // Auth
  if (tool.auth && !VALID_AUTH_TYPES.has(tool.auth)) {
    diagnostics.push({
      code: 'INVALID_AUTH_TYPE',
      severity: 'error',
      message: `Auth type must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`,
      field: 'auth',
    });
  }

  // Timeout
  if (tool.timeout !== undefined) {
    if (
      typeof tool.timeout !== 'number' ||
      tool.timeout < MIN_TIMEOUT_MS ||
      tool.timeout > MAX_TIMEOUT_MS
    ) {
      diagnostics.push({
        code: 'INVALID_TIMEOUT',
        severity: 'error',
        message: `Timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms`,
        field: 'timeout',
      });
    }
  }

  return diagnostics;
}

/**
 * Phase 4: Security Validation (plaintext secret detection)
 */
function validateSecurity(tool: any): ValidationDiagnostic[] {
  const warnings: ValidationDiagnostic[] = [];

  const authFields = ['authConfig.token', 'authConfig.apiKey', 'authConfig.clientSecret'];

  for (const field of authFields) {
    const value = getNestedValue(tool, field);
    if (typeof value === 'string' && looksLikePlaintextSecret(value)) {
      warnings.push({
        code: 'PLAINTEXT_SECRET',
        severity: 'warning',
        message: `Field '${field}' contains what looks like a plaintext secret. Use {{secrets.SECRET_NAME}} instead.`,
        field,
      });
    }
  }

  return warnings;
}

function looksLikePlaintextSecret(value: string): boolean {
  return PLAINTEXT_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

const PLAINTEXT_SECRET_PATTERNS = [
  /^sk[-_]/i, // OpenAI-style API keys
  /^pk[-_]/i, // Public keys
  /^ghp_/i, // GitHub personal access tokens
  /^gho_/i, // GitHub OAuth tokens
  /^Bearer\s+[A-Za-z0-9\-._~+/]+=*/i, // Bearer token values
  /^Basic\s+[A-Za-z0-9+/]+=*/i, // Basic auth values
  /^eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/i, // JWT tokens
];
```

**Key Features:**

- **5 distinct phases** (parse → structural → type-specific → security → compile)
- **Early exit** on parse/structural errors (no point validating malformed input)
- **Warnings vs errors** (security issues are warnings, not blocking)
- **Context-aware** (duplicate name check requires existing tools list)
- **Trial compilation** (catch runtime issues at validation time)

---

## 9. Result Validation Middleware (Runtime)

### Type Checking at Tool Boundaries

**Location:** `packages/compiler/src/platform/constructs/executors/result-validation-middleware.ts`

```typescript
export type ValidationMode = 'warn' | 'strict';

/**
 * Create result validation middleware.
 * In 'warn' mode, logs mismatches but returns the result unchanged.
 * In 'strict' mode, throws on type mismatch.
 */
export function resultValidationMiddleware(mode: ValidationMode = 'warn'): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const result = await next(ctx);

    // Only validate if tool has a returns schema
    const returnSchema = ctx.tool?.returns;
    if (!returnSchema || result.result === null || result.result === undefined) {
      return result;
    }

    const errors = validateResult(result.result, returnSchema, '');

    if (errors.length > 0) {
      if (mode === 'strict') {
        throw new Error(
          `Tool ${ctx.toolName} result validation failed: ${errors.map((e) => e.message).join('; ')}`,
        );
      } else {
        log.warn('Tool result validation mismatches', {
          toolName: ctx.toolName,
          errors: errors.map((e) => e.message),
        });
      }
    }

    return result;
  };
}

/**
 * Validate a result value against a ToolReturnType schema.
 */
export function validateResult(
  value: unknown,
  schema: ToolReturnType,
  path: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const actualType = getActualType(value);

  // Handle optional fields
  if (schema.optional && (value === null || value === undefined)) {
    return errors;
  }

  const expectedType = schema.type.toLowerCase();

  switch (expectedType) {
    case 'string':
    case 'date':
    case 'datetime':
    case 'email':
    case 'url':
      if (typeof value !== 'string') {
        errors.push({
          path: path || 'root',
          expected: schema.type,
          actual: actualType,
          message: `${path || 'root'}: expected ${schema.type}, got ${actualType}`,
        });
      }
      break;

    case 'number':
    case 'integer':
      if (typeof value !== 'number') {
        errors.push({
          path: path || 'root',
          expected: schema.type,
          actual: actualType,
          message: `${path || 'root'}: expected ${schema.type}, got ${actualType}`,
        });
      } else if (expectedType === 'integer' && !Number.isInteger(value)) {
        errors.push({
          path: path || 'root',
          expected: 'integer',
          actual: 'number (float)',
          message: `${path || 'root'}: expected integer, got float`,
        });
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({
          path: path || 'root',
          expected: schema.type,
          actual: actualType,
          message: `${path || 'root'}: expected ${schema.type}, got ${actualType}`,
        });
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        errors.push({
          path: path || 'root',
          expected: 'array',
          actual: actualType,
          message: `${path || 'root'}: expected array, got ${actualType}`,
        });
      } else if (schema.items) {
        // Validate each array element
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateResult(value[i], schema.items, `${path}[${i}]`));
        }
      }
      break;

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({
          path: path || 'root',
          expected: 'object',
          actual: actualType,
          message: `${path || 'root'}: expected object, got ${actualType}`,
        });
      } else if (schema.properties) {
        // Validate each object property
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          const propValue = (value as Record<string, unknown>)[key];
          errors.push(...validateResult(propValue, propSchema, `${path}.${key}`));
        }
      }
      break;
  }

  return errors;
}
```

**Key Features:**

- **Middleware pattern** (wraps tool execution)
- **Two modes**: `warn` (log mismatches) vs `strict` (throw on error)
- **Recursive validation** (arrays, nested objects)
- **Optional field handling** (skip validation if null/undefined and optional)
- **Structured errors** (path, expected, actual)

---

## 10. Validation Integration Patterns

### Request Validation Flow

```typescript
// ┌─────────────────────────────────────────────────────────────┐
// │ 1. Zod Schema Validation (safeParse)                       │
// └─────────────────────────────────────────────────────────────┘
const validation = CreatePipelineSchema.safeParse(req.body);
if (!validation.success) {
  return res.status(400).json({
    error: 'Invalid request body',
    details: validation.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    })),
  });
}

const data = validation.data;

// ┌─────────────────────────────────────────────────────────────┐
// │ 2. Custom Domain Validation                                │
// └─────────────────────────────────────────────────────────────┘
const customValidation = validatePipelineFlows(data.flows);
if (!customValidation.valid) {
  return res.status(400).json({ error: customValidation.error });
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 3. Business Logic Validation (duplicates, constraints)     │
// └─────────────────────────────────────────────────────────────┘
const existing = await PipelineDefinition.findOne({
  tenantId,
  indexId,
  name: data.name,
}).lean();

if (existing) {
  return res.status(409).json({ error: 'Pipeline with this name already exists' });
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 4. Create Resource                                          │
// └─────────────────────────────────────────────────────────────┘
const pipeline = await PipelineDefinition.create({ tenantId, indexId, ...data });
res.status(201).json({ pipeline });
```

### Validation Error Response Patterns

**400 Bad Request (Schema Validation):**

```json
{
  "error": "Invalid request body",
  "details": [
    {
      "path": "flows[0].priority",
      "message": "Priority must be a positive integer"
    },
    {
      "path": "flows[0].stages[2].type",
      "message": "Unknown stage type 'custom-extraction'"
    }
  ]
}
```

**409 Conflict (Duplicate):**

```json
{
  "error": "Pipeline with this name already exists"
}
```

**Custom Validation Error:**

```json
{
  "error": "Flow selection rules validation failed",
  "details": {
    "flowId": "flow-123",
    "field": "selectionRules",
    "message": "CEL expression references undefined variable 'mimeType'"
  }
}
```

---

## 11. Validation Patterns Comparison

| Pattern               | Use Case                    | Return Type                  | Error Handling             | Context Required |
| --------------------- | --------------------------- | ---------------------------- | -------------------------- | ---------------- |
| **Zod safeParse**     | REST API request validation | `{ success, data?, error? }` | Return 400 with details    | Request body     |
| **Custom function**   | Domain-specific validation  | `{ valid, error? }`          | Return 400 with error      | Business context |
| **Manual validation** | Legacy/runtime validation   | `ValidationError[]`          | Check length > 0           | Minimal          |
| **IR orchestrator**   | IR/AST validation           | `ValidationDiagnostic[]`     | Collect all errors         | All agents       |
| **5-phase pipeline**  | Tool DSL validation         | `ValidationResult`           | Early exit on parse error  | Tenant/project   |
| **Middleware**        | Runtime type checking       | Throws or logs               | Configurable (warn/strict) | Tool schema      |

---

## 12. Validation Best Practices

### 1. Use Zod for REST API Validation

```typescript
// ✅ CORRECT - Zod schema with safeParse
const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(100),
  flows: z.array(FlowSchema).min(1, 'Pipeline must have at least one flow'),
});

const validation = CreatePipelineSchema.safeParse(req.body);
if (!validation.success) {
  res.status(400).json({ error: 'Invalid request body', details: validation.error.errors });
  return;
}

// ❌ WRONG - Manual type checking when Zod is available
if (!req.body.name || typeof req.body.name !== 'string') {
  res.status(400).json({ error: 'name must be a string' });
  return;
}
```

### 2. Return Structured Errors

```typescript
// ✅ CORRECT - Structured error with path
{
  error: 'Validation failed',
  details: [
    { path: 'flows[0].priority', message: 'Priority must be > 0' }
  ]
}

// ❌ WRONG - Generic error message
{
  error: 'Invalid pipeline'
}
```

### 3. Use Machine-Readable Error Codes

```typescript
// ✅ CORRECT - Error codes for programmatic handling
export const VALIDATION_CODES = {
  DUPLICATE_FLOW_NAME: 'DUPLICATE_FLOW_NAME',
  INVALID_STAGE_TYPE: 'INVALID_STAGE_TYPE',
  MISSING_SELECTION_RULES: 'MISSING_SELECTION_RULES',
} as const;

diagnostics.push({
  code: VALIDATION_CODES.DUPLICATE_FLOW_NAME,
  severity: 'error',
  message: `Flow name '${name}' is already used`,
  path: `flows[${index}].name`,
});

// ❌ WRONG - String literals without constants
{
  error: 'duplicate flow name';
}
```

### 4. Validate Early, Validate Often

```typescript
// ✅ CORRECT - Validate at API boundary, before business logic
router.post('/', async (req, res) => {
  // 1. Schema validation
  const validation = schema.safeParse(req.body);
  if (!validation.success) return res.status(400).json(...);

  // 2. Custom validation
  const customErrors = validateFlows(validation.data.flows);
  if (customErrors.length > 0) return res.status(400).json(...);

  // 3. Business logic
  await createPipeline(validation.data);
});

// ❌ WRONG - Validation mixed with business logic
router.post('/', async (req, res) => {
  const pipeline = await PipelineDefinition.create(req.body); // May fail on DB constraint
});
```

### 5. Separate Warnings from Errors

```typescript
// ✅ CORRECT - Warnings don't block, errors do
export interface ValidationResult {
  valid: boolean; // False only if errors.length > 0
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
}

if (!result.valid) {
  return res.status(400).json({ error: 'Validation failed', details: result.errors });
}

// Log warnings but don't block
if (result.warnings.length > 0) {
  log.warn('Validation warnings', { warnings: result.warnings });
}

// ❌ WRONG - Warnings treated as errors
if (result.errors.length > 0 || result.warnings.length > 0) {
  return res.status(400).json(...);
}
```

### 6. Use Orchestrator Pattern for Complex Validation

```typescript
// ✅ CORRECT - Orchestrator with multiple validators
export function validatePipeline(pipeline: PipelineDefinition): ValidationDiagnostic[] {
  return [
    ...validateFlowNames(pipeline),
    ...validateFlowPriorities(pipeline),
    ...validateStageReferences(pipeline),
    ...validateSelectionRules(pipeline),
    ...validateCircuitBreakerConfig(pipeline),
  ];
}

// Each validator is a pure function
function validateFlowNames(pipeline: PipelineDefinition): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const names = new Set<string>();

  for (let i = 0; i < pipeline.flows.length; i++) {
    const flow = pipeline.flows[i];
    if (names.has(flow.name)) {
      diagnostics.push({
        code: 'DUPLICATE_FLOW_NAME',
        severity: 'error',
        message: `Flow name '${flow.name}' is used multiple times`,
        path: `flows[${i}].name`,
      });
    }
    names.add(flow.name);
  }

  return diagnostics;
}

// ❌ WRONG - Single monolithic validation function
function validatePipeline(pipeline: PipelineDefinition): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // 500 lines of validation logic...

  return diagnostics;
}
```

---

## 13. Validation Checklist for Pipeline Configuration

Based on existing patterns, pipeline validation should include:

### Structural Validation (Zod Schema)

- [ ] **Name**: Required, 1-100 characters, unique within index
- [ ] **Description**: Optional, max 500 characters
- [ ] **Flows array**: Required, min 1 flow
- [ ] **Flow name**: Required per flow, unique within pipeline
- [ ] **Flow priority**: Required, integer 1-100
- [ ] **Flow selectionRules**: Optional CEL expression string
- [ ] **Flow stages**: Required array, min 1 stage
- [ ] **Stage type**: Required, must match known stage types
- [ ] **Stage config**: Type-specific validation (provider, model, etc.)

### Domain Validation (Custom Functions)

- [ ] **Duplicate flow names**: Each flow name unique
- [ ] **Priority conflicts**: No two flows with same priority
- [ ] **Selection rules syntax**: Valid CEL expressions
- [ ] **Selection rules variables**: Only use defined variables
- [ ] **Stage references**: All stage IDs exist (shared stages)
- [ ] **Conditional routing**: Forward references only (stage A → B, B comes after A)
- [ ] **Stage type availability**: All stage types enabled for tenant

### Business Logic Validation

- [ ] **Duplicate pipeline name**: Name unique within index
- [ ] **Provider availability**: All stage providers enabled for tenant
- [ ] **LLM model access**: Tenant has credentials for required models
- [ ] **Circuit breaker config**: Valid thresholds and timeouts
- [ ] **Cost estimation**: Warn if estimated cost exceeds threshold

### Security Validation

- [ ] **SSRF protection**: All HTTP endpoints validated
- [ ] **Plaintext secrets**: Warn if API keys in config (should use secrets.X)
- [ ] **Tenant isolation**: All queries include tenantId

---

## 14. Recommendations for Pipeline Validation Service

### Validation Service API

```typescript
export interface PipelineValidationService {
  /**
   * Validate pipeline definition at creation/update time.
   * Returns structured diagnostics (errors + warnings).
   */
  validatePipeline(
    pipeline: PipelineDefinitionInput,
    context: ValidationContext,
  ): Promise<ValidationResult>;

  /**
   * Validate single flow within pipeline.
   */
  validateFlow(flow: PipelineFlowInput, context: ValidationContext): Promise<ValidationResult>;

  /**
   * Validate selection rules (CEL expression).
   */
  validateSelectionRules(expression: string, context: ValidationContext): Promise<ValidationResult>;
}

export interface ValidationContext {
  tenantId: string;
  indexId: string;
  existingPipelines?: PipelineDefinition[];
  availableStageTypes?: string[];
  availableProviders?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
}

export interface ValidationDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  field?: string;
}
```

### Implementation Pattern

```typescript
import { PipelineDefinitionSchema } from './schemas.js';
import { validateSelectionRulesCEL } from './cel-validator.js';

export class PipelineValidationService {
  async validatePipeline(
    pipeline: PipelineDefinitionInput,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const errors: ValidationDiagnostic[] = [];
    const warnings: ValidationDiagnostic[] = [];

    // Phase 1: Schema validation
    const schemaValidation = PipelineDefinitionSchema.safeParse(pipeline);
    if (!schemaValidation.success) {
      for (const err of schemaValidation.error.errors) {
        errors.push({
          code: 'SCHEMA_VALIDATION_ERROR',
          severity: 'error',
          message: err.message,
          path: err.path.join('.'),
        });
      }
      return { valid: false, errors, warnings };
    }

    const data = schemaValidation.data;

    // Phase 2: Domain validation (orchestrator pattern)
    errors.push(...this.validateFlowNames(data));
    errors.push(...this.validateFlowPriorities(data));
    warnings.push(...(await this.validateSelectionRules(data, context)));
    errors.push(...this.validateStageReferences(data));
    errors.push(...this.validateStageTypes(data, context));

    // Phase 3: Business logic validation
    const businessErrors = await this.validateBusinessLogic(data, context);
    errors.push(...businessErrors.filter((d) => d.severity === 'error'));
    warnings.push(...businessErrors.filter((d) => d.severity === 'warning'));

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateFlowNames(pipeline: PipelineDefinition): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = [];
    const names = new Set<string>();

    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      if (names.has(flow.name)) {
        diagnostics.push({
          code: 'DUPLICATE_FLOW_NAME',
          severity: 'error',
          message: `Flow name '${flow.name}' is used multiple times`,
          path: `flows[${i}].name`,
        });
      }
      names.add(flow.name);
    }

    return diagnostics;
  }

  private validateFlowPriorities(pipeline: PipelineDefinition): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = [];
    const priorities = new Map<number, number>(); // priority → first index

    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      const firstIndex = priorities.get(flow.priority);

      if (firstIndex !== undefined) {
        diagnostics.push({
          code: 'DUPLICATE_FLOW_PRIORITY',
          severity: 'error',
          message: `Priority ${flow.priority} is used by flows[${firstIndex}] and flows[${i}]`,
          path: `flows[${i}].priority`,
        });
      } else {
        priorities.set(flow.priority, i);
      }
    }

    return diagnostics;
  }

  private async validateSelectionRules(
    pipeline: PipelineDefinition,
    context: ValidationContext,
  ): Promise<ValidationDiagnostic[]> {
    const diagnostics: ValidationDiagnostic[] = [];

    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      if (!flow.selectionRules) continue;

      const celValidation = await validateSelectionRulesCEL(flow.selectionRules, context);

      for (const err of celValidation.errors) {
        diagnostics.push({
          ...err,
          path: `flows[${i}].selectionRules`,
        });
      }
    }

    return diagnostics;
  }

  private validateStageReferences(pipeline: PipelineDefinition): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = [];
    const sharedStageIds = new Set(pipeline.sharedStages?.map((s) => s.id) || []);

    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];

      for (let j = 0; j < flow.stages.length; j++) {
        const stage = flow.stages[j];

        // Check if stage references a shared stage
        if (stage.ref && !sharedStageIds.has(stage.ref)) {
          diagnostics.push({
            code: 'INVALID_STAGE_REF',
            severity: 'error',
            message: `Stage references nonexistent shared stage '${stage.ref}'`,
            path: `flows[${i}].stages[${j}].ref`,
          });
        }
      }
    }

    return diagnostics;
  }

  private validateStageTypes(
    pipeline: PipelineDefinition,
    context: ValidationContext,
  ): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = [];
    const availableTypes = new Set(context.availableStageTypes || []);

    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];

      for (let j = 0; j < flow.stages.length; j++) {
        const stage = flow.stages[j];

        if (!availableTypes.has(stage.type)) {
          diagnostics.push({
            code: 'UNKNOWN_STAGE_TYPE',
            severity: 'error',
            message: `Unknown stage type '${stage.type}'. Available types: ${[...availableTypes].join(', ')}`,
            path: `flows[${i}].stages[${j}].type`,
          });
        }
      }
    }

    return diagnostics;
  }

  private async validateBusinessLogic(
    pipeline: PipelineDefinition,
    context: ValidationContext,
  ): Promise<ValidationDiagnostic[]> {
    const diagnostics: ValidationDiagnostic[] = [];

    // Check duplicate pipeline name
    if (context.existingPipelines) {
      const duplicate = context.existingPipelines.find((p) => p.name === pipeline.name);
      if (duplicate) {
        diagnostics.push({
          code: 'DUPLICATE_PIPELINE_NAME',
          severity: 'error',
          message: `Pipeline with name '${pipeline.name}' already exists`,
          field: 'name',
        });
      }
    }

    // Validate provider availability
    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];

      for (let j = 0; j < flow.stages.length; j++) {
        const stage = flow.stages[j];

        if (stage.provider && context.availableProviders) {
          if (!context.availableProviders.includes(stage.provider)) {
            diagnostics.push({
              code: 'UNAVAILABLE_PROVIDER',
              severity: 'warning',
              message: `Provider '${stage.provider}' is not enabled for this tenant`,
              path: `flows[${i}].stages[${j}].provider`,
            });
          }
        }
      }
    }

    return diagnostics;
  }
}
```

---

## 15. Validation Error Codes

### Proposed Error Codes for Pipeline Validation

```typescript
export const PIPELINE_VALIDATION_CODES = {
  // Schema validation
  SCHEMA_VALIDATION_ERROR: 'SCHEMA_VALIDATION_ERROR',

  // Flow validation
  DUPLICATE_FLOW_NAME: 'DUPLICATE_FLOW_NAME',
  DUPLICATE_FLOW_PRIORITY: 'DUPLICATE_FLOW_PRIORITY',
  EMPTY_FLOW: 'EMPTY_FLOW',

  // Selection rules
  INVALID_SELECTION_RULES_SYNTAX: 'INVALID_SELECTION_RULES_SYNTAX',
  UNDEFINED_SELECTION_RULES_VARIABLE: 'UNDEFINED_SELECTION_RULES_VARIABLE',

  // Stage validation
  UNKNOWN_STAGE_TYPE: 'UNKNOWN_STAGE_TYPE',
  INVALID_STAGE_REF: 'INVALID_STAGE_REF',
  INVALID_STAGE_CONFIG: 'INVALID_STAGE_CONFIG',
  MISSING_REQUIRED_STAGE_FIELD: 'MISSING_REQUIRED_STAGE_FIELD',

  // Provider validation
  UNAVAILABLE_PROVIDER: 'UNAVAILABLE_PROVIDER',
  MISSING_LLM_CREDENTIALS: 'MISSING_LLM_CREDENTIALS',

  // Business logic
  DUPLICATE_PIPELINE_NAME: 'DUPLICATE_PIPELINE_NAME',
  INVALID_CIRCUIT_BREAKER_CONFIG: 'INVALID_CIRCUIT_BREAKER_CONFIG',

  // Security
  SSRF_VIOLATION: 'SSRF_VIOLATION',
  PLAINTEXT_SECRET_DETECTED: 'PLAINTEXT_SECRET_DETECTED',
} as const;
```

---

## Conclusion

**Key Decisions:**

1. ✅ Use **Zod schemas** for REST API validation (Layer 1)
2. ✅ Apply **5-phase validation pipeline** pattern for pipeline configuration (Layer 2)
3. ✅ Use **orchestrator pattern** with pure validator functions (like validateIR)
4. ✅ Return **structured diagnostics** with machine-readable codes and severity
5. ✅ Separate **warnings from errors** (warnings don't block)
6. ✅ Validate **early and often** (schema → domain → business logic)
7. ✅ Use **result validation middleware** for runtime type checking (Layer 3)
8. ✅ Location: `packages/searchai-pipeline/src/validation/` (new package)

**Next:** Proceed to Task #43 (Backend Design: Pipeline validation service) with this architecture.

---

**Analysis complete.** Ready for validation service design.
