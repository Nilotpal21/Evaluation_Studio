/**
 * React Integration Example with Custom Hooks
 *
 * This example shows how to build React hooks for Search-AI integration
 * with IdP authentication (works with Azure AD, Okta, or Google).
 *
 * Features:
 * - Custom hooks for authentication and search
 * - Automatic token renewal
 * - Error handling and loading states
 * - TypeScript support
 *
 * Prerequisites:
 * - React 18+ with hooks
 * - IdP SDK of choice (MSAL, Okta, Google)
 * - Search-AI API key
 */

import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';

// =============================================================================
// TYPES
// =============================================================================

interface SearchResult {
  id: string;
  score: number;
  content: string;
  metadata: Record<string, any>;
  permissions?: {
    publicEverywhere: boolean;
    allowedUsers: string[];
    allowedGroups: string[];
  };
}

interface SearchResponse {
  success: boolean;
  data?: {
    results: SearchResult[];
    totalResults: number;
    queryId: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

interface SearchOptions {
  queryType?: 'vector' | 'keyword' | 'hybrid';
  topK?: number;
  filters?: Record<string, any>;
  mode?: 'public' | 'user';
}

interface AuthState {
  isAuthenticated: boolean;
  user: any | null;
  accessToken: string | null;
}

// =============================================================================
// SEARCH-AI CONTEXT
// =============================================================================

interface SearchAIConfig {
  apiKey: string;
  baseUrl: string;
  indexId: string;
  getAccessToken?: () => Promise<string | null>; // Optional IdP token getter
}

const SearchAIContext = createContext<SearchAIConfig | null>(null);

export function SearchAIProvider({
  children,
  config,
}: {
  children: React.ReactNode;
  config: SearchAIConfig;
}) {
  return <SearchAIContext.Provider value={config}>{children}</SearchAIContext.Provider>;
}

function useSearchAIConfig(): SearchAIConfig {
  const config = useContext(SearchAIContext);

  if (!config) {
    throw new Error('useSearchAIConfig must be used within SearchAIProvider');
  }

  return config;
}

// =============================================================================
// CUSTOM HOOKS
// =============================================================================

/**
 * Hook for performing Search-AI queries with automatic token handling
 */
export function useSearch() {
  const config = useSearchAIConfig();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const search = useCallback(
    async (query: string, options: SearchOptions = {}) => {
      // Abort any in-flight requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setIsLoading(true);
      setError(null);

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        };

        // Add IdP token if in user mode
        if (options.mode === 'user' && config.getAccessToken) {
          const accessToken = await config.getAccessToken();

          if (!accessToken) {
            throw new Error('User is not authenticated');
          }

          headers['X-Auth-Mode'] = 'user';
          headers['X-End-User-Token'] = accessToken;
        }

        const response = await fetch(`${config.baseUrl}/api/search/${config.indexId}/query`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query,
            queryType: options.queryType || 'hybrid',
            topK: options.topK || 10,
            filters: options.filters,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorData: SearchResponse = await response.json();
          throw new Error(errorData.error?.message || `Search failed: ${response.statusText}`);
        }

        const data: SearchResponse = await response.json();

        if (data.success && data.data) {
          setResults(data.data.results);
          setTotalResults(data.data.totalResults);
          return data.data;
        } else {
          throw new Error(data.error?.message || 'Search failed');
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // Request was aborted, ignore
          return null;
        }

        setError(err.message);
        setResults([]);
        setTotalResults(0);
        throw err;
      } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    },
    [config],
  );

  const reset = useCallback(() => {
    setResults([]);
    setTotalResults(0);
    setError(null);
    setIsLoading(false);
  }, []);

  return {
    search,
    results,
    totalResults,
    isLoading,
    error,
    reset,
  };
}

/**
 * Hook for debounced search (useful for search-as-you-type)
 */
export function useDebouncedSearch(delay = 300) {
  const { search: baseSearch, ...searchState } = useSearch();
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedSearch = useCallback(
    (query: string, options?: SearchOptions) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (!query.trim()) {
        searchState.reset();
        return;
      }

      timeoutRef.current = setTimeout(() => {
        baseSearch(query, options);
      }, delay);
    },
    [baseSearch, searchState, delay],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    search: debouncedSearch,
    ...searchState,
  };
}

// =============================================================================
// EXAMPLE COMPONENTS
// =============================================================================

/**
 * Search Box Component with real-time results
 */
export function SearchBox() {
  const [query, setQuery] = useState('');
  const { search, results, isLoading, error } = useDebouncedSearch(500);

  const handleSearch = useCallback(
    (value: string) => {
      setQuery(value);
      search(value, { queryType: 'hybrid', topK: 10, mode: 'user' });
    },
    [search],
  );

  return (
    <div className="search-box">
      <input
        type="text"
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        placeholder="Search documents..."
        className="search-input"
      />

      {isLoading && <div className="loading-spinner">Searching...</div>}

      {error && <div className="error-message">{error}</div>}

      {results.length > 0 && (
        <div className="search-results">
          {results.map((result) => (
            <div key={result.id} className="search-result">
              <h3>{result.metadata.title || 'Untitled'}</h3>
              <p>{result.content.substring(0, 150)}...</p>
              <div className="result-meta">
                <span>Score: {result.score.toFixed(2)}</span>
                {result.metadata.source && <span>Source: {result.metadata.source}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Search Page with Authentication
 */
export function SearchPage({
  authState,
  onSignIn,
  onSignOut,
}: {
  authState: AuthState;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'public' | 'user'>('public');
  const { search, results, totalResults, isLoading, error } = useSearch();

  const handleSearch = async () => {
    if (!query.trim()) {
      alert('Please enter a search query');
      return;
    }

    try {
      await search(query, {
        queryType: 'hybrid',
        topK: 20,
        mode: searchMode,
      });
    } catch (err) {
      // Error already set in state
      console.error('Search error:', err);
    }
  };

  return (
    <div className="search-page">
      {/* Header */}
      <header>
        <h1>Search-AI Demo</h1>
        {authState.isAuthenticated ? (
          <div className="user-info">
            <span>Signed in as {authState.user?.email}</span>
            <button onClick={onSignOut}>Sign Out</button>
          </div>
        ) : (
          <button onClick={onSignIn}>Sign In</button>
        )}
      </header>

      {/* Search Mode Toggle */}
      <div className="search-mode-toggle">
        <label>
          <input
            type="radio"
            checked={searchMode === 'public'}
            onChange={() => setSearchMode('public')}
          />
          Public Search
        </label>
        <label>
          <input
            type="radio"
            checked={searchMode === 'user'}
            onChange={() => setSearchMode('user')}
            disabled={!authState.isAuthenticated}
          />
          Personalized Search {!authState.isAuthenticated && '(Sign in required)'}
        </label>
      </div>

      {/* Search Input */}
      <div className="search-input-container">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Enter your search query..."
          className="search-input"
        />
        <button onClick={handleSearch} disabled={isLoading}>
          {isLoading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Error Message */}
      {error && <div className="error-banner">{error}</div>}

      {/* Results */}
      {results.length > 0 && (
        <div className="results-container">
          <div className="results-header">
            <h2>
              Found {totalResults} {totalResults === 1 ? 'result' : 'results'}
            </h2>
            <span className="search-mode-badge">Mode: {searchMode}</span>
          </div>

          <div className="results-list">
            {results.map((result) => (
              <article key={result.id} className="result-card">
                <h3>{result.metadata.title || result.metadata.filename || 'Untitled'}</h3>
                <p className="result-content">{result.content}</p>
                <div className="result-metadata">
                  <span className="score">Relevance: {(result.score * 100).toFixed(0)}%</span>
                  {result.metadata.author && <span>Author: {result.metadata.author}</span>}
                  {result.metadata.lastModified && (
                    <span>
                      Modified: {new Date(result.metadata.lastModified).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// APP EXAMPLE WITH AZURE AD
// =============================================================================

/**
 * Example App.tsx using MSAL (Azure AD) with Search-AI
 */
/**
 * ```tsx
 * import { useState, useEffect } from 'react';
 * import { PublicClientApplication } from '@azure/msal-browser';
 * import { SearchAIProvider, SearchPage } from './react-integration';
 *
 * const msalInstance = new PublicClientApplication({
 *   auth: {
 *     clientId: '<AZURE_CLIENT_ID>',
 *     authority: 'https://login.microsoftonline.com/<TENANT_ID>',
 *     redirectUri: window.location.origin,
 *   },
 * });
 *
 * export default function App() {
 *   const [authState, setAuthState] = useState({
 *     isAuthenticated: false,
 *     user: null,
 *     accessToken: null,
 *   });
 *
 *   useEffect(() => {
 *     msalInstance.initialize().then(() => {
 *       const account = msalInstance.getActiveAccount();
 *       if (account) {
 *         setAuthState({
 *           isAuthenticated: true,
 *           user: account,
 *           accessToken: null,
 *         });
 *       }
 *     });
 *   }, []);
 *
 *   const handleSignIn = async () => {
 *     try {
 *       const response = await msalInstance.loginPopup({
 *         scopes: ['User.Read'],
 *       });
 *       setAuthState({
 *         isAuthenticated: true,
 *         user: response.account,
 *         accessToken: response.accessToken,
 *       });
 *     } catch (error) {
 *       console.error('Sign-in failed:', error);
 *     }
 *   };
 *
 *   const handleSignOut = async () => {
 *     await msalInstance.logoutPopup();
 *     setAuthState({ isAuthenticated: false, user: null, accessToken: null });
 *   };
 *
 *   const getAccessToken = async () => {
 *     const account = msalInstance.getActiveAccount();
 *     if (!account) return null;
 *
 *     try {
 *       const response = await msalInstance.acquireTokenSilent({
 *         scopes: ['User.Read'],
 *         account,
 *       });
 *       return response.accessToken;
 *     } catch (error) {
 *       const response = await msalInstance.acquireTokenPopup({
 *         scopes: ['User.Read'],
 *         account,
 *       });
 *       return response.accessToken;
 *     }
 *   };
 *
 *   return (
 *     <SearchAIProvider
 *       config={{
 *         apiKey: '<SEARCHAI_API_KEY>',
 *         baseUrl: 'https://api.searchai.example.com',
 *         indexId: 'idx_abc123',
 *         getAccessToken,
 *       }}
 *     >
 *       <SearchPage
 *         authState={authState}
 *         onSignIn={handleSignIn}
 *         onSignOut={handleSignOut}
 *       />
 *     </SearchAIProvider>
 *   );
 * }
 * ```
 */
