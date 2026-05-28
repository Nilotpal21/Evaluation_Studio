/**
 * Auth providers for agent desktop adapters.
 */
export type { AuthProvider } from './interface.js';
export { InternalKeyAuth } from './internal-key.js';
export { OAuth2ClientAuth } from './oauth2-client.js';
export { JWTAuth } from './jwt.js';
export { BasicAuth } from './basic.js';
export { BearerTokenAuth } from './bearer.js';
export { OIDCAuth } from './oidc.js';
export { SessionHeaderAuth } from './session-header.js';
