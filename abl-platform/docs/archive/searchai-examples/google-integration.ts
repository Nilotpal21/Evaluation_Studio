/**
 * Google Workspace Integration Example using Google Sign-In
 *
 * This example shows how to integrate Search-AI with Google Workspace authentication
 * using the Google Identity Services library for browser applications.
 *
 * Prerequisites:
 * - Google Cloud project with OAuth 2.0 client configured
 * - Google Identity Services library loaded
 * - Search-AI API key
 *
 * Installation:
 * Add to your HTML <head>:
 * <script src="https://accounts.google.com/gsi/client" async defer></script>
 */

declare global {
  interface Window {
    google: any;
  }
}

// =============================================================================
// GOOGLE SIGN-IN CONFIGURATION
// =============================================================================

const GOOGLE_CLIENT_ID = '<YOUR_GOOGLE_CLIENT_ID>'; // From Google Cloud Console
const GOOGLE_SCOPES = 'openid profile email'; // Required scopes

let tokenClient: any = null;
let currentToken: string | null = null;
let tokenExpiry: number | null = null;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize Google Sign-In
 * Call this once when the page loads
 */
export function initializeGoogleSignIn(): void {
  if (typeof window === 'undefined' || !window.google) {
    throw new Error('Google Identity Services library not loaded');
  }

  // Initialize token client for popup flow
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: (response: any) => {
      if (response.error) {
        console.error('Google Sign-In error:', response.error);
        return;
      }

      // Store token and expiry
      currentToken = response.access_token;
      tokenExpiry = Date.now() + (response.expires_in || 3600) * 1000;

      console.log('Google Sign-In successful');
    },
  });
}

// =============================================================================
// AUTHENTICATION FLOW
// =============================================================================

/**
 * Sign in with Google (popup flow)
 */
export async function signInWithGoogle(): Promise<void> {
  if (!tokenClient) {
    throw new Error('Google Sign-In not initialized. Call initializeGoogleSignIn() first.');
  }

  return new Promise((resolve, reject) => {
    const originalCallback = tokenClient.callback;

    tokenClient.callback = (response: any) => {
      // Restore original callback
      tokenClient.callback = originalCallback;

      if (response.error) {
        reject(new Error(response.error));
        return;
      }

      // Store token
      currentToken = response.access_token;
      tokenExpiry = Date.now() + (response.expires_in || 3600) * 1000;

      resolve();
    };

    // Trigger sign-in popup
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  if (!currentToken || !tokenExpiry) {
    return false;
  }

  // Check if token is expired (with 5-minute buffer)
  return Date.now() < tokenExpiry - 5 * 60 * 1000;
}

/**
 * Get access token (with automatic renewal)
 */
export async function getAccessToken(): Promise<string> {
  // Check if we have a valid cached token
  if (isAuthenticated() && currentToken) {
    return currentToken;
  }

  // Token expired or missing, request new one silently
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error('Google Sign-In not initialized'));
      return;
    }

    const originalCallback = tokenClient.callback;

    tokenClient.callback = (response: any) => {
      tokenClient.callback = originalCallback;

      if (response.error) {
        reject(new Error('Failed to refresh token: ' + response.error));
        return;
      }

      currentToken = response.access_token;
      tokenExpiry = Date.now() + (response.expires_in || 3600) * 1000;

      resolve(response.access_token);
    };

    // Try silent token refresh (no prompt)
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

/**
 * Get current user information from Google
 */
export async function getCurrentUser(): Promise<any> {
  if (!isAuthenticated()) {
    return null;
  }

  try {
    const token = await getAccessToken();

    // Fetch user info from Google UserInfo endpoint
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    return response.json();
  } catch (error) {
    console.error('Failed to get user info:', error);
    return null;
  }
}

/**
 * Sign out from Google
 */
export function signOut(): void {
  if (currentToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(currentToken, () => {
      console.log('Token revoked');
    });
  }

  currentToken = null;
  tokenExpiry = null;
}

// =============================================================================
// SEARCH-AI INTEGRATION
// =============================================================================

const SEARCHAI_API_KEY = '<YOUR_SEARCHAI_API_KEY>'; // From Search-AI dashboard
const SEARCHAI_BASE_URL = 'https://api.searchai.example.com';
const SEARCHAI_INDEX_ID = 'idx_abc123'; // Your Search-AI index ID

/**
 * Search with Google Workspace user permissions
 */
export async function searchWithPermissions(
  query: string,
  options: {
    queryType?: 'vector' | 'keyword' | 'hybrid';
    topK?: number;
    filters?: Record<string, any>;
  } = {},
): Promise<any> {
  if (!isAuthenticated()) {
    throw new Error('User not authenticated. Please sign in first.');
  }

  // Get Google access token
  const googleToken = await getAccessToken();

  // Call Search-AI with user token
  const response = await fetch(`${SEARCHAI_BASE_URL}/api/search/${SEARCHAI_INDEX_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SEARCHAI_API_KEY}`,
      'X-Auth-Mode': 'user', // Enable permission filtering
      'X-End-User-Token': googleToken, // Forward Google access token
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

    // Handle token expiration
    if (response.status === 401) {
      // Try to refresh token and retry
      try {
        await signInWithGoogle();
        return searchWithPermissions(query, options);
      } catch (refreshError) {
        throw new Error('Authentication expired. Please sign in again.');
      }
    }

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
// USAGE EXAMPLE (Vanilla JavaScript)
// =============================================================================

/**
 * Example HTML page with Google Sign-In button
 *
 * ```html
 * <!DOCTYPE html>
 * <html>
 * <head>
 *   <script src="https://accounts.google.com/gsi/client" async defer></script>
 *   <script src="./google-integration.js" type="module"></script>
 * </head>
 * <body>
 *   <div id="app">
 *     <!-- Sign-in UI -->
 *     <div id="sign-in-section">
 *       <h1>Search with Google Workspace</h1>
 *       <button id="sign-in-button">Sign in with Google</button>
 *     </div>
 *
 *     <!-- Search UI (hidden until signed in) -->
 *     <div id="search-section" style="display: none;">
 *       <div id="user-info"></div>
 *       <input type="text" id="search-input" placeholder="Enter search query" />
 *       <button id="search-button">Search</button>
 *       <button id="sign-out-button">Sign Out</button>
 *       <div id="results"></div>
 *     </div>
 *   </div>
 *
 *   <script type="module">
 *     import * as GoogleSearch from './google-integration.js';
 *
 *     // Initialize on page load
 *     window.addEventListener('load', () => {
 *       GoogleSearch.initializeGoogleSignIn();
 *
 *       // Sign in button
 *       document.getElementById('sign-in-button').addEventListener('click', async () => {
 *         try {
 *           await GoogleSearch.signInWithGoogle();
 *
 *           // Get user info
 *           const user = await GoogleSearch.getCurrentUser();
 *           document.getElementById('user-info').textContent = `Signed in as: ${user.email}`;
 *
 *           // Show search UI
 *           document.getElementById('sign-in-section').style.display = 'none';
 *           document.getElementById('search-section').style.display = 'block';
 *         } catch (error) {
 *           alert('Sign-in failed: ' + error.message);
 *         }
 *       });
 *
 *       // Search button
 *       document.getElementById('search-button').addEventListener('click', async () => {
 *         const query = document.getElementById('search-input').value;
 *
 *         if (!query) {
 *           alert('Please enter a search query');
 *           return;
 *         }
 *
 *         try {
 *           const response = await GoogleSearch.searchWithPermissions(query, {
 *             queryType: 'hybrid',
 *             topK: 10,
 *           });
 *
 *           // Display results
 *           const resultsDiv = document.getElementById('results');
 *           resultsDiv.innerHTML = response.data.results
 *             .map(
 *               (result) => `
 *                 <div class="result">
 *                   <h3>${result.metadata.title || 'Untitled'}</h3>
 *                   <p>${result.content.substring(0, 200)}...</p>
 *                   <small>Score: ${result.score.toFixed(2)}</small>
 *                 </div>
 *               `
 *             )
 *             .join('');
 *         } catch (error) {
 *           alert('Search failed: ' + error.message);
 *         }
 *       });
 *
 *       // Sign out button
 *       document.getElementById('sign-out-button').addEventListener('click', () => {
 *         GoogleSearch.signOut();
 *         document.getElementById('sign-in-section').style.display = 'block';
 *         document.getElementById('search-section').style.display = 'none';
 *       });
 *     });
 *   </script>
 * </body>
 * </html>
 * ```
 */

// =============================================================================
// ALTERNATIVE: Server-Side Token Validation
// =============================================================================

/**
 * For server-side rendering or backend APIs, validate Google token on server
 *
 * Backend example (Node.js + Express):
 *
 * ```typescript
 * import { OAuth2Client } from 'google-auth-library';
 *
 * const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
 *
 * async function verifyGoogleToken(token: string) {
 *   const ticket = await googleClient.verifyIdToken({
 *     idToken: token,
 *     audience: GOOGLE_CLIENT_ID,
 *   });
 *
 *   const payload = ticket.getPayload();
 *   return {
 *     email: payload.email,
 *     name: payload.name,
 *     picture: payload.picture,
 *   };
 * }
 *
 * app.post('/api/search-proxy', async (req, res) => {
 *   const { query, googleToken } = req.body;
 *
 *   // Verify token on server
 *   try {
 *     const user = await verifyGoogleToken(googleToken);
 *
 *     // Forward to Search-AI
 *     const searchResponse = await fetch('https://api.searchai.example.com/api/search/idx_abc123/query', {
 *       method: 'POST',
 *       headers: {
 *         'Authorization': `Bearer ${process.env.SEARCHAI_API_KEY}`,
 *         'X-Auth-Mode': 'user',
 *         'X-End-User-Token': googleToken,
 *         'Content-Type': 'application/json',
 *       },
 *       body: JSON.stringify({ query, queryType: 'hybrid', topK: 10 }),
 *     });
 *
 *     const results = await searchResponse.json();
 *     res.json(results);
 *   } catch (error) {
 *     res.status(401).json({ error: 'Invalid Google token' });
 *   }
 * });
 * ```
 */
