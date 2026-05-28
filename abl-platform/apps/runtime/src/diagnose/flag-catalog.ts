/**
 * Canonical list of feature flags read by the runtime. Used by the
 * `/diagnose` handler to surface configuration to operators. Adding a new
 * flag? Add it here too — otherwise the diagnose response goes stale.
 */

export interface FlagDescriptor {
  name: string;
  description: string;
  defaultValue: string;
}

export const RUNTIME_FLAGS: ReadonlyArray<FlagDescriptor> = [
  // ─── Runtime feature flags (existing) ──────────────────────────────────
  {
    name: 'FEATURE_VOICE_ENABLED',
    description: 'Voice channel routes + LiveKit/Twilio handlers.',
    defaultValue: 'false',
  },
  {
    name: 'FEATURE_LIVEKIT_ENABLED',
    description: 'LiveKit agent worker for WebRTC voice.',
    defaultValue: 'false',
  },
  {
    name: 'FEATURE_STREAMING_ENABLED',
    description: 'SSE/WebSocket streaming responses to clients.',
    defaultValue: 'true',
  },
  {
    name: 'FEATURE_TOOL_SANDBOXING',
    description: 'Tool execution runs in sandboxed pods (gvisor).',
    defaultValue: 'true',
  },
  {
    name: 'FEATURE_MULTI_AGENT',
    description: 'Multi-agent handoffs and routing.',
    defaultValue: 'true',
  },
  {
    name: 'FEATURE_DEBUG_TRACES',
    description: 'Verbose trace event emission.',
    defaultValue: 'true',
  },
  {
    name: 'FEATURE_ENABLE_MOCK_LLM',
    description: 'Mock LLM provider for benchmarks.',
    defaultValue: 'false',
  },
  {
    name: 'ENABLE_STRICT_PII_MODE',
    description: 'Strict PII handling in tenant config.',
    defaultValue: 'false',
  },
  // ─── Workflow event-sourcing pipeline (ABLP-2, runtime side) ───────────
  {
    name: 'WORKFLOW_CH_SINK_ENABLED',
    description: 'Kafka consumer projects workflow events to ClickHouse.',
    defaultValue: 'false',
  },
  {
    name: 'WORKFLOW_DUAL_READ_ENABLED',
    description: 'Read path unions Mongo + ClickHouse responses.',
    defaultValue: 'false',
  },
  {
    name: 'WORKFLOW_PROXY_SYNC_TIMEOUT_MS',
    description: 'Sync-response timeout for runtime → workflow-engine proxy.',
    defaultValue: '30000',
  },
  {
    name: 'EVENT_KAFKA_BROKERS',
    description: 'Kafka broker list (consumer side; must match producer).',
    defaultValue: 'localhost:9092',
  },
  {
    name: 'WORKFLOW_ENGINE_URL',
    description: 'Workflow engine HTTP base URL (runtime → workflow-engine proxy target).',
    defaultValue: 'http://localhost:9080',
  },
  {
    name: 'WORKFLOW_AUTH_PROFILE_ENABLED',
    description: 'Auth-profile credential resolution for workflow/internal tool execution.',
    defaultValue: 'true',
  },
  // ─── Observability flags (already public, included for completeness) ───
  { name: 'OTEL_ENABLED', description: 'OpenTelemetry traces.', defaultValue: 'false' },
  { name: 'METRICS_ENABLED', description: 'Prometheus metrics endpoint.', defaultValue: 'false' },
  {
    name: 'OBS_STRICT_READINESS_GATES',
    description: 'Strict Mongo readiness check.',
    defaultValue: 'false',
  },
] as const;

export interface FlagSnapshot {
  name: string;
  description: string;
  value: string;
  isDefault: boolean;
}

/** Resolve current values from `env` (defaults to `process.env`). */
export function snapshotFlags(
  catalog: ReadonlyArray<FlagDescriptor>,
  env: NodeJS.ProcessEnv = process.env,
): FlagSnapshot[] {
  return catalog.map((descriptor) => {
    const raw = env[descriptor.name];
    const value = raw ?? '';
    return {
      name: descriptor.name,
      description: descriptor.description,
      value,
      isDefault: raw === undefined || raw === descriptor.defaultValue,
    };
  });
}
