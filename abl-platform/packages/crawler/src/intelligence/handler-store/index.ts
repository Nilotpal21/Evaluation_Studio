/**
 * Handler Store - Page handler persistence by template fingerprint
 *
 * Exports:
 * - Interfaces: IHandlerStore, StoredHandler, SaveHandlerInput
 * - Implementations: MongoHandlerStore
 * - Errors: HandlerStoreError
 */

export {
  // Core interface
  type IHandlerStore,

  // Data types
  type SaveHandlerInput,
  type StoredHandler,

  // Error
  HandlerStoreError,
} from './interfaces.js';

// Handler store implementations
export {
  MongoHandlerStore,
  type HandlerTemplateModel,
  type HandlerTemplateDoc,
} from './mongo-handler-store.js';
