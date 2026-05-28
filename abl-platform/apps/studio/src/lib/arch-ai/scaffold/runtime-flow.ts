import type { AblSkeleton } from './types';
import {
  inferInputFieldNamesFromSignature,
  inferOutputFieldNamesFromSignature,
} from './tool-signature';

const FINAL_FLOW_STEP = 'finalize';
const REASON_WITH_TOOLS_STEP = 'reason_with_tools';

export interface ScaffoldRuntimeToolCall {
  step: string;
  tool: string;
  with: Record<string, string>;
  as: string;
  resultFieldsUsed: string[];
  onSuccess: {
    set: Record<string, string>;
    then: string;
  };
  onFailure: {
    respond?: string;
    then: string;
  };
}

export interface ScaffoldRuntimeFlowStep {
  name: string;
  reasoning: boolean;
  respond?: string;
  call?: string;
  set?: Record<string, string>;
  then?: string;
  complete?: boolean;
}

export interface ScaffoldRuntimeStateAssignment {
  name: string;
  value: string;
  source: 'tool_result';
}

export interface ScaffoldRuntimePlan {
  toolCalls: ScaffoldRuntimeToolCall[];
  toolResultState: ScaffoldRuntimeStateAssignment[];
  flow: ScaffoldRuntimeFlowStep[];
}

export function deriveScaffoldRuntimePlan(skeleton: AblSkeleton): ScaffoldRuntimePlan {
  if (skeleton.keyword === 'SUPERVISOR') {
    return {
      toolCalls: [],
      toolResultState: [],
      flow: [],
    };
  }

  const gatherNames = skeleton.gatherFields.map((field) => field.name);
  const toolCalls = skeleton.tools.map((tool, index) => {
    const alias = `${toCamelIdentifier(tool.name)}Result`;
    const nextStep = skeleton.tools[index + 1]
      ? `call_${toSnakeIdentifier(skeleton.tools[index + 1].name)}`
      : FINAL_FLOW_STEP;
    const outputFields = inferOutputFieldsFromSignature(tool.signatureLiteral);
    const resultFieldsUsed = (outputFields.length > 0 ? outputFields : ['result'])
      .slice(0, 3)
      .map((field) => `${alias}.${field}`);
    const inputFields = inferInputFieldsFromSignature(tool.signatureLiteral);
    const withArgs = Object.fromEntries(
      (inputFields.length > 0 ? inputFields : ['input']).map((fieldName, fieldIndex) => [
        fieldName,
        mapInputFieldToAvailableValue(fieldName, fieldIndex, gatherNames),
      ]),
    );

    return {
      step: `call_${toSnakeIdentifier(tool.name)}`,
      tool: tool.name,
      with: withArgs,
      as: alias,
      resultFieldsUsed,
      onSuccess: {
        set: Object.fromEntries(
          resultFieldsUsed.map((field) => [stateNameFromResultField(field), field]),
        ),
        then: nextStep,
      },
      onFailure: {
        then: FINAL_FLOW_STEP,
      },
    };
  });

  const flow =
    toolCalls.length > 0 ? deriveToolBackedFlow(skeleton, toolCalls) : deriveRoutingFlow(skeleton);
  const branchTarget = usesReasoningDispatchFlow(flow) ? 'COMPLETE' : null;
  const normalizedToolCalls = branchTarget
    ? toolCalls.map((call) => ({
        ...call,
        onSuccess: { ...call.onSuccess, then: branchTarget },
        onFailure: { ...call.onFailure, then: branchTarget },
      }))
    : toolCalls;

  const toolResultState = normalizedToolCalls.flatMap((call) =>
    call.resultFieldsUsed.map((resultField) => ({
      name: stateNameFromResultField(resultField),
      value: resultField,
      source: 'tool_result' as const,
    })),
  );

  return {
    toolCalls: normalizedToolCalls,
    toolResultState,
    flow,
  };
}

export function stateNameFromResultField(resultField: string): string {
  const [alias, ...fieldParts] = resultField.split('.');
  return toSnakeIdentifier(`${alias}_${fieldParts.join('_') || 'result'}`);
}

function deriveToolBackedFlow(
  skeleton: AblSkeleton,
  toolCalls: ReadonlyArray<ScaffoldRuntimeToolCall>,
): ScaffoldRuntimeFlowStep[] {
  if (toolCalls.length === 0) {
    return [];
  }

  if (
    requiresReasoningDispatch(skeleton) ||
    hasUnboundToolInputs(toolCalls) ||
    hasAmbiguousToolInputBindings(toolCalls)
  ) {
    return [
      {
        name: REASON_WITH_TOOLS_STEP,
        reasoning: true,
        complete: true,
      },
    ];
  }

  const callReasoning = skeleton.runtimePattern === 'reasoning';
  return [
    ...toolCalls.map((call, index) => ({
      name: call.step,
      reasoning: callReasoning,
      call: call.tool,
      set: call.onSuccess.set,
      then: toolCalls[index + 1]?.step ?? FINAL_FLOW_STEP,
    })),
    {
      name: FINAL_FLOW_STEP,
      reasoning: false,
      complete: true,
    },
  ];
}

function usesReasoningDispatchFlow(flow: ReadonlyArray<ScaffoldRuntimeFlowStep>): boolean {
  return flow.length === 1 && flow[0]?.name === REASON_WITH_TOOLS_STEP;
}

function requiresReasoningDispatch(skeleton: AblSkeleton): boolean {
  const sideEffectingTools = skeleton.tools.filter((tool) => tool.sideEffects);
  return sideEffectingTools.length > 1;
}

function hasUnboundToolInputs(toolCalls: ReadonlyArray<ScaffoldRuntimeToolCall>): boolean {
  return toolCalls.some((call) => Object.values(call.with).includes('input'));
}

function hasAmbiguousToolInputBindings(toolCalls: ReadonlyArray<ScaffoldRuntimeToolCall>): boolean {
  return toolCalls.some((call) => {
    const bindings = Object.values(call.with);
    return new Set(bindings).size !== bindings.length;
  });
}

function deriveRoutingFlow(skeleton: AblSkeleton): ScaffoldRuntimeFlowStep[] {
  if (skeleton.keyword !== 'SUPERVISOR' || skeleton.handoffs.length === 0) {
    return [];
  }

  return [
    {
      name: 'route_request',
      reasoning: true,
    },
  ];
}

function mapInputFieldToAvailableValue(
  fieldName: string,
  fieldIndex: number,
  gatherNames: ReadonlyArray<string>,
): string {
  if (gatherNames.includes(fieldName)) {
    return fieldName;
  }
  return gatherNames[fieldIndex] ?? gatherNames[0] ?? 'input';
}

function inferOutputFieldsFromSignature(signature: string): string[] {
  return inferOutputFieldNamesFromSignature(signature);
}

function inferInputFieldsFromSignature(signature: string): string[] {
  return inferInputFieldNamesFromSignature(signature);
}

function toCamelIdentifier(value: string): string {
  const snake = toSnakeIdentifier(value);
  return snake.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toSnakeIdentifier(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
  if (!normalized) {
    return 'result';
  }
  return /^[a-z_]/.test(normalized) ? normalized : `field_${normalized}`;
}
