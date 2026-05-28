/**
 * Lightweight trigger-registry re-export.
 *
 * Studio imports this subpath (`@agent-platform/pipeline-engine/triggers`)
 * to avoid pulling in the full engine barrel (which has Restate top-level
 * await and breaks Next.js webpack dev mode).
 */
export {
  listTriggerDefinitions,
  getTriggerDefinition,
  type TriggerDefinition,
} from './pipeline/trigger-registry.js';
