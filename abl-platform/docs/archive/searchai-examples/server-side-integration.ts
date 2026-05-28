/**
 * Server-Side Integration Example (Backend Proxy Pattern)
 *
 * This example shows how to build a backend API proxy for Search-AI
 * that handles IdP token validation and forwarding.
 *
 * Use cases:
 * - Hide Search-AI API key from client applications
 * - Add additional authorization logic
 * - Audit and log search queries
 * - Rate limiting per user
 *
 * Prerequisites:
 * - Node.js with Express
 * - IdP SDK for token validation (optional)
 * - Search-AI API key (stored in environment)
 */

import express, { type Request, type Response, type NextFunction } from 'express';

// =============================================================================
// CONFIGURATION
// =============================================================================

const SEARCHAI_API_KEY = process.env.SEARCHAI_API_KEY!;
const SEARCHAI_BASE_URL = process.env.SEARCHAI_BASE_URL || 'https://api.searchai.example.com';

if (!SEARCHAI_API_KEY) {
  throw new Error('SEARCHAI_API_KEY environment variable is required');
}

// =============================================================================
// EXPRESS APP SETUP
// =============================================================================

const app = express();

app.use(express.json());

// CORS configuration (adjust for your needs)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================

interface AuthenticatedRequest extends Request {
  user?: {
    email: string;
    name?: string;
    idpToken: string;
  };
}

/**
 * Extract user token from request headers
 * Supports multiple header formats
 */
function getUserToken(req: Request): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check custom X-User-Token header
  const customHeader = req.headers['x-user-token'] as string;
  if (customHeader) {
    return customHeader;
  }

  return null;
}

/**
 * Optional: Validate IdP token on server side
 * This is recommended for production use
 */
async function validateIdPToken(token: string): Promise<{ email: string; name?: string } | null> {
  // Example: Validate Azure AD token using MSAL Node
  // import { ConfidentialClientApplication } from '@azure/msal-node';
  //
  // const msalClient = new ConfidentialClientApplication({
  //   auth: {
  //     clientId: process.env.AZURE_CLIENT_ID!,
  //     clientSecret: process.env.AZURE_CLIENT_SECRET!,
  //     authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
  //   },
  // });
  //
  // try {
  //   const result = await msalClient.acquireTokenOnBehalfOf({
  //     oboAssertion: token,
  //     scopes: ['User.Read'],
  //   });
  //   return { email: result.account.username, name: result.account.name };
  // } catch (error) {
  //   return null;
  // }

  // For this example, we'll trust the token and let Search-AI validate it
  // In production, you should validate the token here
  return { email: 'unknown@example.com' };
}

/**
 * Authentication middleware
 * Extracts and optionally validates IdP token
 */
async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = getUserToken(req);

  if (!token) {
    // No token provided - will use public mode
    return next();
  }

  // Optional: Validate token on server side
  const user = await validateIdPToken(token);

  if (!user) {
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired authentication token',
      },
    });
    return;
  }

  // Attach user info to request
  req.user = {
    email: user.email,
    name: user.name,
    idpToken: token,
  };

  next();
}

// =============================================================================
// RATE LIMITING (Optional)
// =============================================================================

const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(maxRequests = 100, windowMs = 60000) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const key = req.user?.email || req.ip;
    const now = Date.now();

    let record = requestCounts.get(key);

    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      requestCounts.set(key, record);
    }

    record.count++;

    if (record.count > maxRequests) {
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Try again in ${Math.ceil((record.resetAt - now) / 1000)}s`,
        },
      });
      return;
    }

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', (maxRequests - record.count).toString());
    res.setHeader('X-RateLimit-Reset', record.resetAt.toString());

    next();
  };
}

// =============================================================================
// AUDIT LOGGING (Optional)
// =============================================================================

interface SearchLog {
  timestamp: string;
  user: string | null;
  query: string;
  mode: 'public' | 'user';
  resultCount: number;
  latency: number;
}

const searchLogs: SearchLog[] = [];

function logSearch(log: SearchLog) {
  searchLogs.push(log);

  // Keep only last 1000 logs
  if (searchLogs.length > 1000) {
    searchLogs.shift();
  }

  // In production, write to database or logging service
  console.log('[SEARCH_AUDIT]', JSON.stringify(log));
}

// =============================================================================
// SEARCH API ROUTES
// =============================================================================

/**
 * POST /api/search/proxy
 *
 * Proxy search requests to Search-AI with user token forwarding
 */
app.post(
  '/api/search/proxy',
  authenticate,
  rateLimit(100, 60000),
  async (req: AuthenticatedRequest, res: Response) => {
    const startTime = Date.now();

    try {
      const { query, queryType = 'hybrid', topK = 10, indexId, filters } = req.body;

      if (!query) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_QUERY',
            message: 'Query parameter is required',
          },
        });
        return;
      }

      if (!indexId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INDEX_ID',
            message: 'Index ID parameter is required',
          },
        });
        return;
      }

      // Build request headers
      const headers: Record<string, string> = {
        Authorization: `Bearer ${SEARCHAI_API_KEY}`,
        'Content-Type': 'application/json',
      };

      // Add user token if authenticated (enables permission filtering)
      const searchMode = req.user ? 'user' : 'public';

      if (req.user) {
        headers['X-Auth-Mode'] = 'user';
        headers['X-End-User-Token'] = req.user.idpToken;
      }

      // Forward request to Search-AI
      const searchResponse = await fetch(`${SEARCHAI_BASE_URL}/api/search/${indexId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          queryType,
          topK,
          filters,
        }),
      });

      const result = await searchResponse.json();

      // Log search for audit trail
      logSearch({
        timestamp: new Date().toISOString(),
        user: req.user?.email || null,
        query,
        mode: searchMode,
        resultCount: result.data?.results?.length || 0,
        latency: Date.now() - startTime,
      });

      // Return Search-AI response to client
      res.status(searchResponse.status).json(result);
    } catch (error) {
      console.error('Search proxy error:', error);

      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      });
    }
  },
);

/**
 * GET /api/search/audit
 *
 * Get recent search logs (admin only)
 */
app.get('/api/search/audit', (req: Request, res: Response) => {
  // In production, add proper authentication/authorization
  const adminKey = req.headers['x-admin-key'];

  if (adminKey !== process.env.ADMIN_KEY) {
    res.status(403).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Admin access required',
      },
    });
    return;
  }

  res.json({
    success: true,
    data: {
      logs: searchLogs,
      total: searchLogs.length,
    },
  });
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Search-AI proxy server running on port ${PORT}`);
  console.log(`Search endpoint: http://localhost:${PORT}/api/search/proxy`);
  console.log(`Audit endpoint: http://localhost:${PORT}/api/search/audit`);
});

// =============================================================================
// CLIENT USAGE EXAMPLE
// =============================================================================

/**
 * Example client code using the proxy server:
 *
 * ```typescript
 * // Frontend code (React, Vue, etc.)
 * async function searchWithProxy(query: string, userToken?: string) {
 *   const headers: Record<string, string> = {
 *     'Content-Type': 'application/json',
 *   };
 *
 *   // Include user token if available
 *   if (userToken) {
 *     headers['X-User-Token'] = userToken;
 *   }
 *
 *   const response = await fetch('http://localhost:3000/api/search/proxy', {
 *     method: 'POST',
 *     headers,
 *     body: JSON.stringify({
 *       query,
 *       queryType: 'hybrid',
 *       topK: 10,
 *       indexId: 'idx_abc123',
 *     }),
 *   });
 *
 *   return response.json();
 * }
 *
 * // Usage with Azure AD
 * import { getAccessToken } from './azure-ad-integration';
 *
 * const token = await getAccessToken();
 * const results = await searchWithProxy('quarterly report', token);
 * ```
 */

/**
 * Example Docker deployment:
 *
 * ```dockerfile
 * FROM node:18-alpine
 *
 * WORKDIR /app
 *
 * COPY package*.json ./
 * RUN npm ci --only=production
 *
 * COPY . .
 *
 * EXPOSE 3000
 *
 * CMD ["node", "server-side-integration.js"]
 * ```
 *
 * ```bash
 * docker build -t searchai-proxy .
 * docker run -p 3000:3000 \
 *   -e SEARCHAI_API_KEY="abl_sk_..." \
 *   -e SEARCHAI_BASE_URL="https://api.searchai.example.com" \
 *   -e ALLOWED_ORIGIN="https://myapp.example.com" \
 *   searchai-proxy
 * ```
 */
