import type { ConfigField, NodeCategory, NodeTypeDefinition } from './types.js';
import { ACTIVITY_TYPES } from './activity-metadata.js';
import type { NodeRegistry } from './node-registry.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('register-nodes');

// ── Explicit overrides for eval-pipeline activity types ──
// These types don't follow prefix conventions, so we map them explicitly.
const EXPLICIT_CATEGORY_OVERRIDES: Record<string, NodeCategory> = {
  'simulate-persona': 'compute',
  'execute-agent-turn': 'compute',
  'run-eval-conversation': 'compute',
  'judge-conversation': 'compute',
  'aggregate-eval-run': 'compute',
  'http-request': 'integration',
};

/**
 * Infer a NodeCategory from an activity-type key.
 *
 * Rules (evaluated in order):
 * 1. Explicit override table (eval pipeline types)
 * 2. `compute-*`, `evaluate-*`, `call-*` -> 'compute'
 * 3. `store-*`, `send-*` -> 'action'
 * 4. `read-*`, `transform` -> 'data'
 * 5. `run-*` -> 'action'
 * 6. fallback -> 'compute'
 */
export function inferCategory(type: string): NodeCategory {
  if (EXPLICIT_CATEGORY_OVERRIDES[type] !== undefined) {
    return EXPLICIT_CATEGORY_OVERRIDES[type];
  }

  if (type.startsWith('compute-') || type.startsWith('evaluate-') || type.startsWith('call-')) {
    return 'compute';
  }

  if (type.startsWith('store-') || type.startsWith('send-')) {
    return 'action';
  }

  if (type.startsWith('read-') || type === 'transform') {
    return 'data';
  }

  if (type.startsWith('run-')) {
    return 'action';
  }

  return 'compute';
}

/**
 * Map an activity configSchema property type string to a ConfigField type.
 * Activity metadata uses JSON-schema-like types (e.g. 'string', 'number',
 * 'boolean', 'array', 'object'). We map them to the ConfigField type union.
 */
function mapPropertyType(
  propType: string,
): 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' {
  switch (propType) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

/**
 * Convert all entries in ACTIVITY_TYPES into NodeTypeDefinition objects
 * and register them in the given NodeRegistry.
 */
export function registerAnalyticsNodes(registry: NodeRegistry): void {
  for (const [type, meta] of Object.entries(ACTIVITY_TYPES)) {
    const fields: ConfigField[] = Object.entries(meta.configSchema.properties).map(
      ([name, prop]) => {
        const extra = prop as Record<string, unknown>;
        const field: ConfigField = {
          name,
          type: mapPropertyType(prop.type),
          required: meta.configSchema.required.includes(name),
          description: prop.description,
        };
        if (extra.label) field.label = extra.label as string;
        if (extra.placeholder) field.placeholder = extra.placeholder as string;
        if (extra.multiline) field.multiline = extra.multiline as boolean;
        if (extra.group) field.group = extra.group as string;
        if (extra.default !== undefined) field.default = extra.default;
        if (extra.values) field.values = extra.values as string[];
        if (extra.validation) field.validation = extra.validation as ConfigField['validation'];
        return field;
      },
    );

    const definition: NodeTypeDefinition = {
      type,
      category: inferCategory(type),
      label: meta.name,
      description: meta.description,
      configSchema: { fields },
      executionModel: 'async',
      defaultTimeout: meta.defaultTimeout,
      defaultRetries: meta.defaultRetries,
    };

    // Preserve outputSchema if the activity has output properties
    if (meta.outputSchema && Object.keys(meta.outputSchema.properties).length > 0) {
      definition.outputSchema = meta.outputSchema;
    }

    registry.register(definition);
  }
}

/**
 * Register generic builtin node types that are not derived from
 * existing activity types. These cover control-flow, data manipulation,
 * and external integrations.
 */
export function registerBuiltinNodes(registry: NodeRegistry): void {
  // Helper: skip types already registered (e.g., by registerAnalyticsNodes via ACTIVITY_TYPES).
  // Uses try-catch because NodeRegistry.register() throws on duplicates.
  const tryRegister = (def: NodeTypeDefinition) => {
    try {
      registry.register(def);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already registered')) {
        log.warn('Unexpected error registering node type', { type: def.type, error: msg });
      }
    }
  };

  // ── Logic nodes ──

  tryRegister({
    type: 'node-group',
    category: 'logic',
    label: 'Parallel Group',
    description: 'Execute child nodes in parallel and wait for all to complete',
    configSchema: { fields: [] },
    executionModel: 'control-flow',
  });

  tryRegister({
    type: 'wait-for-event',
    category: 'logic',
    label: 'Wait for Event',
    description: 'Pause execution until a named event is received or timeout expires',
    configSchema: {
      fields: [
        {
          name: 'eventName',
          type: 'string',
          required: true,
          description: 'Name of the event to wait for',
        },
        {
          name: 'timeoutMs',
          type: 'number',
          required: false,
          default: 86400000,
          description: 'Maximum wait time in milliseconds',
          validation: { min: 1000, max: 604800000 },
        },
        {
          name: 'timeoutAction',
          type: 'enum',
          required: false,
          default: 'fail',
          description: 'Action to take when timeout expires',
          values: ['fail', 'skip', 'default-value'],
        },
        {
          name: 'defaultValue',
          type: 'object',
          required: false,
          description: 'Default value to use when timeoutAction is default-value',
        },
      ],
    },
    executionModel: 'control-flow',
  });

  tryRegister({
    type: 'delay',
    category: 'logic',
    label: 'Delay',
    description: 'Pause execution for a fixed duration',
    configSchema: {
      fields: [
        {
          name: 'durationMs',
          type: 'number',
          required: true,
          description: 'Delay duration in milliseconds',
          validation: { min: 1000, max: 86400000 },
        },
      ],
    },
    executionModel: 'control-flow',
  });

  tryRegister({
    type: 'sub-pipeline',
    category: 'logic',
    label: 'Sub-Pipeline',
    description: 'Execute another pipeline as a nested step',
    configSchema: {
      fields: [
        {
          name: 'pipelineId',
          type: 'string',
          required: true,
          description: 'ID of the pipeline to execute',
        },
        {
          name: 'inputMapping',
          type: 'object',
          required: false,
          description: 'Map parent context fields to sub-pipeline input',
        },
      ],
    },
    executionModel: 'control-flow',
  });

  // ── Data nodes ──

  tryRegister({
    type: 'db-query',
    category: 'data',
    label: 'Database Query',
    description: 'Execute a query against ClickHouse or MongoDB',
    configSchema: {
      fields: [
        {
          name: 'database',
          type: 'enum',
          required: true,
          description: 'Target database engine',
          values: ['clickhouse', 'mongodb'],
        },
        {
          name: 'query',
          type: 'string',
          required: true,
          description: 'Query string to execute',
        },
        {
          name: 'collection',
          type: 'string',
          required: false,
          description: 'MongoDB collection name',
        },
        {
          name: 'limit',
          type: 'number',
          required: false,
          default: 1000,
          description: 'Maximum number of rows to return',
          validation: { min: 1, max: 10000 },
        },
      ],
    },
    executionModel: 'sync',
    requiredCapabilities: ['database-access'],
  });

  tryRegister({
    type: 'filter',
    category: 'data',
    label: 'Filter',
    description: 'Filter data from a source using an expression',
    configSchema: {
      fields: [
        {
          name: 'source',
          type: 'string',
          required: true,
          description: 'Data source to filter',
        },
        {
          name: 'expression',
          type: 'string',
          required: true,
          description: 'Filter expression to evaluate',
        },
      ],
    },
    executionModel: 'sync',
  });

  tryRegister({
    type: 'aggregate',
    category: 'data',
    label: 'Aggregate',
    description: 'Aggregate data from a source using specified operations',
    configSchema: {
      fields: [
        {
          name: 'source',
          type: 'string',
          required: true,
          description: 'Data source to aggregate',
        },
        {
          name: 'operations',
          type: 'array',
          required: true,
          description: 'Aggregation operations to perform',
        },
      ],
    },
    executionModel: 'sync',
  });

  // ── Integration nodes ──
  // Note: 'http-request' is now in ACTIVITY_TYPES and auto-registered by registerAnalyticsNodes.

  tryRegister({
    type: 'send-email',
    category: 'integration',
    label: 'Send Email',
    description: 'Send an email message',
    configSchema: {
      fields: [
        {
          name: 'to',
          type: 'string',
          required: true,
          description: 'Email recipient address',
        },
        {
          name: 'subject',
          type: 'string',
          required: true,
          description: 'Email subject line',
        },
        {
          name: 'body',
          type: 'string',
          required: true,
          description: 'Email body content',
        },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultRetries: 2,
    requiredCapabilities: ['email-send'],
  });

  tryRegister({
    type: 'send-slack',
    category: 'integration',
    label: 'Send Slack Message',
    description: 'Send a message to a Slack channel',
    configSchema: {
      fields: [
        {
          name: 'channel',
          type: 'string',
          required: true,
          description: 'Slack channel name or ID',
        },
        {
          name: 'message',
          type: 'string',
          required: true,
          description: 'Message text to send',
        },
        {
          name: 'webhookUrl',
          type: 'string',
          required: false,
          description: 'Slack webhook URL override',
        },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultRetries: 2,
    requiredCapabilities: ['slack-integration'],
  });

  tryRegister({
    type: 'publish-kafka',
    category: 'integration',
    label: 'Publish to Kafka',
    description: 'Publish a message to a Kafka topic',
    configSchema: {
      fields: [
        {
          name: 'topic',
          type: 'string',
          required: true,
          description: 'Kafka topic to publish to',
        },
        {
          name: 'key',
          type: 'string',
          required: false,
          description: 'Message key for partitioning',
        },
        {
          name: 'payload',
          type: 'object',
          required: true,
          description: 'Message payload to publish',
        },
      ],
    },
    executionModel: 'async',
    retryable: true,
    defaultRetries: 3,
  });
}
