/**
 * Shared connector services — barrel export.
 *
 * Used by both Studio and workflow-engine for connection management
 * and connector catalog queries.
 */

export {
  ConnectionService,
  ConnectionServiceError,
  type ConnectionRecord,
  type CreateConnectionInput,
  type UpdateConnectionInput,
  type TestResult,
  type ConnectionModel,
  type ConnectionServiceDeps,
  type AuthProfileResolverLike,
} from './connection-service.js';

export {
  ConnectorListingService,
  type ConnectorSummary,
  type TriggerSummary,
  type ActionSummary,
} from './connector-listing-service.js';

export {
  DropdownOptionsService,
  DropdownOptionsServiceError,
  type DropdownOptionsServiceDeps,
  type DropdownOptionsErrorCode,
  type ResolveActionOptionsInput,
  type ResolveTriggerOptionsInput,
  type ResolveActionDynamicPropsInput,
  type ResolveTriggerDynamicPropsInput,
} from './dropdown-options-service.js';

export {
  createAuthProfileResolver,
  type AuthProfileModelLike,
  type AuthProfileDocument,
  type DecryptFn,
  type AuthProfileResolverFactoryOpts,
} from './auth-profile-resolver-factory.js';
