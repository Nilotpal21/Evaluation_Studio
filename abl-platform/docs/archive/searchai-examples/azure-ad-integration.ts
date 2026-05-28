/**
 * Azure AD Integration Example using MSAL.js
 *
 * This example shows how to integrate Search-AI with Azure AD authentication
 * using Microsoft Authentication Library (MSAL.js) for browser applications.
 *
 * Prerequisites:
 * - Azure AD app registration configured
 * - MSAL.js 2.x or 3.x installed (`npm install @azure/msal-browser`)
 * - Search-AI API key
 */

import {
  PublicClientApplication,
  type Configuration,
  type AccountInfo,
  type AuthenticationResult,
} from '@azure/msal-browser';

// =============================================================================
// MSAL CONFIGURATION
// =============================================================================

const msalConfig: Configuration = {
  auth: {
    clientId: '<YOUR_AZURE_AD_CLIENT_ID>', // From Azure Portal App Registration
    authority: 'https://login.microsoftonline.com/<YOUR_TENANT_ID>',
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'localStorage', // or 'sessionStorage'
    storeAuthStateInCookie: false,
  },
};

// Initialize MSAL instance
const msalInstance = new PublicClientApplication(msalConfig);

// Initialize MSAL (call once on app startup)
await msalInstance.initialize();

// =============================================================================
// AUTHENTICATION FLOW
// =============================================================================

/**
 * Sign in with Azure AD and get access token
 */
export async function signInWithAzureAD(): Promise<AccountInfo> {
  try {
    const loginResponse: AuthenticationResult = await msalInstance.loginPopup({
      scopes: ['User.Read'], // Basic Microsoft Graph permissions
    });

    msalInstance.setActiveAccount(loginResponse.account);
    return loginResponse.account;
  } catch (error) {
    console.error('Azure AD login failed:', error);
    throw new Error('Failed to sign in with Azure AD');
  }
}

/**
 * Get current user account (if already signed in)
 */
export function getCurrentAccount(): AccountInfo | null {
  return msalInstance.getActiveAccount();
}

/**
 * Acquire access token (with silent renewal)
 */
export async function getAccessToken(): Promise<string> {
  const account = msalInstance.getActiveAccount();

  if (!account) {
    throw new Error('No active account. Please sign in first.');
  }

  try {
    // Try silent token acquisition first (uses refresh token)
    const response = await msalInstance.acquireTokenSilent({
      scopes: ['User.Read'],
      account: account,
    });

    return response.accessToken;
  } catch (error) {
    // Silent acquisition failed, trigger interactive login
    console.warn('Silent token acquisition failed, falling back to popup');

    const response = await msalInstance.acquireTokenPopup({
      scopes: ['User.Read'],
      account: account,
    });

    return response.accessToken;
  }
}

/**
 * Sign out from Azure AD
 */
export async function signOut(): Promise<void> {
  const account = msalInstance.getActiveAccount();

  if (account) {
    await msalInstance.logoutPopup({ account });
  }
}

// =============================================================================
// SEARCH-AI INTEGRATION
// =============================================================================

const SEARCHAI_API_KEY = '<YOUR_SEARCHAI_API_KEY>'; // From Search-AI dashboard
const SEARCHAI_BASE_URL = 'https://api.searchai.example.com';
const SEARCHAI_INDEX_ID = 'idx_abc123'; // Your Search-AI index ID

/**
 * Search with Azure AD user permissions
 */
export async function searchWithPermissions(
  query: string,
  options: {
    queryType?: 'vector' | 'keyword' | 'hybrid';
    topK?: number;
  } = {},
): Promise<any> {
  // Get Azure AD access token
  const azureToken = await getAccessToken();

  // Call Search-AI with user token
  const response = await fetch(`${SEARCHAI_BASE_URL}/api/search/${SEARCHAI_INDEX_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SEARCHAI_API_KEY}`,
      'X-Auth-Mode': 'user', // Enable permission filtering
      'X-End-User-Token': azureToken, // Forward Azure AD token
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
// USAGE EXAMPLE
// =============================================================================

async function exampleUsage() {
  try {
    // Step 1: Sign in with Azure AD
    console.log('Signing in with Azure AD...');
    const account = await signInWithAzureAD();
    console.log('Signed in as:', account.username);

    // Step 2: Search with user permissions
    console.log('Searching with user permissions...');
    const results = await searchWithPermissions('quarterly financial report', {
      queryType: 'hybrid',
      topK: 10,
    });

    console.log('Search results:', results.data.results);
    console.log('Total results:', results.data.totalResults);

    // Step 3: Sign out
    await signOut();
    console.log('Signed out');
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run example (uncomment to test)
// exampleUsage();
