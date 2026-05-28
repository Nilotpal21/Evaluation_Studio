import {
  AppError,
  ErrorCodes,
  ToolExecutionError,
  type ToolErrorCode,
} from '@agent-platform/shared-kernel';
import { getLlmOperatorDiagnostic, type LlmOperatorDiagnostic } from '../llm/classify-llm-error.js';
import {
  classifyExecutionConfigurationDiagnostic,
  type ExecutionConfigurationDiagnostic,
} from './configuration-diagnostics.js';

export interface RuntimeErrorEnvelope {
  code: string;
  customer_message: string;
  operator_hint: string;
  trace_id?: string;
  category?: 'llm' | 'tool' | 'runtime';
  severity?: 'info' | 'warning' | 'error';
  agent_name?: string;
  tool_name?: string;
  recommended_action?: string;
}

export interface RuntimeErrorEnvelopeContext {
  traceId?: string;
  agentName?: string;
  toolName?: string;
}

const GENERIC_LLM_CUSTOMER_MESSAGE =
  "I'm having trouble completing that request. Please try again.";
const GENERIC_TOOL_CUSTOMER_MESSAGE =
  "I'm having trouble completing that request. Please try again.";

export function buildRuntimeErrorEnvelope(
  error: unknown,
  context: RuntimeErrorEnvelopeContext = {},
): RuntimeErrorEnvelope | undefined {
  const llmDiagnostic = getLlmOperatorDiagnostic(error);
  if (llmDiagnostic) {
    return fromLlmDiagnostic(llmDiagnostic, context);
  }

  const configurationDiagnostic = classifyExecutionConfigurationDiagnostic(error);
  if (configurationDiagnostic) {
    return fromConfigurationDiagnostic(configurationDiagnostic, context);
  }

  if (error instanceof ToolExecutionError) {
    return fromToolExecutionError(error, context);
  }

  if (error instanceof AppError && isModelAppErrorCode(error.code)) {
    return withContext(
      {
        code: error.code,
        category: 'llm',
        severity: 'error',
        customer_message: GENERIC_LLM_CUSTOMER_MESSAGE,
        operator_hint:
          'The model request failed after classification. Check the trace events around this turn and verify model configuration, credentials, and provider availability.',
      },
      context,
    );
  }

  return undefined;
}

export function getRuntimeErrorCustomerMessage(error: unknown): string | undefined {
  return buildRuntimeErrorEnvelope(error)?.customer_message;
}

function fromLlmDiagnostic(
  diagnostic: LlmOperatorDiagnostic,
  context: RuntimeErrorEnvelopeContext,
): RuntimeErrorEnvelope {
  return withContext(
    {
      code: diagnostic.code,
      category: 'llm',
      severity: diagnostic.severity,
      customer_message: customerMessageForLlmDiagnostic(diagnostic.code),
      operator_hint: diagnostic.operatorHint,
      recommended_action: diagnostic.recommendedAction,
    },
    context,
  );
}

function fromConfigurationDiagnostic(
  diagnostic: ExecutionConfigurationDiagnostic,
  context: RuntimeErrorEnvelopeContext,
): RuntimeErrorEnvelope {
  return withContext(
    {
      code: diagnostic.code,
      category: diagnostic.category,
      severity: diagnostic.severity,
      customer_message: customerMessageForConfigurationDiagnostic(diagnostic.code),
      operator_hint: operatorHintForConfigurationDiagnostic(diagnostic.code),
    },
    context,
  );
}

function customerMessageForLlmDiagnostic(_code: LlmOperatorDiagnostic['code']): string {
  return GENERIC_LLM_CUSTOMER_MESSAGE;
}

function fromToolExecutionError(
  error: ToolExecutionError,
  context: RuntimeErrorEnvelopeContext,
): RuntimeErrorEnvelope {
  return withContext(
    {
      code: runtimeToolCode(error.code),
      category: 'tool',
      severity: 'error',
      customer_message: customerMessageForToolError(error.code),
      operator_hint: operatorHintForToolError(error.code),
    },
    { ...context, toolName: context.toolName ?? error.toolName },
  );
}

function customerMessageForConfigurationDiagnostic(code: ExecutionConfigurationDiagnostic['code']) {
  switch (code) {
    case 'LLM_CREDENTIAL_MISSING':
      return 'This workspace is not fully configured for that request. Please contact support.';
    case 'LLM_MODEL_NOT_CONFIGURED':
      return 'This workspace is not fully configured for that request. Please contact support.';
    case 'LLM_PROVIDER_CONFIGURATION_INVALID':
      return 'This workspace is not fully configured for that request. Please contact support.';
    case 'LLM_WIRING_FAILED':
      return "I'm having trouble completing that request right now. Please try again later.";
    case 'TOOL_CODE_EXECUTION_DISABLED':
      return 'That action is not available in the current workspace configuration.';
    default:
      return "I'm unable to complete that request with the current workspace configuration.";
  }
}

function operatorHintForConfigurationDiagnostic(code: ExecutionConfigurationDiagnostic['code']) {
  switch (code) {
    case 'LLM_CREDENTIAL_MISSING':
      return 'Model credential lookup failed or credentials are invalid. Check workspace model credentials and project model configuration.';
    case 'LLM_MODEL_NOT_CONFIGURED':
      return 'No usable model configuration was resolved for this session. Check the project, agent, and workspace model defaults.';
    case 'LLM_PROVIDER_CONFIGURATION_INVALID':
      return 'The resolved model provider configuration is invalid. Check model provider routing and configured deployment metadata.';
    case 'LLM_WIRING_FAILED':
      return 'The session reached execution without an LLM client. Check session boot, model resolution, and executor wiring.';
    case 'TOOL_CODE_EXECUTION_DISABLED':
      return 'Code tool execution is disabled by workspace configuration. Enable code tools or remove the sandbox tool from the flow.';
    default:
      return 'Runtime configuration blocked execution. Check the surrounding trace events for the affected component.';
  }
}

function runtimeToolCode(code: ToolErrorCode): string {
  switch (code) {
    case 'TOOL_TIMEOUT':
      return 'TOOL_TIMEOUT';
    case 'TOOL_INVALID_RESPONSE':
    case 'TOOL_RESPONSE_PARSE_FAILED':
      return 'TOOL_SCHEMA_MISMATCH';
    case 'TOOL_SSRF_BLOCKED':
      return 'TOOL_POLICY_BLOCKED';
    default:
      return code;
  }
}

function customerMessageForToolError(code: ToolErrorCode): string {
  switch (code) {
    case 'TOOL_TIMEOUT':
      return "I'm still waiting on a required service. Please try again.";
    case 'TOOL_AUTH_FAILED':
      return "I don't have the access needed to complete that request. Please contact support.";
    case 'TOOL_INVALID_RESPONSE':
    case 'TOOL_RESPONSE_PARSE_FAILED':
      return 'I got an unexpected response while completing that request. Please try again.';
    case 'TOOL_SSRF_BLOCKED':
      return "I can't complete that request from here.";
    default:
      return GENERIC_TOOL_CUSTOMER_MESSAGE;
  }
}

function operatorHintForToolError(code: ToolErrorCode): string {
  switch (code) {
    case 'TOOL_TIMEOUT':
      return 'Tool execution timed out. Check tool latency, timeout settings, and downstream availability.';
    case 'TOOL_AUTH_FAILED':
      return 'Tool authorization failed. Check the tool auth profile, scoped credentials, and project permissions.';
    case 'TOOL_INVALID_RESPONSE':
    case 'TOOL_RESPONSE_PARSE_FAILED':
      return 'Tool output could not be parsed against the expected contract. Check the tool response schema and adapter mapping.';
    case 'TOOL_SSRF_BLOCKED':
      return 'The outbound tool request was blocked by platform network policy. Check the tool endpoint allowlist and SSRF guardrails.';
    default:
      return 'Tool execution failed. Check the tool trace span, configuration, and downstream service health.';
  }
}

function isModelAppErrorCode(code: string): boolean {
  const modelErrorCodes: readonly string[] = [
    ErrorCodes.MODEL_RATE_LIMITED.code,
    ErrorCodes.MODEL_API_ERROR.code,
    ErrorCodes.MODEL_TIMEOUT.code,
    ErrorCodes.MODEL_CONTENT_FILTERED.code,
    ErrorCodes.MODEL_CONTEXT_EXCEEDED.code,
    ErrorCodes.CREDENTIAL_NOT_FOUND.code,
    ErrorCodes.CREDENTIAL_DECRYPTION.code,
    ErrorCodes.MODEL_NOT_CONFIGURED.code,
  ];
  return modelErrorCodes.includes(code);
}

function withContext(
  envelope: RuntimeErrorEnvelope,
  context: RuntimeErrorEnvelopeContext,
): RuntimeErrorEnvelope {
  return {
    ...envelope,
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    ...(context.agentName ? { agent_name: context.agentName } : {}),
    ...(context.toolName ? { tool_name: context.toolName } : {}),
  };
}
