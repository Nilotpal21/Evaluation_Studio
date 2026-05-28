import { isSafeExpression, extractStepReferences } from './expression-evaluator.js';
import { ACTIVITY_TYPES } from './activity-metadata.js';
import { NodeRegistry } from './node-registry.js';
import { findReachableNodes, detectBackEdges } from './graph-utils.js';
import { ContractRegistry } from './contracts/registry.js';
import type {
  PipelineDefinition,
  PipelineStep,
  TriggerEntry,
  PipelineNode,
  ExecutionStrategy,
} from './types.js';

export interface ValidationError {
  stepId?: string;
  field: string;
  message: string;
}

/**
 * Extract the condition expression string from a step's condition,
 * which can be either a string or { expression: string }.
 */
function getConditionExpression(condition: string | { expression: string }): string {
  return typeof condition === 'string' ? condition : condition.expression;
}

/**
 * Check whether a step/activity type is known, using the registry if provided,
 * otherwise falling back to the static ACTIVITY_TYPES map.
 */
function isKnownType(type: string, registry?: NodeRegistry): boolean {
  if (registry) return registry.has(type);
  return type in ACTIVITY_TYPES;
}

/**
 * Validate a list of steps (shared between old-format and new-format strategies).
 */
function validateSteps(
  steps: PipelineStep[],
  errors: ValidationError[],
  prefix = '',
  registry?: NodeRegistry,
): Set<string> {
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
    if (activityType && !isKnownType(activityType, registry)) {
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

/**
 * Validate a single trigger entry.
 */
function validateTriggerEntry(trigger: TriggerEntry, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  if (trigger.type === 'kafka' && !trigger.kafkaTopic) {
    errors.push({
      field: `supportedTriggers[${index}]`,
      message: 'Kafka trigger requires kafkaTopic',
    });
  }
  if (trigger.type === 'schedule' && !trigger.schedule) {
    errors.push({
      field: `supportedTriggers[${index}]`,
      message: 'Schedule trigger requires schedule expression',
    });
  }
  if (!trigger.strategy) {
    errors.push({
      field: `supportedTriggers[${index}]`,
      message: 'Trigger must reference a strategy',
    });
  }
  return errors;
}

function getStrategyEntries(
  strategies: PipelineDefinition['strategies'] | Map<string, ExecutionStrategy> | undefined,
): Array<[string, ExecutionStrategy]> {
  if (!strategies) {
    return [];
  }

  if (strategies instanceof Map) {
    return Array.from(strategies.entries());
  }

  return Object.entries(strategies);
}

export function validatePipeline(
  pipeline: PipelineDefinition,
  registry?: NodeRegistry,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // ── New format: supportedTriggers + strategies ──
  if (pipeline.supportedTriggers && pipeline.supportedTriggers.length > 0) {
    // Validate each trigger entry
    for (let i = 0; i < pipeline.supportedTriggers.length; i++) {
      errors.push(...validateTriggerEntry(pipeline.supportedTriggers[i], i));
    }

    // Validate trigger → strategy references
    if (pipeline.strategies) {
      const strategyEntries = getStrategyEntries(pipeline.strategies);
      const strategyKeys = new Set(strategyEntries.map(([strategyKey]) => strategyKey));
      for (let i = 0; i < pipeline.supportedTriggers.length; i++) {
        const trigger = pipeline.supportedTriggers[i];
        if (trigger.strategy && !strategyKeys.has(trigger.strategy)) {
          errors.push({
            field: `supportedTriggers[${i}].strategy`,
            message: `Trigger '${trigger.id}' references unknown strategy '${trigger.strategy}'`,
          });
        }
      }

      // Validate steps within each strategy
      for (const [strategyKey, strategy] of strategyEntries) {
        if (!strategy.steps || strategy.steps.length === 0) {
          errors.push({
            field: `strategies.${strategyKey}`,
            message: `Strategy '${strategyKey}' must have at least one step`,
          });
        } else {
          validateSteps(strategy.steps, errors, `strategies.${strategyKey}.`, registry);
        }
      }
    }

    // Validate defaultTriggerIds is subset of supportedTriggers
    if (pipeline.defaultTriggerIds) {
      const supportedIds = new Set(pipeline.supportedTriggers.map((t) => t.id));
      for (const id of pipeline.defaultTriggerIds) {
        if (!supportedIds.has(id)) {
          errors.push({
            field: 'defaultTriggerIds',
            message: `Default trigger '${id}' not found in supportedTriggers`,
          });
        }
      }
    }

    return errors;
  }

  // ── Old format: single trigger + top-level steps ──

  // Graph-only pipelines use nodes[] instead of steps[] — skip step validation
  if (pipeline.nodes && pipeline.nodes.length > 0 && pipeline.entryNodeId) {
    return errors;
  }

  // Draft pipelines may have no steps yet (blank canvas)
  if (!pipeline.steps || pipeline.steps.length === 0) {
    if (pipeline.status === 'draft' || !pipeline.status) {
      return errors;
    }
    errors.push({ field: 'steps', message: 'Pipeline must have at least one step' });
    return errors;
  }

  validateSteps(pipeline.steps, errors, '', registry);

  // Validate trigger configuration
  if (pipeline.trigger) {
    if (pipeline.trigger.type === 'kafka' && !pipeline.trigger.kafkaTopic) {
      errors.push({
        field: 'trigger',
        message: 'Kafka trigger requires kafkaTopic',
      });
    }

    if (pipeline.trigger.type === 'schedule' && !pipeline.trigger.schedule) {
      errors.push({
        field: 'trigger',
        message: 'Schedule trigger requires schedule (cron expression)',
      });
    }

    if (
      pipeline.trigger.type === 'kafka' &&
      pipeline.trigger.kafkaTopic?.startsWith('abl.') &&
      !pipeline.trigger.eventFilter
    ) {
      errors.push({
        field: 'trigger',
        message:
          'Platform event topics (abl.*) require an eventFilter for scoping (e.g., projectId, agentName)',
      });
    }
  }

  return errors;
}

/**
 * Validate that activeTriggers are a subset of supported triggers.
 */
export function validateActiveTriggers(
  activeTriggers: string[],
  definition: PipelineDefinition,
): ValidationError[] {
  const supportedIds = new Set((definition.supportedTriggers ?? []).map((t) => t.id));
  const invalid = activeTriggers.filter((id) => !supportedIds.has(id));
  if (invalid.length > 0) {
    return [
      {
        field: 'activeTriggers',
        message: `Invalid trigger IDs: ${invalid.join(', ')}. Valid: ${[...supportedIds].join(', ')}`,
      },
    ];
  }
  return [];
}

// ── Graph-Based Pipeline Validation ──

export interface GraphValidationResult {
  errors: ValidationError[];
  warnings?: string[];
}

/**
 * Validate a graph-based pipeline definition against a node registry.
 *
 * Checks:
 * 1. Duplicate node IDs
 * 2. Entry node exists
 * 3. Node type exists in registry (top-level and node-group children)
 * 4. Config validation against registry schema
 * 5. Transition targets exist
 * 6. Orphan detection (unreachable nodes)
 * 7. Back-edge targets without sufficient maxVisits
 */
/**
 * Lazy singleton — ContractRegistry is pure static data, safe to share across
 * validation calls. Constructing it is cheap (in-memory hydration from JSON and
 * code constants), but avoiding repeat construction keeps validation hot paths fast.
 */
let _defaultContractRegistry: ContractRegistry | null = null;
function getDefaultContractRegistry(): ContractRegistry {
  if (!_defaultContractRegistry) {
    _defaultContractRegistry = new ContractRegistry();
  }
  return _defaultContractRegistry;
}

export function validateGraphPipeline(
  definition: PipelineDefinition,
  registry: NodeRegistry,
  contractRegistry?: ContractRegistry,
): GraphValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  const nodes = definition.nodes ?? [];
  const entryNodeId = definition.entryNodeId ?? '';

  // Build node ID set and check for duplicates
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      errors.push({
        stepId: node.id,
        field: 'nodes',
        message: `Duplicate node ID: '${node.id}'`,
      });
    }
    nodeIds.add(node.id);
  }

  // Check entry node exists
  if (!nodeIds.has(entryNodeId)) {
    errors.push({
      field: 'entryNodeId',
      message: `Entry node '${entryNodeId}' not found in nodes`,
    });
  }

  // Validate each node
  for (const node of nodes) {
    // Check node type exists in registry
    if (!registry.has(node.type)) {
      errors.push({
        stepId: node.id,
        field: 'type',
        message: `Unknown node type: '${node.type}'`,
      });
    } else {
      // Validate config against registry schema
      const configResult = registry.validateConfig(node.type, node.config ?? {});
      if (!configResult.valid) {
        for (const configError of configResult.errors) {
          errors.push({
            stepId: node.id,
            field: 'config',
            message: configError,
          });
        }
      }
    }

    // Check transition targets exist
    for (const transition of node.transitions) {
      if (!nodeIds.has(transition.target)) {
        errors.push({
          stepId: node.id,
          field: 'transitions',
          message: `Transition target '${transition.target}' not found in nodes`,
        });
      }
    }

    // Multiple unconditional transitions — only the first will ever execute.
    // Use a node-group for parallel execution or add conditions to distinguish paths.
    if (node.transitions.length > 1) {
      const unconditional = node.transitions.filter((t) => !t.condition);
      if (unconditional.length > 1) {
        errors.push({
          stepId: node.id,
          field: 'transitions',
          message: `Node has ${unconditional.length} unconditional transitions — only the first will execute. Use a node-group for parallel execution, or add conditions to distinguish paths`,
        });
      }
    }

    // Validate node-group children
    if (node.children) {
      for (const child of node.children) {
        if (!registry.has(child.type)) {
          errors.push({
            stepId: child.id,
            field: 'type',
            message: `Unknown node type: '${child.type}'`,
          });
        } else {
          const childConfigResult = registry.validateConfig(child.type, child.config ?? {});
          if (!childConfigResult.valid) {
            for (const configError of childConfigResult.errors) {
              errors.push({
                stepId: child.id,
                field: 'config',
                message: configError,
              });
            }
          }
        }
      }
    }
  }

  // Orphan detection — only when entry node exists
  if (nodeIds.has(entryNodeId) && nodes.length > 0) {
    const reachable = findReachableNodes(nodes, entryNodeId);
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        warnings.push(`Node '${node.id}' is unreachable from entry node`);
      }
    }
  }

  // Back-edge detection — warn if target lacks sufficient maxVisits
  if (nodeIds.has(entryNodeId) && nodes.length > 0) {
    const nodeMap = new Map<string, PipelineNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    const backEdges = detectBackEdges(nodes, entryNodeId);
    for (const edge of backEdges) {
      const targetNode = nodeMap.get(edge.to);
      if (targetNode && (!targetNode.maxVisits || targetNode.maxVisits <= 1)) {
        warnings.push(
          `Back-edge from '${edge.from}' to '${edge.to}': target node has no maxVisits > 1 — loop may run only once`,
        );
      }
    }
  }

  // ── Trigger validation (graph pipelines) ──
  if (definition.trigger) {
    const trigger = definition.trigger;

    if (trigger.type === 'schedule') {
      errors.push({
        field: 'trigger',
        message: 'Schedule triggers are not yet supported for graph pipelines',
      });
    }

    if (trigger.type === 'kafka') {
      if (!trigger.kafkaTopic) {
        errors.push({
          field: 'trigger',
          message: 'Kafka trigger requires kafkaTopic',
        });
      } else if (trigger.kafkaTopic.startsWith('abl.') && !trigger.eventFilter) {
        errors.push({
          field: 'trigger',
          message:
            'Platform event topics (abl.*) require an eventFilter for scoping (e.g., projectId, agentName)',
        });
      }
    }
  }

  // ── Contract-based trigger↔entry-node compat (ABLP-564 Phase 2) ──
  // Only runs when the caller opts in by providing a ContractRegistry.
  // Legacy pipelines (no contractVersion stamp on the entry node) downgrade
  // hard errors to warnings so existing production pipelines keep loading.
  if (contractRegistry) {
    validateEntryNodeTriggerCompat(definition, contractRegistry, errors, warnings);
    validateNodeInputDataFlow(definition, contractRegistry, errors, warnings);
  }

  return {
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Cross-check the entry node's NodeContract.inputRequirements against every
 * supportedTriggers[].id's TriggerContract.outputSchema.
 *
 * Two classes of problem:
 *   1. compatibleTriggers allowlist violation — node fundamentally can't run
 *      with this trigger (e.g. read-message-window + session-ended).
 *   2. Required trigger field missing — node needs a field the trigger doesn't
 *      provide (e.g. read-message-window needs `payload`, session-ended doesn't).
 *
 * Legacy behaviour: if the entry node has no `contractVersion` stamp, both
 * classes are logged as warnings instead of errors.
 */
function validateEntryNodeTriggerCompat(
  definition: PipelineDefinition,
  contractRegistry: ContractRegistry,
  errors: ValidationError[],
  warnings: string[],
): void {
  const nodes = definition.nodes ?? [];
  const entryNodeId = definition.entryNodeId;
  if (!entryNodeId) return;

  const entryNode = nodes.find((n) => n.id === entryNodeId);
  if (!entryNode) return; // other validator branches already flagged the missing entry node

  const nodeContract = contractRegistry.getNode(entryNode.type);
  if (!nodeContract) return; // unknown node type — other validator branches flag it

  // Collect trigger IDs from both legacy `.trigger` and modern `.supportedTriggers`.
  const triggerIds: string[] = [];
  if (definition.supportedTriggers) {
    for (const t of definition.supportedTriggers) {
      if (t.id) triggerIds.push(t.id);
    }
  }
  if (triggerIds.length === 0) return; // no triggers to check against

  // Legacy pipelines (no contractVersion stamp) get warnings instead of errors.
  const isLegacy = entryNode.contractVersion === undefined;

  for (const triggerId of triggerIds) {
    const triggerContract = contractRegistry.getTrigger(triggerId);
    if (!triggerContract) continue; // unknown trigger id — skip silently

    // (1) Allowlist check
    if (
      nodeContract.compatibleTriggers !== '*' &&
      !nodeContract.compatibleTriggers.includes(triggerId)
    ) {
      const msg = `Node '${entryNode.type}' is not compatible with trigger '${triggerId}'. Compatible triggers: ${nodeContract.compatibleTriggers.join(', ')}`;
      if (isLegacy) {
        warnings.push(msg);
      } else {
        errors.push({ stepId: entryNode.id, field: 'type', message: msg });
      }
      continue; // no point checking field requirements if the node is fundamentally wrong
    }

    // (2) Required trigger-field check
    // A trigger satisfies a node's required field if the field is in EITHER
    // outputSchema.required (always present) OR outputSchema.properties
    // (declared/possibly present). The manual trigger, for example, lists
    // tenantId as required + sessionId as optional in properties — that's
    // enough for read-conversation to wire up, since the Studio test drawer
    // collects sessionId at run time.
    const triggerProvides = new Set<string>([
      ...triggerContract.outputSchema.required,
      ...Object.keys(triggerContract.outputSchema.properties ?? {}),
    ]);
    for (const required of nodeContract.inputRequirements.fromTrigger) {
      if (!triggerProvides.has(required)) {
        const provided = [...triggerProvides].join(', ') || 'empty';
        const msg = `Node '${entryNode.type}' requires '${required}' from trigger, but '${triggerId}' does not declare it (trigger outputSchema: ${provided})`;
        if (isLegacy) {
          warnings.push(msg);
        } else {
          errors.push({
            stepId: entryNode.id,
            field: 'inputRequirements',
            message: msg,
          });
        }
      }
    }
  }
}

/**
 * Cross-check every node's NodeContract.inputRequirements.fromPreviousSteps
 * against the outputSchema of its directly connected upstream nodes.
 *
 * This deliberately uses only immediate incoming transitions. An ancestor's
 * output is not considered available unless an intermediate node explicitly
 * forwards it in its own output contract.
 */
function validateNodeInputDataFlow(
  definition: PipelineDefinition,
  contractRegistry: ContractRegistry,
  errors: ValidationError[],
  warnings: string[],
): void {
  const nodes = definition.nodes ?? [];
  if (nodes.length === 0) return;

  const nodeById = new Map<string, PipelineNode>(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, PipelineNode[]>();

  for (const source of nodes) {
    for (const transition of source.transitions) {
      const target = nodeById.get(transition.target);
      if (!target) continue; // dangling targets are reported by structural validation

      const incoming = incomingByTarget.get(target.id) ?? [];
      incoming.push(source);
      incomingByTarget.set(target.id, incoming);
    }
  }

  for (const node of nodes) {
    const nodeContract = contractRegistry.getNode(node.type);
    if (!nodeContract) continue; // unknown node type is reported by registry validation

    const requiredFields = collectPreviousStepRequirements(
      nodeContract.inputRequirements.fromPreviousSteps,
    );
    if (requiredFields.length === 0) continue;

    const upstreamNodes = incomingByTarget.get(node.id) ?? [];
    const providedFields = new Set<string>();
    const upstreamLabels: string[] = [];

    for (const upstreamNode of upstreamNodes) {
      upstreamLabels.push(`${upstreamNode.id}:${upstreamNode.type}`);
      const upstreamContract = contractRegistry.getNode(upstreamNode.type);
      const outputProperties = upstreamContract?.outputSchema.properties ?? {};
      for (const field of Object.keys(outputProperties)) {
        providedFields.add(field);
      }
    }

    for (const requiredField of requiredFields) {
      if (providedFields.has(requiredField)) continue;

      const msg = buildMissingPreviousStepFieldMessage(
        node,
        requiredField,
        upstreamLabels,
        [...providedFields].sort(),
      );
      pushContractValidationIssue(
        node,
        'inputRequirements.fromPreviousSteps',
        msg,
        errors,
        warnings,
      );
    }
  }
}

function collectPreviousStepRequirements(
  requirements: Record<string, string[]> | undefined,
): string[] {
  if (!requirements) return [];

  const fields = new Set<string>();
  for (const requiredFields of Object.values(requirements)) {
    for (const field of requiredFields) {
      fields.add(field);
    }
  }

  return [...fields].sort();
}

function buildMissingPreviousStepFieldMessage(
  node: PipelineNode,
  requiredField: string,
  upstreamLabels: string[],
  providedFields: string[],
): string {
  const upstreamSummary =
    upstreamLabels.length > 0 ? upstreamLabels.join(', ') : 'no direct upstream nodes';
  const providedSummary = providedFields.length > 0 ? providedFields.join(', ') : 'empty';

  return `Node '${node.id}' (${node.type}) requires previous step field '${requiredField}', but direct upstream nodes (${upstreamSummary}) provide: ${providedSummary}`;
}

function pushContractValidationIssue(
  node: PipelineNode,
  field: string,
  message: string,
  errors: ValidationError[],
  warnings: string[],
): void {
  if (node.contractVersion === undefined) {
    warnings.push(message);
    return;
  }

  errors.push({
    stepId: node.id,
    field,
    message,
  });
}

// ── Model-Provider Compatibility Validation ──

/**
 * Validate that model overrides in node configs are compatible with the
 * tenant's configured LLM provider.
 *
 * This is async because it resolves credentials from the database.
 * Call this after structural validation passes to prevent saving pipelines
 * with provider-incompatible models (e.g. "gpt-4o-mini" on an Anthropic tenant).
 */
export async function validateNodeModels(
  definition: PipelineDefinition,
  tenantId: string,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const nodes = definition.nodes ?? [];
  if (nodes.length === 0) return errors;

  // Collect all nodes (including node-group children) that specify a model
  const nodesWithModel: Array<{ id: string; model: string }> = [];
  for (const node of nodes) {
    const model = (node.config as Record<string, unknown> | undefined)?.model;
    if (typeof model === 'string' && model) {
      nodesWithModel.push({ id: node.id, model });
    }
    if (node.children) {
      for (const child of node.children) {
        const childModel = (child.config as Record<string, unknown> | undefined)?.model;
        if (typeof childModel === 'string' && childModel) {
          nodesWithModel.push({ id: child.id, model: childModel });
        }
      }
    }
  }

  if (nodesWithModel.length === 0) return errors;

  // Validate that each referenced model exists as an active TenantModel
  try {
    const { TenantModel } = await import('@agent-platform/database/models');
    for (const { id, model } of nodesWithModel) {
      const tm = await TenantModel.findOne({
        tenantId,
        modelId: model,
        isActive: true,
        inferenceEnabled: true,
      }).lean();
      if (!tm) {
        errors.push({
          stepId: id,
          field: 'config.model',
          message: `Model '${model}' is not configured or not active for this tenant.`,
        });
      }
    }
  } catch {
    // DB unavailable — skip model validation (will fail at runtime)
  }

  return errors;
}
