/**
 * Platform adapters for agent transfer (Kore SmartAssist, etc.).
 */
export type { AgentDesktopAdapter, AdapterCapabilities } from './interface.js';
export { AdapterRegistry } from './registry.js';
export { Five9Adapter } from './five9/index.js';
export {
  type AuthProvider,
  InternalKeyAuth,
  OAuth2ClientAuth,
  JWTAuth,
  BasicAuth,
  BearerTokenAuth,
  OIDCAuth,
  SessionHeaderAuth,
} from './auth/index.js';
