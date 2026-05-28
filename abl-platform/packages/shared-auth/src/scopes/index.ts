export {
  PLATFORM_KEY_SCOPES,
  PLATFORM_KEY_SCOPE_KEYS,
  type ScopeEntry,
  type ScopeCategory,
} from './platform-key-scopes.js';
export {
  checkScopeCeiling,
  expandScopesToPermissions,
  validateRegistryScopes,
  type ScopeCeilingResult,
} from './scope-validation.js';
