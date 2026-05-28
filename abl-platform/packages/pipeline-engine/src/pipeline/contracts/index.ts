export type { TriggerContract, TriggerType, TriggerCategory } from './trigger-contract.js';
export { isValidTriggerContract } from './trigger-contract.js';

export type { NodeContract, SideEffectClass } from './node-contract.js';
export { isValidNodeContract } from './node-contract.js';

export type { DestinationContract, DestinationId, TableFormat } from './destination-contract.js';
export {
  CUSTOM_PIPELINE_RESULTS_COLLECTION,
  CUSTOM_PIPELINE_RESULTS_TABLE,
  DESTINATION_REGISTRY,
  isDestinationId,
} from './destination-contract.js';

export type { NodeEnrichment } from './node-contract-data.js';
export { NODE_ENRICHMENT } from './node-contract-data.js';

export { ContractRegistry } from './registry.js';

export type {
  MongoCollectionDescriptor,
  ClickHouseTableDescriptor,
} from './mongo-query-contract.js';
export {
  ALLOWED_MONGO_COLLECTIONS,
  ALLOWED_MONGO_COLLECTION_NAMES,
  FORBIDDEN_MONGO_OPERATORS,
  ALLOWED_CLICKHOUSE_TABLES,
  ALLOWED_CLICKHOUSE_TABLE_NAMES,
} from './mongo-query-contract.js';
