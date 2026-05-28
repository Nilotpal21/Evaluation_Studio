/**
 * Pipeline Repository
 *
 * MongoDB queries for pipeline definitions and configs.
 * Used by: server.ts EventBus subscription sync.
 */

// ─── Kafka Subscription Map ─────────────────────────────────────────────

/**
 * Builds a Map<tenantId, Set<eventType>> for the EventBus subscription registry.
 *
 * For platform definitions (__platform__), joins with pipeline_configs to
 * include only tenants that explicitly enabled the pipeline.
 * For tenant-owned definitions, includes them directly based on
 * status: 'active' (no PipelineConfig record required).
 *
 * Supports old format (trigger.kafkaTopic), new format
 * (supportedTriggers[].kafkaTopic), and graph pipelines (trigger.kafkaTopic).
 */
export async function findKafkaSubscriptions(): Promise<Map<string, Set<string>>> {
  const { PipelineConfigModel } = await import('@agent-platform/pipeline-engine/schemas');
  const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');

  // Step 1: Get all active definitions with kafka triggers (both old and new format)
  const definitions = await PipelineDefinitionModel.find(
    {
      status: 'active',
      $or: [
        { 'trigger.type': 'kafka', 'trigger.kafkaTopic': /^abl\./ },
        { 'supportedTriggers.type': 'kafka', 'supportedTriggers.kafkaTopic': /^abl\./ },
      ],
    },
    {
      _id: 1,
      tenantId: 1,
      pipelineType: 1,
      'trigger.kafkaTopic': 1,
      'supportedTriggers.id': 1,
      'supportedTriggers.type': 1,
      'supportedTriggers.kafkaTopic': 1,
      defaultTriggerIds: 1,
    },
  ).lean();

  // Build map: pipelineType → Set of kafka topics
  const pipelineTopics = new Map<string, Set<string>>();
  // Build map: pipelineType → Set of trigger IDs (for cross-referencing with activeTriggers)
  const pipelineTriggerIds = new Map<string, Map<string, string>>();

  for (const def of definitions) {
    const pipelineType = def.pipelineType ?? def._id;
    const topics = new Set<string>();
    const triggerIdToTopic = new Map<string, string>();

    // New format: supportedTriggers
    if (def.supportedTriggers && def.supportedTriggers.length > 0) {
      for (const trigger of def.supportedTriggers) {
        if (trigger.type === 'kafka' && trigger.kafkaTopic) {
          triggerIdToTopic.set(trigger.id, trigger.kafkaTopic);
        }
      }
      // Default triggers determine which topics are active when config has no activeTriggers
      const defaultIds = def.defaultTriggerIds ?? [];
      for (const id of defaultIds) {
        const topic = triggerIdToTopic.get(id);
        if (topic) topics.add(topic);
      }
    }

    // Old format fallback
    if (topics.size === 0 && def.trigger?.kafkaTopic) {
      topics.add(def.trigger.kafkaTopic);
    }

    if (topics.size > 0) {
      pipelineTopics.set(pipelineType, topics);
    }
    if (triggerIdToTopic.size > 0) {
      pipelineTriggerIds.set(pipelineType, triggerIdToTopic);
    }
  }

  if (pipelineTopics.size === 0) return new Map();

  // Step 2: Get all enabled pipeline configs
  const enabledConfigs = await PipelineConfigModel.find(
    { enabled: true },
    { tenantId: 1, pipelineType: 1, activeTriggers: 1 },
  ).lean();

  const result = new Map<string, Set<string>>();

  for (const config of enabledConfigs) {
    const pType = config.pipelineType;
    const tenantId = config.tenantId;
    let topics: Set<string>;

    // If config has activeTriggers, resolve which topics they map to
    const triggerIdMap = pipelineTriggerIds.get(pType);
    if (config.activeTriggers && config.activeTriggers.length > 0 && triggerIdMap) {
      topics = new Set<string>();
      for (const triggerId of config.activeTriggers) {
        const topic = triggerIdMap.get(triggerId);
        if (topic) topics.add(topic);
      }
    } else {
      // Fall back to default topics for this pipeline
      topics = pipelineTopics.get(pType) ?? new Set();
    }

    if (topics.size === 0) continue;

    // Convert topics to event types (strip 'abl.' prefix)
    if (!result.has(tenantId)) {
      result.set(tenantId, new Set());
    }
    const tenantSubs = result.get(tenantId)!;
    for (const topic of topics) {
      tenantSubs.add(topic.replace(/^abl\./, ''));
    }
  }

  // Step 3: Include tenant-owned pipelines with direct kafka triggers.
  // These don't need a PipelineConfig — they are self-managed via status: 'active'.
  // Platform definitions (__platform__) still require a config per tenant.
  for (const def of definitions) {
    const tenantId = def.tenantId;
    if (!tenantId || tenantId === '__platform__') continue;

    const pipelineType = def.pipelineType ?? def._id;
    const topics = pipelineTopics.get(pipelineType);
    if (!topics || topics.size === 0) continue;

    if (!result.has(tenantId)) {
      result.set(tenantId, new Set());
    }
    const tenantSubs = result.get(tenantId)!;
    for (const topic of topics) {
      tenantSubs.add(topic.replace(/^abl\./, ''));
    }
  }

  return result;
}
