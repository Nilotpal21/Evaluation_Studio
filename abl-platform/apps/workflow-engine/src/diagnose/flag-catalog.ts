/**
 * Canonical list of feature flags read by the workflow-engine. Used by the
 * `/diagnose` handler to surface configuration to operators. Adding a new
 * flag? Add it here too — otherwise the diagnose response goes stale.
 */

export interface FlagDescriptor {
  name: string;
  description: string;
  defaultValue: string;
}

export const WORKFLOW_ENGINE_FLAGS: ReadonlyArray<FlagDescriptor> = [
  {
    name: 'WORKFLOW_OUTBOX_ENABLED',
    description:
      'Dual-write domain row + outbox row in one Mongo tx; BullMQ poller drains to Kafka.',
    defaultValue: 'false',
  },
  {
    name: 'WORKFLOW_DUAL_READ_ENABLED',
    description: 'Hybrid read path unions Mongo + ClickHouse responses.',
    defaultValue: 'false',
  },
  {
    name: 'WORKFLOW_MONGO_TTL_ENABLED',
    description: 'TTL partial-filter index reaps terminal rows. Pod restart required on flip.',
    defaultValue: 'false',
  },
  {
    name: 'WORKFLOW_OUTBOX_POLL_INTERVAL_MS',
    description: 'BullMQ poller cadence in milliseconds.',
    defaultValue: '1000',
  },
  {
    name: 'WORKFLOW_OUTBOX_BATCH_SIZE',
    description: 'Outbox rows drained per poller tick.',
    defaultValue: '100',
  },
  {
    name: 'WORKFLOW_OUTBOX_TTL_HOURS',
    description: 'Drained-row retention before cleanup.',
    defaultValue: '72',
  },
  {
    name: 'WORKFLOW_OUTBOX_ALERT_THRESHOLD',
    description: 'Startup warn threshold for unpublished outbox rows.',
    defaultValue: '10000',
  },
  {
    name: 'WORKFLOW_MONGO_TTL_SECONDS',
    description: 'Window after a row turns terminal before TTL deletes it.',
    defaultValue: '1209600',
  },
  {
    name: 'WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED',
    description:
      'Master gate for document-extraction integrations (Docling toggle, Azure DI piece, workflow-docling queue, kvStore + circuit-breaker wiring).',
    defaultValue: 'false',
  },
  {
    name: 'EVENT_KAFKA_BROKERS',
    description: 'Kafka broker list (producer side).',
    defaultValue: 'localhost:9092',
  },
  {
    name: 'WORKFLOW_ENGINE_PUBLIC_URL',
    description: 'Public URL used when building callback URLs for webhook triggers.',
    defaultValue: '',
  },
  {
    name: 'WORKFLOW_LEGACY_CALLBACKS_ENABLED',
    description:
      'Enable legacy unscoped POST /callbacks/:executionId/:stepId path for backward compat with pre-migration in-flight executions. Set to "false" once all relay-race callbacks have drained.',
    defaultValue: 'true',
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
