/**
 * Okta Integration Example using Okta Auth SDK
 *
 * This example shows how to integrate Search-AI with Okta authentication
 * using the Okta Auth JavaScript SDK for browser applications.
 *
 * Prerequisites:
 * - Okta application configured (SPA or Web)
 * - Okta Auth SDK installed (`npm install @okta/okta-auth-js`)
 * - Search-AI API key
 */

import {
  OktaAuth,
  type OktaAuthOptions,
  type TokenResponse,
  type UserClaims,
} from '@okta/okta-auth-js';

// =============================================================================
// OKTA CONFIGURATION
// =============================================================================

const oktaConfig: OktaAuthOptions = {
  issuer: 'https://<YOUR_OKTA_DOMAIN>/oauth2/default', // e.g., https://dev-123456.okta.com/oauth2/default
  clientId: '<YOUR_OKTA_CLIENT_ID>', // From Okta application settings
  redirectUri: window.location.origin + '/callback',
  scopes: ['openid', 'profile', 'email'],
  pkce: true, // Use PKCE for browser apps (recommended)
};

// Initialize Okta Auth instance
const oktaAuth = new OktaAuth(oktaConfig);

// =============================================================================
// AUTHENTICATION FLOW
// =============================================================================

/**
 * Sign in with Okta (redirect flow)
 */
export function signInWithOkta(): void {
  oktaAuth.signInWithRedirect();
}

/**
 * Handle callback after Okta redirect
 * Call this on your /callback route
 */
export async function handleOktaCallback(): Promise<void> {
  try {
    await oktaAuth.handleLoginRedirect();
  } catch (error) {
    console.error('Okta callback handling failed:', error);
    throw new Error('Failed to complete Okta authentication');
  }
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  return oktaAuth.isAuthenticated();
}

/**
 * Get current user information
 */
export async function getCurrentUser(): Promise<UserClaims | null> {
  const isAuth = await oktaAuth.isAuthenticated();

  if (!isAuth) {
    return null;
  }

  try {
    const user = await oktaAuth.getUser();
    return user;
  } catch (error) {
    console.error('Failed to get user info:', error);
    return null;
  }
}

/**
 * Get access token (with automatic renewal)
 */
export async function getAccessToken(): Promise<string> {
  const tokenManager = oktaAuth.tokenManager;

  try {
    // Get token from token manager (handles renewal automatically)
    const accessToken = await tokenManager.get('accessToken');

    if (!accessToken) {
      throw new Error('No access token available');
    }

    // Check if token is expired or will expire soon (within 5 minutes)
    const expiresAt = accessToken.expiresAt || 0;
    const now = Math.floor(Date.now() / 1000);
    const bufferTime = 300; // 5 minutes

    if (expiresAt - now < bufferTime) {
      // Token expired or expiring soon, renew it
      const renewed = await tokenManager.renew('accessToken');
      return renewed.accessToken;
    }

    return accessToken.accessToken;
  } catch (error) {
    console.error('Failed to get access token:', error);
    throw new Error('Authentication required. Please sign in again.');
  }
}

/**
 * Sign out from Okta
 */
export async function signOut(): Promise<void> {
  await oktaAuth.signOut();
}

// =============================================================================
// SEARCH-AI INTEGRATION
// =============================================================================

const SEARCHAI_API_KEY = '<YOUR_SEARCHAI_API_KEY>'; // From Search-AI dashboard
const SEARCHAI_BASE_URL = 'https://api.searchai.example.com';
const SEARCHAI_INDEX_ID = 'idx_abc123'; // Your Search-AI index ID

/**
 * Search with Okta user permissions
 */
export async function searchWithPermissions(
  query: string,
  options: {
    queryType?: 'vector' | 'keyword' | 'hybrid';
    topK?: number;
    filters?: Record<string, any>;
  } = {},
): Promise<any> {
  // Ensure user is authenticated
  const isAuth = await isAuthenticated();

  if (!isAuth) {
    throw new Error('User not authenticated. Please sign in first.');
  }

  // Get Okta access token
  const oktaToken = await getAccessToken();

  // Call Search-AI with user token
  const response = await fetch(`${SEARCHAI_BASE_URL}/api/search/${SEARCHAI_INDEX_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SEARCHAI_API_KEY}`,
      'X-Auth-Mode': 'user', // Enable permission filtering
      'X-End-User-Token': oktaToken, // Forward Okta access token
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      queryType: options.queryType || 'hybrid',
      topK: options.topK || 10,
      filters: options.filters,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Search failed: ${error.error?.message || response.statusText}`);
  }

  return response.json();
}

/**
 * Search in public mode (no permission filtering)
 */
export async function searchPublic(
  query: string,
  options: {
    queryType?: 'vector' | 'keyword' | 'hybrid';
    topK?: number;
  } = {},
): Promise<any> {
  const response = await fetch(`${SEARCHAI_BASE_URL}/api/search/${SEARCHAI_INDEX_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SEARCHAI_API_KEY}`,
      // No X-Auth-Mode header = defaults to public mode
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      queryType: options.queryType || 'hybrid',
      topK: options.topK || 10,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Search failed: ${error.error?.message || response.statusText}`);
  }

  return response.json();
}

// =============================================================================
// TOKEN REFRESH MONITORING
// =============================================================================

/**
 * Set up automatic token renewal
 * Call this once during app initialization
 */
export function setupTokenRenewal(): void {
  oktaAuth.tokenManager.on('renewed', (key, newToken, oldToken) => {
    console.log('Token renewed:', key);
  });

  oktaAuth.tokenManager.on('error', (error) => {
    console.error('Token manager error:', error);
    // Redirect to login if refresh fails
    if (error.errorCode === 'login_required') {
      signInWithOkta();
    }
  });

  oktaAuth.tokenManager.on('expired', (key) => {
    console.warn('Token expired:', key);
    // Token manager will attempt automatic renewal
  });
}

// =============================================================================
// USAGE EXAMPLE (React)
// =============================================================================

// Example: React component with Okta authentication
/**
 * ```tsx
 * import { useEffect, useState } from 'react';
 * import * as OktaSearch from './okta-integration';
 *
 * function SearchPage() {
 *   const [isLoading, setIsLoading] = useState(true);
 *   const [isAuthenticated, setIsAuthenticated] = useState(false);
 *   const [searchQuery, setSearchQuery] = useState('');
 *   const [results, setResults] = useState([]);
 *
 *   useEffect(() => {
 *     // Check authentication status
 *     OktaSearch.isAuthenticated().then(setIsAuthenticated);
 *
 *     // Handle OAuth callback if on /callback route
 *     if (window.location.pathname === '/callback') {
 *       OktaSearch.handleOktaCallback().then(() => {
 *         window.location.href = '/'; // Redirect to home after callback
 *       });
 *     }
 *
 *     // Set up token renewal
 *     OktaSearch.setupTokenRenewal();
 *
 *     setIsLoading(false);
 *   }, []);
 *
 *   const handleSignIn = () => {
 *     OktaSearch.signInWithOkta();
 *   };
 *
 *   const handleSearch = async () => {
 *     try {
 *       const response = await OktaSearch.searchWithPermissions(searchQuery, {
 *         queryType: 'hybrid',
 *         topK: 20,
 *       });
 *
 *       setResults(response.data.results);
 *     } catch (error) {
 *       console.error('Search failed:', error);
 *       alert('Search failed. Please try again.');
 *     }
 *   };
 *
 *   if (isLoading) {
 *     return <div>Loading...</div>;
 *   }
 *
 *   if (!isAuthenticated) {
 *     return (
 *       <div>
 *         <h1>Please sign in to search</h1>
 *         <button onClick={handleSignIn}>Sign in with Okta</button>
 *       </div>
 *     );
 *   }
 *
 *   return (
 *     <div>
 *       <input
 *         type="text"
 *         value={searchQuery}
 *         onChange={(e) => setSearchQuery(e.target.value)}
 *         placeholder="Search..."
 *       />
 *       <button onClick={handleSearch}>Search</button>
 *
 *       <div>
 *         {results.map((result) => (
 *           <div key={result.id}>
 *             <h3>{result.metadata.title}</h3>
 *             <p>{result.content}</p>
 *             <small>Score: {result.score.toFixed(2)}</small>
 *           </div>
 *         ))}
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */

// =============================================================================
// ADVANCED: Custom Token Caching
// =============================================================================

/**
 * Optional: Implement custom token storage for better performance
 */
export class TokenCache {
  private static readonly TOKEN_KEY = 'searchai_okta_token';
  private static readonly EXPIRY_KEY = 'searchai_okta_token_expiry';

  static get(): string | null {
    const token = localStorage.getItem(this.TOKEN_KEY);
    const expiry = localStorage.getItem(this.EXPIRY_KEY);

    if (!token || !expiry) {
      return null;
    }

    // Check if token is expired
    if (Date.now() >= parseInt(expiry, 10)) {
      this.clear();
      return null;
    }

    return token;
  }

  static set(token: string, expiresIn: number): void {
    const expiryTime = Date.now() + expiresIn * 1000 - 60000; // Subtract 1 minute buffer
    localStorage.setItem(this.TOKEN_KEY, token);
    localStorage.setItem(this.EXPIRY_KEY, expiryTime.toString());
  }

  static clear(): void {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.EXPIRY_KEY);
  }
}

/**
 * Get access token with custom caching
 */
export async function getAccessTokenCached(): Promise<string> {
  // Check cache first
  const cachedToken = TokenCache.get();

  if (cachedToken) {
    return cachedToken;
  }

  // Fetch new token
  const token = await getAccessToken();

  // Cache it (assuming 1-hour expiry)
  TokenCache.set(token, 3600);

  return token;
}
