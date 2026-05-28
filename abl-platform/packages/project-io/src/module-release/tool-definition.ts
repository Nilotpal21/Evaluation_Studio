import type { ProjectToolType } from '@agent-platform/database/models';
import {
  buildHttpBindingFromProps,
  buildMcpBindingFromProps,
  buildSandboxBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  convertStandaloneToolDSL,
  parseDslParamMetadata,
  parseDslProperties,
  parseOptionalRuntimeNumber,
  parseReturnTypeString,
  parseSignatureLine,
  type ToolDefinitionLocal,
  type ToolParameterLocal,
} from '@agent-platform/shared/tools';

export interface ModuleReleaseToolDefinition extends ToolDefinitionLocal, Record<string, unknown> {
  auth_profile_ref?: string;
  jit_auth?: boolean;
  connection_mode?: 'per_user' | 'shared';
  consent_mode?: 'preflight' | 'inline';
}

function normalizeToolDsl(dslContent: string): string {
  const firstNonEmptyLine = dslContent
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (firstNonEmptyLine?.startsWith('TOOL:')) {
    return convertStandaloneToolDSL(dslContent);
  }

  return dslContent;
}

export function materializeModuleToolDefinition(
  dslContent: string,
  toolType: ProjectToolType,
): ModuleReleaseToolDefinition {
  const normalizedDsl = normalizeToolDsl(dslContent);
  const props = parseDslProperties(normalizedDsl);
  const sig = parseSignatureLine(normalizedDsl);
  const paramMeta = parseDslParamMetadata(normalizedDsl);
  const timeout = parseOptionalRuntimeNumber(props.timeout, 'Tool hint timeout');

  const parameters: ToolParameterLocal[] = sig.parameters.map((param) => {
    const meta = paramMeta.get(param.name);
    const definition: ToolParameterLocal = {
      name: param.name,
      type: param.type,
      required: param.required,
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.enum ? { enum: meta.enum } : {}),
      ...(meta?.default !== undefined ? { default: meta.default } : {}),
    };

    if (meta?.schema) {
      try {
        const parsed = JSON.parse(meta.schema) as Record<string, unknown>;
        if (param.type === 'array') {
          definition.items = parsed as { type: string; enum?: unknown[] };
        } else if (param.type === 'object' && typeof parsed === 'object') {
          definition.properties = Object.entries(parsed).map(([name, rawProp]) => {
            const property = rawProp as Record<string, unknown>;
            return {
              name,
              type: (property.type as string) || 'string',
              required: false,
              ...(property.description ? { description: property.description as string } : {}),
            };
          });
        }
      } catch {
        // Preserve lenient publish behavior for malformed optional param metadata.
      }
    }

    return definition;
  });

  const definition: ModuleReleaseToolDefinition = {
    name: normalizedDsl.split('(')[0]?.trim() ?? '',
    description: props.description || '',
    parameters,
    returns: parseReturnTypeString(sig.returnType),
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: (props.method || 'GET') !== 'GET',
      requires_auth:
        props.auth !== undefined && props.auth !== 'none'
          ? true
          : Boolean(props.auth_profile || props.auth_profile_ref),
      ...(timeout !== undefined ? { timeout } : {}),
    },
    tool_type: toolType,
    ...(props.auth_profile || props.auth_profile_ref
      ? {
          auth_profile_ref: props.auth_profile || props.auth_profile_ref,
        }
      : {}),
    ...(props.auth_jit === 'true' ? { jit_auth: true } : {}),
    ...(props.connection ? { connection_mode: props.connection as 'per_user' | 'shared' } : {}),
    ...(props.consent ? { consent_mode: props.consent as 'preflight' | 'inline' } : {}),
  };

  switch (toolType) {
    case 'http':
      definition.http_binding = buildHttpBindingFromProps(props, normalizedDsl);
      break;
    case 'sandbox':
      definition.sandbox_binding = buildSandboxBindingFromProps(props, normalizedDsl);
      break;
    case 'mcp':
      definition.mcp_binding = buildMcpBindingFromProps(props, definition.name, {
        dslContent: normalizedDsl,
      });
      break;
    case 'searchai':
      definition.searchai_binding = buildSearchAIBindingFromProps(props);
      break;
    case 'workflow':
      definition.workflow_binding = buildWorkflowBindingFromProps(props);
      break;
  }

  return definition;
}
