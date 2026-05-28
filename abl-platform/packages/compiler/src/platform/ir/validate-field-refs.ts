/**
 * Field Reference Validator
 *
 * Checks that variables referenced in conditions can be resolved
 * from known sources. All diagnostics are warnings.
 */

import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';
import { extractVariableReferences } from './compiler.js';
import { BUILTIN_FIELD_REFERENCE_VARS } from '../contracts/contract-source-data.js';
import { getActionHandlerActions } from './action-handler-utils.js';

/** Built-in context variables available at runtime */
const BUILTIN_VARS = new Set<string>(BUILTIN_FIELD_REFERENCE_VARS);
const BUILTIN_DOTTED_ROOTS = new Set([
  'caller',
  'context',
  'env',
  'interaction',
  'metadata',
  'sentiment',
  'session',
  'user',
  'workflow',
  '_context',
]);
const ROUTING_INTENT_VAR = 'routing_intent';
const INTENT_CATEGORY_PATH = 'intent.category';

interface ConsumerReference {
  variable: string;
  path: string;
}

function isRoutingDecisionPath(path: string): boolean {
  return path.startsWith('routing.rules[') || path.startsWith('coordination.handoffs[');
}

function addKnownVar(knownVars: Set<string>, value: string | undefined): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }
  const normalized = value.trim();
  knownVars.add(normalized);
  if (normalized.includes('.')) {
    knownVars.add(normalized.split('.')[0]);
  }
}

function addSetKeys(knownVars: Set<string>, setValues: Record<string, unknown> | undefined): void {
  if (!setValues) {
    return;
  }

  for (const key of Object.keys(setValues)) {
    addKnownVar(knownVars, key);
  }
}

function isKnownVariableReference(knownVars: Set<string>, variable: string): boolean {
  if (knownVars.has(variable)) {
    return true;
  }

  if (!variable.includes('.')) {
    return false;
  }

  const root = variable.split('.')[0];
  return knownVars.has(root) || BUILTIN_DOTTED_ROOTS.has(root);
}

function addConsumerReference(
  consumerVars: Set<string>,
  value: string | undefined,
  references?: ConsumerReference[],
  path?: string,
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }

  const normalized = value.trim();
  consumerVars.add(normalized);
  if (references && path) {
    references.push({ variable: normalized, path });
  }
  if (normalized.includes('.')) {
    consumerVars.add(normalized.split('.')[0]);
  }
}

function addConsumerReferencesFromExpression(
  consumerVars: Set<string>,
  expression: string | undefined,
  references?: ConsumerReference[],
  path?: string,
): void {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    return;
  }

  for (const variable of extractVariableReferences(expression)) {
    addConsumerReference(consumerVars, variable, references, path);
  }
}

function addConsumerReferencesFromTemplate(
  consumerVars: Set<string>,
  template: string | undefined,
  references?: ConsumerReference[],
  path?: string,
): void {
  if (typeof template !== 'string' || template.trim().length === 0) {
    return;
  }

  const placeholderPattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = placeholderPattern.exec(template)) !== null) {
    addConsumerReferencesFromExpression(consumerVars, match[1], references, path);
  }
}

function addConsumerReferencesFromRecordExpressions(
  consumerVars: Set<string>,
  values: Record<string, unknown> | undefined,
  references?: ConsumerReference[],
  path?: string,
): void {
  if (!values) {
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      addConsumerReferencesFromExpression(
        consumerVars,
        value,
        references,
        path ? `${path}.${key}` : undefined,
      );
    }
  }
}

function addConsumerReferencesFromInputValue(
  consumerVars: Set<string>,
  value: unknown,
  references?: ConsumerReference[],
  path?: string,
): void {
  if (typeof value !== 'string') {
    return;
  }

  addConsumerReferencesFromTemplate(consumerVars, value, references, path);
  if (/^[A-Za-z_]\w*(?:\.\w+)*$/.test(value.trim())) {
    addConsumerReference(consumerVars, value);
  }
}

function addConsumerReferencesFromInputRecord(
  consumerVars: Set<string>,
  values: Record<string, unknown> | undefined,
  references?: ConsumerReference[],
  path?: string,
): void {
  if (!values) {
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    addConsumerReferencesFromInputValue(
      consumerVars,
      value,
      references,
      path ? `${path}.${key}` : undefined,
    );
  }
}

function addConsumerReferencesFromToolInvocation(
  consumerVars: Set<string>,
  callSpec: { with?: Record<string, unknown> } | undefined,
  references?: ConsumerReference[],
  path?: string,
): void {
  addConsumerReferencesFromInputRecord(consumerVars, callSpec?.with, references, path);
}

function doesReferenceGatherField(reference: string, fieldName: string): boolean {
  return reference === fieldName || reference.startsWith(`${fieldName}.`);
}

function getDigressionActions(digression: {
  do?: Array<{
    respond?: string;
    set?: Record<string, unknown>;
    call_spec?: { as?: string; with?: Record<string, unknown> };
    on_return?: { map?: Record<string, string> };
  }>;
  respond?: string;
  set?: Record<string, unknown>;
  call_spec?: { as?: string; with?: Record<string, unknown> };
}): Array<{
  respond?: string;
  set?: Record<string, unknown>;
  call_spec?: { as?: string; with?: Record<string, unknown> };
  on_return?: { map?: Record<string, string> };
}> {
  if (digression.do && digression.do.length > 0) {
    return digression.do;
  }

  if (digression.set || digression.call_spec) {
    return [{ respond: digression.respond, set: digression.set, call_spec: digression.call_spec }];
  }

  return [];
}

/**
 * Validate that condition variables can be resolved from known sources.
 * Returns warnings only — runtime context can inject dynamic values.
 */
export function validateFieldReferences(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  // Build the set of known variable names
  const knownVars = new Set<string>(BUILTIN_VARS);
  const consumerVars = new Set<string>();
  const consumerReferences: ConsumerReference[] = [];
  const requiredGatherFields: Array<{ name: string; path: string }> = [];

  // Top-level gather fields
  if (agent.gather?.fields) {
    for (let i = 0; i < agent.gather.fields.length; i++) {
      const field = agent.gather.fields[i];
      knownVars.add(field.name);
      for (const dependency of field.depends_on ?? []) {
        addConsumerReference(consumerVars, dependency);
      }
      if (field.required && field.activation !== 'optional') {
        requiredGatherFields.push({ name: field.name, path: `gather.fields[${i}]` });
      }
    }
  }

  // Session variables
  if (agent.memory?.session) {
    for (const sv of agent.memory.session) {
      knownVars.add(sv.name);
    }
  }

  for (let i = 0; i < (agent.memory?.remember?.length ?? 0); i++) {
    const remember = agent.memory!.remember[i];
    addKnownVar(knownVars, remember.store.target);
    addConsumerReferencesFromExpression(
      consumerVars,
      remember.store.value,
      consumerReferences,
      `memory.remember[${i}].store.value`,
    );
  }

  // Tool return fields — top-level fields from tool return types
  // are available as variables in conditions (e.g., tool returns {status: string}
  // means "status" is a known variable)
  if (agent.tools) {
    for (const tool of agent.tools) {
      if (tool.store_result !== false) {
        knownVars.add(`last_${tool.name}_result`);
      }
      addSetKeys(knownVars, tool.on_result?.set);
      addSetKeys(knownVars, tool.on_error?.set);
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        tool.on_result?.set,
        consumerReferences,
        `tools.${tool.name}.on_result.set`,
      );
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        tool.on_error?.set,
        consumerReferences,
        `tools.${tool.name}.on_error.set`,
      );
      if (tool.returns?.fields) {
        for (const fieldName of Object.keys(tool.returns.fields)) {
          knownVars.add(fieldName);
        }
      }
    }
  }

  addSetKeys(knownVars, agent.on_start?.set);
  addConsumerReferencesFromTemplate(
    consumerVars,
    agent.on_start?.respond,
    consumerReferences,
    'on_start.respond',
  );
  addConsumerReferencesFromRecordExpressions(
    consumerVars,
    agent.on_start?.set,
    consumerReferences,
    'on_start.set',
  );
  addKnownVar(knownVars, agent.on_start?.call_spec?.as);
  addConsumerReferencesFromToolInvocation(
    consumerVars,
    agent.on_start?.call_spec,
    consumerReferences,
    'on_start.call_spec.with',
  );

  for (const delegate of agent.coordination?.delegates ?? []) {
    addKnownVar(knownVars, delegate.use_result);
    addConsumerReferencesFromInputRecord(
      consumerVars,
      delegate.input,
      consumerReferences,
      `coordination.delegates.${delegate.agent}.input`,
    );
    for (const parentVar of Object.values(delegate.returns ?? {})) {
      addKnownVar(knownVars, parentVar);
      addConsumerReference(consumerVars, parentVar);
    }
  }

  for (const handoff of agent.coordination?.handoffs ?? []) {
    for (const passField of handoff.context?.pass ?? []) {
      addConsumerReference(consumerVars, passField.name);
    }
    if (handoff.on_return && typeof handoff.on_return === 'object' && handoff.on_return.map) {
      for (const parentVar of Object.values(handoff.on_return.map)) {
        addKnownVar(knownVars, parentVar);
        addConsumerReference(consumerVars, parentVar);
      }
    }
  }

  for (const handler of agent.action_handlers ?? []) {
    for (const action of getActionHandlerActions(handler)) {
      addSetKeys(knownVars, action.set);
      addConsumerReferencesFromTemplate(
        consumerVars,
        action.respond,
        consumerReferences,
        `action_handlers.${handler.action_id}.respond`,
      );
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        action.set,
        consumerReferences,
        `action_handlers.${handler.action_id}.set`,
      );
      addConsumerReferencesFromToolInvocation(
        consumerVars,
        action.call_spec,
        consumerReferences,
        `action_handlers.${handler.action_id}.call_spec.with`,
      );
      for (const parentVar of Object.values(action.on_return?.map ?? {})) {
        addKnownVar(knownVars, parentVar);
        addConsumerReference(consumerVars, parentVar);
      }
    }
  }

  // Per-step gather fields
  if (agent.flow?.definitions) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      if (step.gather?.fields) {
        for (const field of step.gather.fields) {
          knownVars.add(field.name);
        }
        for (let i = 0; i < step.gather.fields.length; i++) {
          const field = step.gather.fields[i];
          for (const dependency of field.depends_on ?? []) {
            addConsumerReference(consumerVars, dependency);
          }
          if (field.required !== false && field.activation !== 'optional') {
            requiredGatherFields.push({
              name: field.name,
              path: `flow.steps.${stepName}.gather.fields[${i}]`,
            });
          }
        }
      }
      // call_as bindings are also known variables
      if (step.call_as) {
        knownVars.add(step.call_as);
      }
      addKnownVar(knownVars, step.call_spec?.as);
      addConsumerReferencesFromTemplate(
        consumerVars,
        step.present,
        consumerReferences,
        `flow.steps.${stepName}.present`,
      );
      addConsumerReferencesFromTemplate(
        consumerVars,
        step.respond,
        consumerReferences,
        `flow.steps.${stepName}.respond`,
      );
      addConsumerReferencesFromInputRecord(
        consumerVars,
        step.call_with,
        consumerReferences,
        `flow.steps.${stepName}.call_with`,
      );
      addConsumerReferencesFromToolInvocation(
        consumerVars,
        step.call_spec,
        consumerReferences,
        `flow.steps.${stepName}.call_spec.with`,
      );
      if (step.set) {
        for (let i = 0; i < step.set.length; i++) {
          const assignment = step.set[i];
          addKnownVar(knownVars, assignment.variable);
          addConsumerReferencesFromExpression(
            consumerVars,
            assignment.expression,
            consumerReferences,
            `flow.steps.${stepName}.set[${i}].expression`,
          );
        }
      }
      addKnownVar(knownVars, step.transform?.target);
      addKnownVar(knownVars, step.transform?.item_var);
      addConsumerReferencesFromExpression(
        consumerVars,
        step.transform?.source,
        consumerReferences,
        `flow.steps.${stepName}.transform.source`,
      );
      addConsumerReferencesFromExpression(
        consumerVars,
        step.transform?.filter,
        consumerReferences,
        `flow.steps.${stepName}.transform.filter`,
      );
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        step.transform?.map,
        consumerReferences,
        `flow.steps.${stepName}.transform.map`,
      );
      addConsumerReferencesFromExpression(consumerVars, step.transform?.sort_by?.field);
      for (const branch of step.on_input ?? []) {
        addSetKeys(knownVars, branch.set);
        addConsumerReferencesFromTemplate(
          consumerVars,
          branch.respond,
          consumerReferences,
          `flow.steps.${stepName}.on_input.respond`,
        );
        addConsumerReferencesFromRecordExpressions(
          consumerVars,
          branch.set,
          consumerReferences,
          `flow.steps.${stepName}.on_input.set`,
        );
        addKnownVar(knownVars, branch.call_spec?.as);
        addConsumerReferencesFromToolInvocation(
          consumerVars,
          branch.call_spec,
          consumerReferences,
          `flow.steps.${stepName}.on_input.call_spec.with`,
        );
      }
      for (const branch of step.on_result ?? []) {
        addSetKeys(knownVars, branch.set);
        addConsumerReferencesFromTemplate(
          consumerVars,
          branch.respond,
          consumerReferences,
          `flow.steps.${stepName}.on_result.respond`,
        );
        addConsumerReferencesFromRecordExpressions(
          consumerVars,
          branch.set,
          consumerReferences,
          `flow.steps.${stepName}.on_result.set`,
        );
        addKnownVar(knownVars, branch.call_spec?.as);
        addConsumerReferencesFromToolInvocation(
          consumerVars,
          branch.call_spec,
          consumerReferences,
          `flow.steps.${stepName}.on_result.call_spec.with`,
        );
      }
      for (const branch of step.on_success?.branches ?? []) {
        addSetKeys(knownVars, branch.set);
        addConsumerReferencesFromTemplate(
          consumerVars,
          branch.respond,
          consumerReferences,
          `flow.steps.${stepName}.on_success.branches.respond`,
        );
        addConsumerReferencesFromRecordExpressions(
          consumerVars,
          branch.set,
          consumerReferences,
          `flow.steps.${stepName}.on_success.branches.set`,
        );
        addKnownVar(knownVars, branch.call_spec?.as);
        addConsumerReferencesFromToolInvocation(
          consumerVars,
          branch.call_spec,
          consumerReferences,
          `flow.steps.${stepName}.on_success.branches.call_spec.with`,
        );
      }
      for (const branch of step.on_failure?.branches ?? []) {
        addSetKeys(knownVars, branch.set);
        addConsumerReferencesFromTemplate(
          consumerVars,
          branch.respond,
          consumerReferences,
          `flow.steps.${stepName}.on_failure.branches.respond`,
        );
        addConsumerReferencesFromRecordExpressions(
          consumerVars,
          branch.set,
          consumerReferences,
          `flow.steps.${stepName}.on_failure.branches.set`,
        );
        addKnownVar(knownVars, branch.call_spec?.as);
        addConsumerReferencesFromToolInvocation(
          consumerVars,
          branch.call_spec,
          consumerReferences,
          `flow.steps.${stepName}.on_failure.branches.call_spec.with`,
        );
      }
      addConsumerReferencesFromTemplate(
        consumerVars,
        step.on_success?.respond,
        consumerReferences,
        `flow.steps.${stepName}.on_success.respond`,
      );
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        step.on_success?.set,
        consumerReferences,
        `flow.steps.${stepName}.on_success.set`,
      );
      addConsumerReferencesFromTemplate(
        consumerVars,
        step.on_failure?.respond,
        consumerReferences,
        `flow.steps.${stepName}.on_failure.respond`,
      );
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        step.on_failure?.set,
        consumerReferences,
        `flow.steps.${stepName}.on_failure.set`,
      );
      for (let i = 0; i < (step.on_action?.length ?? 0); i++) {
        const handler = step.on_action![i];
        for (const action of getActionHandlerActions(handler)) {
          addSetKeys(knownVars, action.set);
          addKnownVar(knownVars, action.result_key);
          addKnownVar(knownVars, action.call_spec?.as);
          addConsumerReferencesFromTemplate(
            consumerVars,
            action.respond,
            consumerReferences,
            `flow.steps.${stepName}.on_action[${i}].respond`,
          );
          addConsumerReferencesFromRecordExpressions(
            consumerVars,
            action.set,
            consumerReferences,
            `flow.steps.${stepName}.on_action[${i}].set`,
          );
          addConsumerReferencesFromToolInvocation(
            consumerVars,
            action.call_spec,
            consumerReferences,
            `flow.steps.${stepName}.on_action[${i}].call_spec.with`,
          );
          for (const parentVar of Object.values(action.on_return?.map ?? {})) {
            addKnownVar(knownVars, parentVar);
            addConsumerReference(consumerVars, parentVar);
          }
        }
      }
      for (let i = 0; i < (step.digressions?.length ?? 0); i++) {
        const digression = step.digressions![i];
        addKnownVar(knownVars, digression.call_spec?.as);
        addConsumerReferencesFromTemplate(
          consumerVars,
          digression.respond,
          consumerReferences,
          `flow.steps.${stepName}.digressions[${i}].respond`,
        );
        addConsumerReferencesFromToolInvocation(
          consumerVars,
          digression.call_spec,
          consumerReferences,
          `flow.steps.${stepName}.digressions[${i}].call_spec.with`,
        );
        for (const action of getDigressionActions(digression)) {
          addSetKeys(knownVars, action.set);
          addKnownVar(knownVars, action.call_spec?.as);
          addConsumerReferencesFromTemplate(
            consumerVars,
            action.respond,
            consumerReferences,
            `flow.steps.${stepName}.digressions[${i}].do.respond`,
          );
          addConsumerReferencesFromRecordExpressions(
            consumerVars,
            action.set,
            consumerReferences,
            `flow.steps.${stepName}.digressions[${i}].do.set`,
          );
          addConsumerReferencesFromToolInvocation(
            consumerVars,
            action.call_spec,
            consumerReferences,
            `flow.steps.${stepName}.digressions[${i}].do.call_spec.with`,
          );
          for (const parentVar of Object.values(action.on_return?.map ?? {})) {
            addKnownVar(knownVars, parentVar);
            addConsumerReference(consumerVars, parentVar);
          }
        }
      }
      for (let i = 0; i < (step.sub_intents?.length ?? 0); i++) {
        const subIntent = step.sub_intents![i];
        addSetKeys(knownVars, subIntent.set);
        addKnownVar(knownVars, subIntent.call_spec?.as);
        addConsumerReferencesFromTemplate(
          consumerVars,
          subIntent.respond,
          consumerReferences,
          `flow.steps.${stepName}.sub_intents[${i}].respond`,
        );
        addConsumerReferencesFromRecordExpressions(
          consumerVars,
          subIntent.set,
          consumerReferences,
          `flow.steps.${stepName}.sub_intents[${i}].set`,
        );
        addConsumerReferencesFromToolInvocation(
          consumerVars,
          subIntent.call_spec,
          consumerReferences,
          `flow.steps.${stepName}.sub_intents[${i}].call_spec.with`,
        );
      }
    }
  }

  for (let i = 0; i < (agent.flow?.global_digressions?.length ?? 0); i++) {
    const digression = agent.flow!.global_digressions![i];
    addKnownVar(knownVars, digression.call_spec?.as);
    addConsumerReferencesFromTemplate(
      consumerVars,
      digression.respond,
      consumerReferences,
      `flow.global_digressions[${i}].respond`,
    );
    addConsumerReferencesFromToolInvocation(
      consumerVars,
      digression.call_spec,
      consumerReferences,
      `flow.global_digressions[${i}].call_spec.with`,
    );
    for (const action of getDigressionActions(digression)) {
      addSetKeys(knownVars, action.set);
      addKnownVar(knownVars, action.call_spec?.as);
      addConsumerReferencesFromTemplate(
        consumerVars,
        action.respond,
        consumerReferences,
        `flow.global_digressions[${i}].do.respond`,
      );
      addConsumerReferencesFromRecordExpressions(
        consumerVars,
        action.set,
        consumerReferences,
        `flow.global_digressions[${i}].do.set`,
      );
      addConsumerReferencesFromToolInvocation(
        consumerVars,
        action.call_spec,
        consumerReferences,
        `flow.global_digressions[${i}].do.call_spec.with`,
      );
      for (const parentVar of Object.values(action.on_return?.map ?? {})) {
        addKnownVar(knownVars, parentVar);
        addConsumerReference(consumerVars, parentVar);
      }
    }
  }

  // Collect all conditions to check
  const conditions: Array<{ condition: string; path: string }> = [];
  const pushCondition = (condition: string | undefined, path: string) => {
    if (condition) {
      conditions.push({ condition, path });
    }
  };

  // Constraint conditions
  if (agent.constraints?.constraints) {
    for (let i = 0; i < agent.constraints.constraints.length; i++) {
      const c = agent.constraints.constraints[i];
      pushCondition(c.condition, `constraints[${i}].condition`);
      pushCondition(c.applies_when, `constraints[${i}].applies_when`);
    }
  }

  for (let i = 0; i < (agent.routing?.rules?.length ?? 0); i++) {
    pushCondition(agent.routing!.rules[i].when, `routing.rules[${i}].when`);
  }

  for (let i = 0; i < (agent.coordination?.handoffs?.length ?? 0); i++) {
    pushCondition(agent.coordination!.handoffs[i].when, `coordination.handoffs[${i}].when`);
  }

  for (let i = 0; i < (agent.coordination?.delegates?.length ?? 0); i++) {
    pushCondition(agent.coordination!.delegates[i].when, `coordination.delegates[${i}].when`);
  }

  for (let i = 0; i < (agent.memory?.remember?.length ?? 0); i++) {
    pushCondition(agent.memory!.remember[i].when, `memory.remember[${i}].when`);
  }

  for (let i = 0; i < (agent.completion?.conditions?.length ?? 0); i++) {
    pushCondition(agent.completion!.conditions[i].when, `completion.conditions[${i}].when`);
    addConsumerReferencesFromTemplate(
      consumerVars,
      agent.completion!.conditions[i].respond,
      consumerReferences,
      `completion.conditions[${i}].respond`,
    );
  }

  for (let i = 0; i < (agent.coordination?.escalation?.triggers?.length ?? 0); i++) {
    pushCondition(
      agent.coordination!.escalation!.triggers[i].when,
      `coordination.escalation.triggers[${i}].when`,
    );
  }

  for (let i = 0; i < (agent.gather?.fields?.length ?? 0); i++) {
    const activation = agent.gather!.fields[i].activation;
    if (typeof activation === 'object') {
      pushCondition(activation.when, `gather.fields[${i}].activation.when`);
    }
  }

  for (let i = 0; i < (agent.action_handlers?.length ?? 0); i++) {
    const actionHandler = agent.action_handlers?.[i];
    if (actionHandler) {
      pushCondition(actionHandler.condition, `action_handlers[${i}].condition`);
    }
  }

  // Flow step conditions and checks
  if (agent.flow?.definitions) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      pushCondition(step.check, `flow.steps.${stepName}.check`);
      pushCondition(step.complete_when, `flow.steps.${stepName}.complete_when`);
      pushCondition(
        step.reasoning_zone?.exit_when,
        `flow.steps.${stepName}.reasoning_zone.exit_when`,
      );
      pushCondition(step.success_when, `flow.steps.${stepName}.success_when`);

      for (let i = 0; i < (step.gather?.fields?.length ?? 0); i++) {
        const activation = step.gather!.fields[i].activation;
        if (typeof activation === 'object') {
          pushCondition(
            activation.when,
            `flow.steps.${stepName}.gather.fields[${i}].activation.when`,
          );
        }
      }

      for (let i = 0; i < (step.on_input?.length ?? 0); i++) {
        pushCondition(
          step.on_input![i].condition,
          `flow.steps.${stepName}.on_input[${i}].condition`,
        );
      }

      for (let i = 0; i < (step.on_result?.length ?? 0); i++) {
        pushCondition(
          step.on_result![i].condition,
          `flow.steps.${stepName}.on_result[${i}].condition`,
        );
      }

      for (let i = 0; i < (step.on_success?.branches?.length ?? 0); i++) {
        pushCondition(
          step.on_success!.branches![i].condition,
          `flow.steps.${stepName}.on_success.branches[${i}].condition`,
        );
      }

      for (let i = 0; i < (step.on_failure?.branches?.length ?? 0); i++) {
        pushCondition(
          step.on_failure!.branches![i].condition,
          `flow.steps.${stepName}.on_failure.branches[${i}].condition`,
        );
      }

      for (let i = 0; i < (step.on_action?.length ?? 0); i++) {
        pushCondition(
          step.on_action![i].condition,
          `flow.steps.${stepName}.on_action[${i}].condition`,
        );
      }

      for (let i = 0; i < (step.digressions?.length ?? 0); i++) {
        pushCondition(
          step.digressions![i].condition,
          `flow.steps.${stepName}.digressions[${i}].condition`,
        );
      }
    }
  }

  for (let i = 0; i < (agent.flow?.global_digressions?.length ?? 0); i++) {
    pushCondition(
      agent.flow!.global_digressions![i].condition,
      `flow.global_digressions[${i}].condition`,
    );
  }

  // Check each condition
  for (const { condition, path } of conditions) {
    const vars = extractVariableReferences(condition);
    for (const v of vars) {
      addConsumerReference(consumerVars, v);
    }
    if (
      isRoutingDecisionPath(path) &&
      vars.includes(ROUTING_INTENT_VAR) &&
      vars.includes(INTENT_CATEGORY_PATH)
    ) {
      diagnostics.push({
        agent: agentName,
        message:
          `Condition mixes "${ROUTING_INTENT_VAR}" and "${INTENT_CATEGORY_PATH}". ` +
          'Use one routing state vocabulary, or explicitly map classifier output before evaluating handoff/routing rules.',
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.MIXED_ROUTING_CONDITION_STATE,
        path,
      });
    }
    for (const v of vars) {
      if (!isKnownVariableReference(knownVars, v)) {
        diagnostics.push({
          agent: agentName,
          message: `Variable "${v}" in condition is not found in gather fields, session variables, or built-ins. It may resolve at runtime from tool results or context.`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.UNDEFINED_CONDITION_VAR,
          path,
        });
      }
    }
  }

  const reportedMissingProducers = new Set<string>();
  for (const reference of consumerReferences) {
    if (isKnownVariableReference(knownVars, reference.variable)) {
      continue;
    }

    const diagnosticKey = `${reference.path}:${reference.variable}`;
    if (reportedMissingProducers.has(diagnosticKey)) {
      continue;
    }
    reportedMissingProducers.add(diagnosticKey);

    diagnostics.push({
      agent: agentName,
      message:
        `Variable "${reference.variable}" is consumed by "${reference.path}" but is not produced by ` +
        'GATHER, MEMORY, SET, tool results, return mappings, or built-in runtime context. It may resolve dynamically at runtime.',
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.MISSING_VARIABLE_PRODUCER_WARNING,
      path: reference.path,
    });
  }

  // Validate depends_on references in gather fields
  diagnostics.push(...validateDependsOnRefs(agent));

  for (const field of requiredGatherFields) {
    const isConsumed = [...consumerVars].some((reference) =>
      doesReferenceGatherField(reference, field.name),
    );
    if (!isConsumed) {
      diagnostics.push({
        agent: agentName,
        message: `Required GATHER field "${field.name}" is not referenced by COMPLETE, MEMORY, FLOW, handoff/delegate inputs, tool inputs, or other known consumers. It may be an unnecessary customer-facing slot.`,
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.UNUSED_REQUIRED_GATHER_FIELD,
        path: field.path,
      });
    }
  }

  return diagnostics;
}

// =============================================================================
// DEPENDS_ON REFERENCE VALIDATOR
// =============================================================================

/**
 * Validate depends_on references in gather fields:
 * 1. Each depends_on entry must reference an existing field name in the same gather
 * 2. No circular dependency chains (A→B→A or A→B→C→A)
 */
export function validateDependsOnRefs(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  // Collect all gather field groups to validate
  const gatherGroups: Array<{
    fields: Array<{ name: string; depends_on?: string[] }>;
    pathPrefix: string;
  }> = [];

  // Top-level gather
  if (agent.gather?.fields) {
    gatherGroups.push({
      fields: agent.gather.fields,
      pathPrefix: 'gather',
    });
  }

  // Per-step gather fields
  if (agent.flow?.definitions) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      if (step.gather?.fields) {
        gatherGroups.push({
          fields: step.gather.fields,
          pathPrefix: `flow.steps.${stepName}.gather`,
        });
      }
    }
  }

  for (const group of gatherGroups) {
    const fieldNames = new Set(group.fields.map((f) => f.name));
    // Build adjacency map for cycle detection
    const depGraph = new Map<string, string[]>();

    for (const field of group.fields) {
      if (!field.depends_on || field.depends_on.length === 0) continue;

      depGraph.set(field.name, field.depends_on);

      // Check each depends_on reference exists
      for (const dep of field.depends_on) {
        if (!fieldNames.has(dep)) {
          diagnostics.push({
            agent: agentName,
            message: `Field "${field.name}" has depends_on reference to nonexistent field "${dep}". Available fields: ${[...fieldNames].join(', ')}`,
            type: 'validation',
            severity: 'error',
            code: VALIDATION_CODES.INVALID_DEPENDS_ON_REF,
            path: `${group.pathPrefix}.fields.${field.name}.depends_on`,
          });
        }
      }
    }

    // Detect circular dependencies using DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const detectCycle = (node: string, path: string[]): boolean => {
      if (inStack.has(node)) {
        // Found a cycle — report it
        const cycleStart = path.indexOf(node);
        const cyclePath = path.slice(cycleStart).concat(node);
        diagnostics.push({
          agent: agentName,
          message: `Circular depends_on cycle detected: ${cyclePath.join(' → ')}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.CIRCULAR_DEPENDS_ON,
          path: `${group.pathPrefix}.fields.${node}.depends_on`,
        });
        return true;
      }
      if (visited.has(node)) return false;

      visited.add(node);
      inStack.add(node);

      const deps = depGraph.get(node) ?? [];
      for (const dep of deps) {
        // Only follow edges to fields that also have depends_on (are in the graph)
        // or exist in the field set
        if (depGraph.has(dep)) {
          detectCycle(dep, [...path, node]);
        }
      }

      inStack.delete(node);
      return false;
    };

    for (const node of depGraph.keys()) {
      if (!visited.has(node)) {
        detectCycle(node, []);
      }
    }
  }

  return diagnostics;
}
